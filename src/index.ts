#!/usr/bin/env node
// khqrpay-mcp: a local MCP server for KHQRPay, spoken over stdin and stdout. Nothing is written to stdout but the
// protocol, and the keys are read from the environment and never printed.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const server = createServer({
  secretKey: process.env.KHQRPAY_SECRET_KEY,
  webhookSecret: process.env.KHQRPAY_WEBHOOK_SECRET,
  allowLiveReads: process.env.KHQRPAY_MCP_LIVE_READS === "1",
  apiBase: process.env.KHQRPAY_API_BASE,
});
await server.connect(new StdioServerTransport());
