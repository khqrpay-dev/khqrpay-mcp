/** What a call to the KHQRPay API came back with: the body, or the API's error code and message. */
export type ApiResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; error: string; message: string; retryAfter?: number };

export class KhqrPayApi {
  constructor(
    private readonly key: string,
    private readonly base: string,
    private readonly fetchImpl: typeof fetch,
    private readonly userAgent: string,
  ) {}

  async request(method: "GET" | "POST", path: string, opts: { body?: unknown; idempotencyKey?: string } = {}): Promise<ApiResult> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.key}`, "User-Agent": this.userAgent, Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return { ok: false, status: 0, error: "network_error", message: `KHQRPay couldn't be reached: ${(err as Error).message}` };
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (res.ok) return { ok: true, status: res.status, body };
    const err = (body ?? {}) as { error?: unknown; message?: unknown };
    const retry = Number(res.headers.get("retry-after"));
    return {
      ok: false,
      status: res.status,
      error: typeof err.error === "string" ? err.error : `http_${res.status}`,
      message: typeof err.message === "string" ? err.message : `KHQRPay answered HTTP ${res.status}.`,
      ...(Number.isFinite(retry) && retry > 0 ? { retryAfter: retry } : {}),
    };
  }
}
