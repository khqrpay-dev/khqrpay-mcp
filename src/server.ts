import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type ApiResult, KhqrPayApi } from "./api.js";
import { checkSignature } from "./signature.js";

export const VERSION = "0.1.0";
const DEFAULT_BASE = "https://khqrpay.dev";

export type ServerOptions = {
  /** The KHQRPay secret key: kp_test_… for everything, or kp_live_… for reads only, and only with allowLiveReads. */
  secretKey?: string;
  /** The webhook endpoint's signing secret (whsec_…), for check_webhook_signature only. */
  webhookSecret?: string;
  /** With a kp_live_ key, allow the read tools (get_payment, list_payments, get_usage). Creating and simulating never take a live key. */
  allowLiveReads?: boolean;
  /** Another KHQRPay address, for testing: https, or http on localhost. */
  apiBase?: string;
  fetch?: typeof fetch;
  /** The clock, in seconds, for check_webhook_signature. */
  now?: () => number;
};

type Mode = "test" | "live";
const KEY = /^kp_(test|live)_[A-Za-z0-9_-]{16,128}$/;

const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] });
const fail = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }], isError: true });
const json = (summary: string, value: unknown): CallToolResult => text(`${summary}\n${JSON.stringify(value, null, 2)}`);

/** An API error as the model should read it: the code to act on, the message, and whether to wait or stop. */
function apiError(r: Extract<ApiResult, { ok: false }>): CallToolResult {
  let advice = "";
  if (r.status === 429 && r.retryAfter) {
    advice = r.retryAfter > 60
      ? ` Retry-After is ${r.retryAfter} seconds: that's a day-long limit, so stop and tell the user instead of retrying.`
      : ` Wait ${r.retryAfter} seconds before trying again, and don't retry in a loop.`;
  }
  return fail(`KHQRPay answered ${r.status || "nothing"} ${r.error}: ${r.message}${advice}`);
}

