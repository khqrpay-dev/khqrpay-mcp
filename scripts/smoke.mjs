// One real run of the built server, spawned over stdio as an AI tool would, against KHQRPay's live API with a TEST key:
// it makes a test payment (which never reaches a bank), simulates it paid, reads it back, lists, shows usage and checks
// a signature. Usage: KHQRPAY_SECRET_KEY=kp_test_… npm run smoke   (the key is never printed)
import { createHmac } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const key = process.env.KHQRPAY_SECRET_KEY ?? "";
if (!key.startsWith("kp_test_")) {
  console.error("Set KHQRPAY_SECRET_KEY to a kp_test_ key.");
  process.exit(1);
}
const secret = `whsec_smoke_${Date.now()}`;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../dist/index.js", import.meta.url).pathname],
  env: { PATH: process.env.PATH ?? "", KHQRPAY_SECRET_KEY: key, KHQRPAY_WEBHOOK_SECRET: secret },
  stderr: "pipe",
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);
let bad = 0;
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text).join("\n");
  if (text.includes(key)) throw new Error(`${name} printed the key`);
  return { error: r.isError === true, text, json: text.includes("\n{") ? JSON.parse(text.slice(text.indexOf("\n{") + 1)) : null };
};
const check = (ok, label) => { if (!ok) bad++; console.log(`${ok ? "ok  " : "BAD "} ${label}`); };

const { tools } = await client.listTools();
check(tools.length === 6, `${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
const created = await call("create_test_payment", { amount: "1.00", currency: "USD", reference_id: `MCP-SMOKE-${Date.now()}` });
check(!created.error && created.json?.livemode === false && created.json?.status === "pending", `create_test_payment: ${created.text.split("\n")[0]}`);
const id = created.json?.id;
const paid = await call("simulate_test_payment", { id, status: "paid" });
check(!paid.error && paid.json?.status === "paid", `simulate_test_payment: ${paid.text.split("\n")[0]}`);
const read = await call("get_payment", { id });
check(!read.error && read.json?.status === "paid" && read.json?.approved_at, `get_payment: ${read.text.split("\n")[0]}`);
const list = await call("list_payments", { status: "paid", limit: 3 });
check(!list.error && list.json?.data?.some((p) => p.id === id), `list_payments: ${list.text.split("\n")[0]}`);
const usage = await call("get_usage");
check(!usage.error && typeof usage.json?.limit === "number", `get_usage: ${usage.text.split("\n")[0]}`);
const body = JSON.stringify({ id: "evt_smoke", type: "payment.completed", livemode: false });
const t = Math.floor(Date.now() / 1000);
const header = `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
check((await call("check_webhook_signature", { raw_body: body, signature_header: header })).text.startsWith("Valid"), "check_webhook_signature: a good signature is valid");
check((await call("check_webhook_signature", { raw_body: body + " ", signature_header: header })).text.startsWith("Not valid"), "check_webhook_signature: a changed body is not");
const bogus = await call("create_test_payment", { amount: "abc" });
check(bogus.error && bogus.text.includes("invalid_amount"), `a bad amount: ${bogus.text}`);
await client.close();
console.log(bad ? `${bad} problem(s)` : "all good");
process.exit(bad ? 1 : 0);
