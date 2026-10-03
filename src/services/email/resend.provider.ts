import { env } from "../../config/env.js";
import { EmailDeliveryError, postJson, type EmailMessage, type EmailProvider, type EmailSendResult } from "./types.js";

/**
 * Resend adapter (default provider).
 *
 * API: POST https://api.resend.com/emails
 *   - `Authorization: Bearer <RESEND_API_KEY>`
 *   - 2xx -> { "id": "<message id>" }
 *
 * Docs: https://resend.com/docs/api-reference/emails/send-email
 */
export function createResendProvider(apiKey: string, baseUrl = "https://api.resend.com"): EmailProvider {
  if (!apiKey) {
    throw new EmailDeliveryError("resend", "missing_credentials", "RESEND_API_KEY is required for the Resend provider");
  }
  return {
    name: "resend",
    async send(message: EmailMessage): Promise<EmailSendResult> {
      const result = await postJson(
        "resend",
        `${baseUrl.replace(/\/$/, "")}/emails`,
        { authorization: `Bearer ${apiKey}` },
        {
          from: formatFrom(),
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        },
      );
      if (!result.ok) {
        throw new EmailDeliveryError(
          "resend",
          "send_failed",
          `Resend rejected the message with status ${result.status}`,
          result.status,
        );
      }
      const id = (result.json as { id?: string } | null)?.id;
      if (!id) {
        throw new EmailDeliveryError("resend", "invalid_response", "Resend response did not include a message id");
      }
      return { messageId: id, provider: "resend" };
    },
  };
}

/** Resend accepts `Name <addr@host>`; falls back to the bare configured address. */
function formatFrom(): string {
  const from = env.EMAIL_FROM;
  return env.EMAIL_FROM_NAME ? `${env.EMAIL_FROM_NAME} <${from}>` : from;
}
