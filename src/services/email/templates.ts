import { env } from "../../config/env.js";

/**
 * Verification-code email bodies. Kept deliberately plain and inline-styled so
 * they render in Outlook/Gmail without a build step; the code is the only
 * variable content and the copy never embeds account identifiers.
 */
export function verificationEmailSubject(code: string): string {
  return `${code} is your Ulmara verification code`;
}

export function verificationEmailBody(code: string, ttlMinutes: number): { html: string; text: string } {
  const text =
    `Your Ulmara verification code is ${code}\n\n` +
    `It expires in ${ttlMinutes} minutes. If you did not request this code you can safely ignore this email.\n\n` +
    `Ulmara will never ask you for this code over a call or chat.`;

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <table role="presentation" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <tr><td>
        <h1 style="margin:0 0 4px;font-size:20px;">Verify your email</h1>
        <p style="margin:0 0 24px;color:#4b5563;font-size:14px;">Enter this code to finish setting up your Ulmara account.</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:8px;background:#f4f5f7;border-radius:8px;padding:20px 0;text-align:center;margin:0 0 24px;">${code}</div>
        <p style="margin:0 0 8px;color:#4b5563;font-size:14px;">This code expires in ${ttlMinutes} minutes.</p>
        <p style="margin:0 0 24px;color:#6b7280;font-size:13px;">If you did not request this code, you can safely ignore this email.</p>
        <p style="margin:0;color:#9ca3af;font-size:12px;">Ulmara will never ask you for this code over a call or chat.</p>
      </td></tr>
    </table>
  </body>
</html>`;

  return { html, text };
}

export function ttlMinutes(): number {
  return Math.round(env.OTP_TTL_SECONDS / 60);
}
