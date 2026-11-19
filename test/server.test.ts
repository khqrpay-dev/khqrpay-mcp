// The server through a real MCP client, in memory, with KHQRPay's API replaced by a recorder.
import { createHmac } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer, type ServerOptions } from "../src/server.js";

const TEST_KEY = `kp_test_${"a".repeat(32)}`;
const LIVE_KEY = `kp_live_${"b".repeat(32)}`;
const SECRET = `whsec_${"Ab-_".repeat(8)}`;

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

function recorder(reply: (call: Call) => { status: number; body: unknown; headers?: Record<string, string> } = () => ({ status: 200, body: { id: "pay_1", status: "pending" } })) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call = { method: init.method ?? "GET", url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const r = reply(call);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function connect(options: ServerOptions) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer(options);
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { error: r.isError === true, text: (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n") };
  };
  return { client, call };
}

describe("the tools", () => {
  it("are the six, each saying whether it only reads", async () => {
    const { client } = await connect({ secretKey: TEST_KEY });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["check_webhook_signature", "create_test_payment", "get_payment", "get_usage", "list_payments", "simulate_test_payment"]);
    const readOnly = Object.fromEntries(tools.map((t) => [t.name, t.annotations?.readOnlyHint]));
    expect(readOnly).toMatchObject({ create_test_payment: false, simulate_test_payment: false, get_payment: true, list_payments: true, get_usage: true, check_webhook_signature: true });
    // The read tools steer a model away from polling.
    for (const t of tools.filter((t) => ["get_payment", "list_payments"].includes(t.name))) expect(t.description).toMatch(/never poll/);
  });
});

describe("with a test key", () => {
  it("creates a test payment with a fresh Idempotency-Key, the key as a bearer token and nothing else of the key anywhere", async () => {
    const { calls, fetchImpl } = recorder(() => ({ status: 201, body: { id: "pay_1", amount: "1.00", currency: "USD", checkout_url: "https://khqrpay.dev/pay/pay_1", expires_at: "2026-11-16T07:00:00.000Z" } }));
    const { call } = await connect({ secretKey: TEST_KEY, fetch: fetchImpl });
    const first = await call("create_test_payment", { amount: "1.00", reference_id: "INV-1" });
    await call("create_test_payment", { amount: "1.00", reference_id: "INV-1" });
    expect(first.error).toBe(false);
    expect(first.text).toContain("https://khqrpay.dev/pay/pay_1");
    expect(first.text).not.toContain(TEST_KEY);
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://khqrpay.dev/v1/payments", body: { amount: "1.00", currency: "USD", reference_id: "INV-1" } });
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(calls[0].headers["Idempotency-Key"]).toMatch(/^mcp-[0-9a-f-]{36}$/);
    expect(calls[1].headers["Idempotency-Key"]).not.toBe(calls[0].headers["Idempotency-Key"]);
  });

  it("simulates, reads, lists and shows usage at the API's own paths", async () => {
    const { calls, fetchImpl } = recorder((c) => ({ status: 200, body: c.url.endsWith("/usage") ? { plan: "free", used: 3, limit: 100, remaining: 97 } : c.url.includes("?") ? { object: "list", data: [], has_more: false } : { id: "pay_1", status: "paid", livemode: false } }));
    const { call } = await connect({ secretKey: TEST_KEY, fetch: fetchImpl });
    expect((await call("simulate_test_payment", { id: "pay_1", status: "paid" })).text).toContain("is now paid");
    expect((await call("get_payment", { id: "pay_1" })).text).toContain("(test) is paid");
    expect((await call("list_payments", { status: "paid", limit: 3 })).error).toBe(false);
    expect((await call("get_usage")).text).toContain("3 of 100");
    expect(calls.map((c) => `${c.method} ${c.url.replace("https://khqrpay.dev", "")}`)).toEqual([
      "POST /v1/test/payments/pay_1/simulate",
      "GET /v1/payments/pay_1",
      "GET /v1/payments?limit=3&status=paid",
      "GET /v1/usage",
    ]);
    expect(calls[0].body).toEqual({ status: "paid" });
  });

  it("passes on the API's error code, and says to stop on a day-long limit", async () => {
    const { fetchImpl } = recorder((c) => (c.url.endsWith("/usage")
      ? { status: 429, body: { error: "rate_limited", message: "Reads for the day are used up." }, headers: { "retry-after": "3600" } }
      : { status: 400, body: { error: "invalid_amount", message: "Amount must be a number like 4.50" } }));
    const { call } = await connect({ secretKey: TEST_KEY, fetch: fetchImpl });
    const bad = await call("create_test_payment", { amount: "abc" });
    expect(bad).toMatchObject({ error: true });
    expect(bad.text).toContain("400 invalid_amount: Amount must be a number like 4.50");
    const limited = await call("get_usage");
    expect(limited.error).toBe(true);
    expect(limited.text).toMatch(/day-long limit, so stop/);
  });
});

