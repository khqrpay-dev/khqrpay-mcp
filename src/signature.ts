import { createHmac, timingSafeEqual } from "node:crypto";

export type SignatureCheck = { valid: true; timestamp: number; age_seconds: number } | { valid: false; reason: string };

/**
 * Checks an X-KHQRPay-Signature header ("t=<unix seconds>,v1=<hex>") against a webhook's raw body: v1 is the hex
 * HMAC-SHA256 of "<t>.<raw body>", keyed with the endpoint's signing secret, and t must be within 5 minutes of now.
 * An unset or empty secret refuses everything, since HMAC accepts an empty key. It says why a check fails, but never
 * what the right signature would be.
 */
export function checkSignature(rawBody: string, header: string, secret: string | undefined, nowSeconds = Date.now() / 1000, toleranceSec = 300): SignatureCheck {
  if (!secret) {
    return { valid: false, reason: "KHQRPAY_WEBHOOK_SECRET isn't set for this server, so nothing can be checked. Set it to the endpoint's signing secret (whsec_…) in the server's environment." };
  }
  const h = String(header ?? "");
  const t = /(?:^|,)\s*t=(\d{1,12})\s*(?=,|$)/.exec(h)?.[1];
  const v1 = /(?:^|,)\s*v1=([0-9a-fA-F]{64})\s*(?=,|$)/.exec(h)?.[1];
  if (!t || !v1) return { valid: false, reason: "The header isn't in the form t=<unix seconds>,v1=<64 hex digits>." };
  const age = Math.round(nowSeconds - Number(t));
  if (Math.abs(age) > toleranceSec) {
    return { valid: false, reason: `The timestamp is ${Math.abs(age)} seconds ${age > 0 ? "old" : "in the future"}. A signature more than 5 minutes off is refused.` };
  }
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(v1, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { valid: false, reason: "The signature doesn't match this body and secret. Check the body is the raw bytes as received, not JSON parsed and written out again, and that the secret is the signing secret of the endpoint that received the event." };
  }
  return { valid: true, timestamp: Number(t), age_seconds: age };
}
