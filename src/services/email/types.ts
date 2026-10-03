/**
 * Email provider abstraction.
 *
 * Business logic (the OTP flow) only ever talks to `EmailProvider`; picking
 * Resend / SendGrid / SES is a config change. Adapters speak their vendor's
 * REST API directly over fetch so no SDK is pulled into the runtime for a
 * single HTTP call.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailSendResult {
  /** Provider-assigned message id, recorded in logs for support tracing. */
  messageId: string;
  provider: string;
}

export class EmailDeliveryError extends Error {
  readonly code: string;
  readonly statusCode: number | undefined;
  readonly provider: string;

  constructor(provider: string, code: string, message: string, statusCode?: number) {
    super(message);
    this.name = "EmailDeliveryError";
    this.provider = provider;
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/**
 * Shared HTTP plumbing. A non-2xx response becomes an EmailDeliveryError so
 * callers never see a raw fetch rejection, and the response body is truncated
 * before it can reach a log line.
 */
export async function postJson(
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = 10_000,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const reason = (err as { name?: string })?.name === "AbortError" ? "timeout" : "network_error";
    throw new EmailDeliveryError(provider, reason, `${provider} request failed (${reason})`);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: response.ok, status: response.status, json, text: text.slice(0, 500) };
}