export function createServer(options: ServerOptions = {}): McpServer {
  const key = options.secretKey?.trim();
  const match = key ? KEY.exec(key) : null;
  const mode: Mode | null = match ? (match[1] as Mode) : null;
  const base = (options.apiBase?.trim() || DEFAULT_BASE).replace(/\/+$/, "");
  const baseOk = /^https:\/\//.test(base) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base);
  const api = mode && baseOk ? new KhqrPayApi(key!, base, options.fetch ?? fetch, `khqrpay-mcp/${VERSION}`) : null;
  const now = options.now ?? (() => Date.now() / 1000);

  /** The API, if this server's key may do this kind of thing; otherwise why not, in words for the user. */
  function gate(kind: "write" | "read"): { api: KhqrPayApi } | { result: CallToolResult } {
    if (!key) return { result: fail("KHQRPAY_SECRET_KEY isn't set for this server. Create a test key (kp_test_…) under API keys in the KHQRPay dashboard and put it in the server's environment.") };
    if (!mode) return { result: fail("KHQRPAY_SECRET_KEY doesn't look like a KHQRPay key. It starts with kp_test_ (or kp_live_) and comes from the dashboard's API keys page.") };
    if (!baseOk || !api) return { result: fail("KHQRPAY_API_BASE must be an https address (or http on localhost).") };
    if (mode === "live" && kind === "write") return { result: fail("This server has a live key, and it never creates or changes live payments. Give it a test key (kp_test_…) to create and simulate test payments.") };
    if (mode === "live" && !options.allowLiveReads) return { result: fail("This server has a live key. Reading live payments needs KHQRPAY_MCP_LIVE_READS=1 in its environment; with a test key (kp_test_…) every tool works.") };
    return { api };
  }

  const server = new McpServer({ name: "khqrpay", version: VERSION });

  server.registerTool(
    "create_test_payment",
    {
      title: "Create a test payment",
      description:
        "Creates a KHQRPay test payment: a KHQR that no bank will pay, with a hosted checkout page. Only with a kp_test_ key: this server never creates live payments. Returns the payment, including checkout_url and expires_at. Move it with simulate_test_payment; the store's test webhook endpoints get the events.",
      inputSchema: {
        amount: z.union([z.string(), z.number()]).describe('Dollars with up to 2 decimals ("16.88"), or whole riel ("5000").'),
        currency: z.enum(["USD", "KHR"]).default("USD").describe("The currency the amount is in."),
        reference_id: z.string().min(1).max(255).optional().describe("Your order id, as a string."),
        metadata: z.record(z.string(), z.unknown()).optional().describe("Your own JSON object: up to 50 keys and 4 KB."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ amount, currency, reference_id, metadata }) => {
      const g = gate("write");
      if ("result" in g) return g.result;
      const body = { amount, currency, ...(reference_id ? { reference_id } : {}), ...(metadata ? { metadata } : {}) };
      const r = await g.api.request("POST", "/v1/payments", { body, idempotencyKey: `mcp-${randomUUID()}` });
      if (!r.ok) return apiError(r);
      const p = r.body as { id?: string; amount?: string; currency?: string; checkout_url?: string; expires_at?: string };
      return json(`Test payment ${p.id}: ${p.amount} ${p.currency}, checkout ${p.checkout_url}, offered until ${p.expires_at}.`, r.body);
    },
  );

  server.registerTool(
    "simulate_test_payment",
    {
      title: "Simulate a test payment",
      description:
        "Moves a test payment to scanned, paid, expired or failed, as if the customer and the bank had acted, and the store's test webhook endpoints get the matching event. Test payments only. To try a late payment, simulate expired and then paid. A status the payment can't move to changes nothing.",
      inputSchema: {
        id: z.string().min(1).describe("The test payment's id."),
        status: z.enum(["scanned", "paid", "expired", "failed"]),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, status }) => {
      const g = gate("write");
      if ("result" in g) return g.result;
      const r = await g.api.request("POST", `/v1/test/payments/${encodeURIComponent(id)}/simulate`, { body: { status } });
      if (!r.ok) return apiError(r);
      const p = r.body as { id?: string; status?: string };
      return json(`Test payment ${p.id} is now ${p.status}.`, r.body);
    },
  );

  const readNote = "Each call counts toward the account's daily read allowance, so read when you need the answer and never poll in a loop; application code should follow payments with webhooks.";

  server.registerTool(
    "get_payment",
    {
      title: "Get a payment",
      description: `Reads one payment by its id: status (pending, scanned, paid, expired or failed), amounts, expiry, and whether it was paid late. ${readNote}`,
      inputSchema: { id: z.string().min(1).describe("The payment's id.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      const g = gate("read");
      if ("result" in g) return g.result;
      const r = await g.api.request("GET", `/v1/payments/${encodeURIComponent(id)}`);
      if (!r.ok) return apiError(r);
      const p = r.body as { id?: string; status?: string; livemode?: boolean };
      return json(`Payment ${p.id} (${p.livemode ? "live" : "test"}) is ${p.status}.`, r.body);
    },
  );

  server.registerTool(
    "list_payments",
    {
      title: "List payments",
      description: `Lists the store's payments in the key's mode, newest first, one page at a time; each leaves out metadata, which get_payment returns. ${readNote}`,
      inputSchema: {
        status: z.enum(["pending", "scanned", "paid", "expired", "failed"]).optional(),
        limit: z.number().int().min(1).max(100).default(10),
        cursor: z.string().optional().describe("next_cursor from the previous page, with the same status."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ status, limit, cursor }) => {
      const g = gate("read");
      if ("result" in g) return g.result;
      const q = new URLSearchParams({ limit: String(limit) });
      if (status) q.set("status", status);
      if (cursor) q.set("cursor", cursor);
      const r = await g.api.request("GET", `/v1/payments?${q}`);
      if (!r.ok) return apiError(r);
      const list = r.body as { data?: unknown[]; has_more?: boolean };
      return json(`${list.data?.length ?? 0} payment(s)${list.has_more ? ", and more: pass next_cursor for the next page" : ""}.`, r.body);
    },
  );

  server.registerTool(
    "get_usage",
    {
      title: "Get plan usage",
      description: "Shows the account's plan, its paid transactions used and left this period, and when the period ends. Only paid live payments count; test payments never do.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const g = gate("read");
      if ("result" in g) return g.result;
      const r = await g.api.request("GET", "/v1/usage");
      if (!r.ok) return apiError(r);
      const u = r.body as { plan?: string; used?: number; limit?: number; remaining?: number };
      return json(`Plan ${u.plan}: ${u.used} of ${u.limit} paid transactions used, ${u.remaining} left.`, r.body);
    },
  );

  server.registerTool(
    "check_webhook_signature",
    {
      title: "Check a webhook signature",
      description:
        "Checks an X-KHQRPay-Signature header against a webhook's raw body, with the signing secret from this server's KHQRPAY_WEBHOOK_SECRET (the secret is never an argument and never shown). Says why a check fails: a malformed header, a timestamp more than 5 minutes off, or a mismatch. Runs on this machine; nothing is sent anywhere.",
      inputSchema: {
        raw_body: z.string().describe("The request body exactly as received, before any JSON parsing."),
        signature_header: z.string().describe("The X-KHQRPay-Signature header's value: t=<unix seconds>,v1=<hex>."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ raw_body, signature_header }) => {
      const check = checkSignature(raw_body, signature_header, options.webhookSecret, now());
      return check.valid
        ? text(`Valid: signed ${check.age_seconds} seconds ago with this endpoint's secret.`)
        : text(`Not valid. ${check.reason}`);
    },
  );

  return server;
}
