# khqrpay-mcp

A local [MCP](https://modelcontextprotocol.io) server for [KHQRPay](https://khqrpay.dev), the KHQR payment gateway and API for Cambodia. It lets an AI coding tool create and check KHQR test payments, read payments, show your plan's usage and check webhook signatures while it builds your integration. It runs on your own machine, with your own key.

## What it can do

| Tool | What it does | Key |
| --- | --- | --- |
| `create_test_payment` | Creates a test payment: a KHQR no bank will pay, with a hosted checkout page | Test only |
| `simulate_test_payment` | Moves a test payment to scanned, paid, expired or failed; your test webhook endpoints get the events | Test only |
| `get_payment` | Reads one payment: status, amounts, expiry, whether it was paid late | Test, or live with opt-in |
| `list_payments` | Lists payments, newest first, a page at a time | Test, or live with opt-in |
| `get_usage` | Shows your plan's paid transactions used and left | Test, or live with opt-in |
| `check_webhook_signature` | Checks an `X-KHQRPay-Signature` header against a raw body, and says why it fails | Runs locally |

## Safe by default

- **Test keys do everything.** Use a `kp_test_` key: test payments never reach a bank and never count toward your plan.
- **Live keys never create or change anything.** With a `kp_live_` key, `create_test_payment` and `simulate_test_payment` refuse, and the read tools work only if you set `KHQRPAY_MCP_LIVE_READS=1`.
- **Secrets stay in the environment.** Keys are read from environment variables and never printed. The webhook signing secret is never a tool argument, and `check_webhook_signature` never shows the right signature.
- **No polling.** Reads count toward your account's daily read allowance, so the read tools tell the model to read once, not in a loop. Your own app should follow payments with webhooks.

## Set up

You need Node.js 18 or newer and a test key from the KHQRPay dashboard (*API keys*, with the page set to *Test*).

**Claude Code**

```bash
claude mcp add khqrpay -e KHQRPAY_SECRET_KEY=kp_test_… -- npx -y khqrpay-mcp
```

**Claude Desktop, Cursor and other clients** that read an `mcpServers` file (`claude_desktop_config.json`, `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "khqrpay": {
      "command": "npx",
      "args": ["-y", "khqrpay-mcp"],
      "env": { "KHQRPAY_SECRET_KEY": "kp_test_…" }
    }
  }
}
```

Add `"KHQRPAY_WEBHOOK_SECRET": "whsec_…"` to `env` to use `check_webhook_signature` with your test endpoint's signing secret.

## Environment

| Variable | What it's for |
| --- | --- |
| `KHQRPAY_SECRET_KEY` | Your KHQRPay key. `kp_test_` for every tool; `kp_live_` for the read tools only, with the next variable |
| `KHQRPAY_MCP_LIVE_READS` | Set to `1` to let a live key read payments and usage. Nothing ever creates or changes live payments |
| `KHQRPAY_WEBHOOK_SECRET` | A webhook endpoint's signing secret, for `check_webhook_signature` |
| `KHQRPAY_API_BASE` | Another KHQRPay address, for testing. Must be https, or http on localhost |

## Learn more

- [KHQRPay docs](https://khqrpay.dev/docs): payments, webhooks, test mode and going live.
- [The AI brief](https://khqrpay.dev/llms-full.txt): every docs page in one file, for your coding tool's context.
- Official SDKs: [Node.js](https://www.npmjs.com/package/khqrpay), [Python](https://pypi.org/project/khqrpay/) and [PHP](https://packagist.org/packages/khqrpay/khqrpay-php).

## License

MIT
