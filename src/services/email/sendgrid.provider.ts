import { env } from "../../config/env.js";
import { EmailDeliveryError, postJson, type EmailMessage, type EmailProvider, type EmailSendResult } from "./types.js";

/**
 * SendGrid adapter.
 *
 * API: POST https://api.sendgrid.com/v3/mail/send
 *   - `Authorization: Bearer <SENDGRID_API_KEY>`
 *   - 2xx -> 202 with an empty body and an `x-message-id` header.
 *
 * SENDGRID_FROM_EMAIL overrides EMAIL_FROM because SendGrid rejects any sender
 * outside the verified-sender list.
 *
 * Docs: https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send
 */
export function createSendGridProvider(
  apiKey: string,
  baseUrl = "https://api.sendgrid.com",
  fromEmail?: string,
): EmailProvider {
  if (!apiKey) {
    throw new EmailDeliveryError("sendgrid", "missing_credentials", "SENDGRID_API_KEY is required for the SendGrid provider");
  }
  return {
    name: "sendgrid",
    async send(message: EmailMessage): Promise<EmailSendResult> {
      const sender = fromEmail ?? env.EMAIL_FROM;
      const result = await postJson(
        "sendgrid",
        `${baseUrl.replace(/\/$/, "")}/v3/mail/send`,
        { authorization: `Bearer ${apiKey}` },
        {
          personalizations: [{ to: [{ email: message.to }] }],
          from: env.EMAIL_FROM_NAME ? { name: env.EMAIL_FROM_NAME, email: sender } : { email: sender },
          subject: message.subject,
          content: [
            { type: "text/plain", value: message.text },
            { type: "text/html", value: message.html },
          ],
        },
      );
      if (!result.ok) {
        throw new EmailDeliveryError(
          "sendgrid",
          "send_failed",
          `SendGrid rejected the message with status ${result.status}`,
          result.status,
        );
      }
      // SendGrid returns no JSON body; fall back to a synthetic id so the
      // caller's logging contract still gets a stable handle.
      const messageId = (result.json as { message_id?: string } | null)?.message_id ?? `sendgrid-${Date.now()}`;
      return { messageId, provider: "sendgrid" };
    },
  };
}
