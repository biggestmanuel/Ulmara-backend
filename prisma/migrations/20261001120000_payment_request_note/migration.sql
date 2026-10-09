-- B3: the pay-link note.
--
-- A payment request could previously carry no free-text context, so the payer
-- saw only an amount and an asset. `note` is optional and bounded: the public
-- GET is unauthenticated, so this is attacker-supplied text rendered to a third
-- party and the 140-character cap is a real constraint rather than a style
-- choice.
--
-- Nullable with no default, so existing rows are untouched and a request created
-- before this migration reads back as note = null.
--
-- Apply with: npx prisma migrate deploy
--
-- Tested against a disposable local PostgreSQL only. NOT applied to Neon.

-- AlterTable
ALTER TABLE "PaymentRequest" ADD COLUMN     "note" TEXT;
