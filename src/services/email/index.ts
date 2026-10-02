import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { createResendProvider } from "./resend.provider.js";
import { createSendGridProvider } from "./sendgrid.provider.js";
import { createSesProvider } from "./ses.provider.js";
import { EmailDeliveryError, type EmailProvider } from "./types.js";

let cached: EmailProvider | null = null;

/**
 * Resolves the configured provider, memoised for the process lifetime.
 * Throws EmailDeliveryError when credentials are absent so callers can turn
 * that into a clear 503 rather than silently skipping the send.
 */
export function getEmailProvider(): EmailProvider {
  if (cached) return cached;

  switch (env.EMAIL_PROVIDER) {
    case "resend":
      if (!env.RESEND_API_KEY) {
        throw new EmailDeliveryError("resend", "missing_credentials", "RESEND_API_KEY is not set");
      }
      cached = createResendProvider(env.RESEND_API_KEY);
      break;
    case "sendgrid":
      if (!env.SENDGRID_API_KEY) {
        throw new EmailDeliveryError("sendgrid", "missing_credentials", "SENDGRID_API_KEY is not set");
      }
      cached = createSendGridProvider(env.SENDGRID_API_KEY, undefined, env.SENDGRID_FROM_EMAIL);
      break;
    case "ses":
      if (!env.AWS_SES_REGION || !env.AWS_SES_ACCESS_KEY_ID || !env.AWS_SES_SECRET_ACCESS_KEY) {
        throw new EmailDeliveryError(
          "ses",
          "missing_credentials",
          "AWS_SES_REGION, AWS_SES_ACCESS_KEY_ID and AWS_SES_SECRET_ACCESS_KEY must all be set",
        );
      }
      cached = createSesProvider({
        region: env.AWS_SES_REGION,
        accessKeyId: env.AWS_SES_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SES_SECRET_ACCESS_KEY,
        fromEmail: env.SENDGRID_FROM_EMAIL,
        fromName: env.EMAIL_FROM_NAME,
      });
      break;
    default: {
      // `env.EMAIL_PROVIDER` is a zod enum, so the switch above narrows it to
      // `never` by the time control reaches `default` — a runtime guard for a
      // value the type system says cannot exist. Re-reading it as a plain
      // `string` keeps the offending value in the error message instead of
      // printing an unhelpfully empty one.
      const selected: string = env.EMAIL_PROVIDER;
      throw new EmailDeliveryError("unknown", "unsupported_provider", `Unsupported EMAIL_PROVIDER: ${selected}`);
    }
  }

  return cached;
}

/** Test seam: forces the next getEmailProvider() call to rebuild. */
export function resetEmailProviderCache(): void {
  cached = null;
}

/** True when the selected provider has everything it needs to send. */
export function isEmailProviderConfigured(): boolean {
  try {
    getEmailProvider();
    return true;
  } catch {
    return false;
  }
}

/** Best-effort wrapper used by the OTP flow; never throws to the caller. */
export async function trySendEmail(to: string, subject: string, html: string, text: string): Promise<boolean> {
  try {
    const provider = getEmailProvider();
    const result = await provider.send({ to, subject, html, text });
    logger.info(
      // `subject` is deliberately NOT logged. verificationEmailSubject()
      // interpolates the live one-time code ("123456 is your Ulmara
      // verification code"), so logging it wrote every active code into the log
      // file and into Sentry. messageId is enough to trace a send, and the
      // recipient is deliberately absent too.
      { event: "email_sent", provider: result.provider, messageId: result.messageId },
      "Verification email dispatched",
    );
    return true;
  } catch (err) {
    if (err instanceof EmailDeliveryError) {
      logger.error(
        { event: "email_send_failed", provider: err.provider, code: err.code, statusCode: err.statusCode, err: err.message },
        "Verification email could not be dispatched",
      );
    } else {
      logger.error({ event: "email_send_failed", err }, "Verification email could not be dispatched");
    }
    return false;
  }
}