describe("with a live key", () => {
  it("never creates or simulates, and calls nothing", async () => {
    const { calls, fetchImpl } = recorder();
    const { call } = await connect({ secretKey: LIVE_KEY, allowLiveReads: true, fetch: fetchImpl });
    for (const [name, args] of [["create_test_payment", { amount: "1.00" }], ["simulate_test_payment", { id: "pay_1", status: "paid" }]] as const) {
      const r = await call(name, args);
      expect(r.error, name).toBe(true);
      expect(r.text).toMatch(/never creates or changes live payments/);
    }
    expect(calls).toHaveLength(0);
  });

  it("reads only when KHQRPAY_MCP_LIVE_READS=1 was set", async () => {
    const refused = recorder();
    const off = await connect({ secretKey: LIVE_KEY, fetch: refused.fetchImpl });
    for (const name of ["get_payment", "list_payments", "get_usage"]) {
      const r = await off.call(name, name === "get_payment" ? { id: "pay_1" } : {});
      expect(r.error, name).toBe(true);
      expect(r.text).toMatch(/KHQRPAY_MCP_LIVE_READS=1/);
    }
    expect(refused.calls).toHaveLength(0);
    const allowed = recorder(() => ({ status: 200, body: { id: "pay_1", status: "paid", livemode: true } }));
    const on = await connect({ secretKey: LIVE_KEY, allowLiveReads: true, fetch: allowed.fetchImpl });
    expect((await on.call("get_payment", { id: "pay_1" })).text).toContain("(live) is paid");
  });
});

describe("without a usable key or address", () => {
  it("explains the setup and calls nothing", async () => {
    const { calls, fetchImpl } = recorder();
    for (const [options, words] of [
      [{}, "isn't set"],
      [{ secretKey: "sk_test_123" }, "doesn't look like a KHQRPay key"],
      [{ secretKey: TEST_KEY, apiBase: "http://example.com" }, "must be an https address"],
    ] as const) {
      const { call } = await connect({ ...options, fetch: fetchImpl });
      const r = await call("get_usage");
      expect(r.error).toBe(true);
      expect(r.text).toContain(words);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("check_webhook_signature", () => {
  const body = '{"id":"evt_1","type":"payment.completed","livemode":true}';
  const now = 1_800_000_000;
  const sign = (t: number, secret = SECRET, raw = body) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;

  it("accepts a good signature and says why a bad one fails, without ever showing the secret or the right signature", async () => {
    const { call } = await connect({ secretKey: TEST_KEY, webhookSecret: SECRET, now: () => now });
    expect((await call("check_webhook_signature", { raw_body: body, signature_header: sign(now - 30) })).text).toMatch(/^Valid: signed 30 seconds ago/);
    const cases: [string, string, RegExp][] = [
      [body.replace("true", "false"), sign(now), /doesn't match/],
      [body, sign(now - 400), /400 seconds old/],
      [body, sign(now + 400), /in the future/],
      [body, "garbage", /isn't in the form/],
      [body, sign(now, "whsec_other"), /doesn't match/],
    ];
    for (const [raw, header, why] of cases) {
      const r = await call("check_webhook_signature", { raw_body: raw, signature_header: header });
      expect(r.text).toMatch(/^Not valid\./);
      expect(r.text).toMatch(why);
      expect(r.text).not.toContain(SECRET);
      expect(r.text).not.toContain(sign(now).slice(-64));
    }
  });

  it("refuses everything when no secret is set, even a header signed with an empty key", async () => {
    for (const webhookSecret of [undefined, ""]) {
      const { call } = await connect({ secretKey: TEST_KEY, webhookSecret, now: () => now });
      const r = await call("check_webhook_signature", { raw_body: body, signature_header: sign(now, "") });
      expect(r.text).toMatch(/^Not valid\. KHQRPAY_WEBHOOK_SECRET isn't set/);
    }
  });
});
