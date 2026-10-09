import { createHash, createHmac } from "node:crypto";
import { env } from "../../config/env.js";
import { EmailDeliveryError, type EmailMessage, type EmailProvider, type EmailSendResult } from "./types.js";

/**
 * AWS SES v2 adapter.
 *
 * Authenticates with SigV4 (no aws-sdk dependency) and calls
 * POST https://email.{region}.amazonaws.com/v2/email.
 *
 * The signing routine is exported separately so it can be unit-tested against
 * the published AWS SigV4 test vectors without any network access.
 */

export interface SigV4Input {
  method: string;
  /** Absolute path, e.g. "/v2/email". */
  path: string;
  region: string;
  service: string;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Injectable for deterministic tests. */
  date?: Date;
  /** Explicit Host header. Defaults to the SES virtual-host form. */
  host?: string;
  /**
   * Extra headers to sign. `content-type: application/json` is added for
   * every request this module makes; pass `omitContentType` to suppress it
   * (used to reproduce the published AWS SigV4 test vectors, which sign a
   * GET with no body and therefore no content-type).
   */
  extraHeaders?: Record<string, string>;
  omitContentType?: boolean;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function amzTimestamp(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/** Canonical header map: lowercase keys, trimmed values, sorted by key. */
function canonicalHeaders(headers: Record<string, string>): { canonical: string; signed: string } {
  const normalized = Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), String(value).trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    canonical: normalized.map(([k, v]) => `${k}:${v}\n`).join(""),
    signed: normalized.map(([k]) => k).join(";"),
  };
}

export interface SigV4Result {
  authorization: string;
  amzDate: string;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

/** Returns the Authorization header plus the intermediate values used to build it. */
export function signAwsRequest(input: SigV4Input): SigV4Result {
  const { amzDate, dateStamp } = amzTimestamp(input.date ?? new Date());
  const payloadHash = sha256Hex(input.body);
  const host = input.host ?? `email.${input.region}.amazonaws.com`;

  const { canonical: canonicalHeaderBlock, signed: signedHeaders } = canonicalHeaders({
    ...(input.omitContentType ? {} : { "content-type": "application/json" }),
    host,
    "x-amz-date": amzDate,
    ...(input.extraHeaders ?? {}),
  });

  const canonicalRequest = [
    input.method,
    input.path,
    "", // no query string
    canonicalHeaderBlock,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return {
    authorization:
      `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDate,
    canonicalRequest,
    stringToSign,
    signature,
  };
}

export interface SesConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  fromEmail?: string;
  fromName?: string;
}

export function createSesProvider(config: SesConfig): EmailProvider {
  const missing = (
    [
      ["region", config.region],
      ["accessKeyId", config.accessKeyId],
      ["secretAccessKey", config.secretAccessKey],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new EmailDeliveryError("ses", "missing_credentials", `SES provider is missing: ${missing.join(", ")}`);
  }

  return {
    name: "ses",
    async send(message: EmailMessage): Promise<EmailSendResult> {
      const from = config.fromEmail ?? env.EMAIL_FROM;
      const body = JSON.stringify({
        FromEmailAddress: config.fromName ? `${config.fromName} <${from}>` : from,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: message.text, Charset: "UTF-8" },
              Html: { Data: message.html, Charset: "UTF-8" },
            },
          },
        },
      });

      const { authorization, amzDate } = signAwsRequest({
        method: "POST",
        path: "/v2/email",
        region: config.region,
        service: "ses",
        body,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      let response: Response;
      try {
        response = await fetch(`https://email.${config.region}.amazonaws.com/v2/email`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-amz-date": amzDate,
            authorization,
          },
          body,
          signal: controller.signal,
        });
      } catch (err) {
        const reason = (err as { name?: string })?.name === "AbortError" ? "timeout" : "network_error";
        throw new EmailDeliveryError("ses", reason, `SES request failed (${reason})`);
      } finally {
        clearTimeout(timer);
      }

      const text = await response.text();
      if (!response.ok) {
        throw new EmailDeliveryError(
          "ses",
          "send_failed",
          `SES rejected the message with status ${response.status}`,
          response.status,
        );
      }
      let json: { MessageId?: string } = {};
      try {
        json = text ? (JSON.parse(text) as { MessageId?: string }) : {};
      } catch {
        json = {};
      }
      if (!json.MessageId) {
        throw new EmailDeliveryError("ses", "invalid_response", "SES response did not include a MessageId");
      }
      return { messageId: json.MessageId, provider: "ses" };
    },
  };
}
