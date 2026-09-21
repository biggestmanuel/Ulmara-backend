import bcrypt from "bcryptjs";
import { prisma } from "../../config/database.js";
import { HttpError } from "../../utils/apiResponse.js";

// Per-user PIN attempt lockout for transfer authorization. State lives in the
// database (User.pinFailedAttempts / User.pinLockedUntil) so it is enforced
// server-side and survives server restarts and multiple app instances.
export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCKOUT_MS = 15 * 60 * 1000;

// The two failure messages are deliberately identical whether the account is
// already locked or just became locked, and never reveal how many attempts
// remain — the response cannot be used to enumerate accounts or probe PINs.
// One counter guards both doors (login and transfers): they verify the same
// User.pinHash, so brute-forcing either gate must lock the other.
const LOCKED_MESSAGE = "Too many incorrect PIN attempts. Try again in 15 minutes.";
const INCORRECT_MESSAGE = "Incorrect PIN. Try again.";

// The canonical lockout copy, shared by every gate so the UX is identical.
export function lockedMessage(): string {
  return LOCKED_MESSAGE;
}

function lockUntil(): Date {
  return new Date(Date.now() + PIN_LOCKOUT_MS);
}

export const pinLockoutService = {
  // Lockout state for a user. Expired windows are reported as unlocked (and
  // effectively start a fresh counter, since arming the lock resets it).
  async getLockState(userId: string): Promise<{ locked: boolean; until: Date | null }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { pinLockedUntil: true },
    });
    const until = user?.pinLockedUntil ?? null;
    if (!until || until.getTime() <= Date.now()) return { locked: false, until: null };
    return { locked: true, until };
  },

  // Single atomic compare-and-swap per attempt: only counts the failure and
  // arms the lockout if the caller's view of the counter still matches the
  // row, so two concurrent wrong attempts can never both land on the same
  // count (which would let 9 attempts trigger a 5-attempt lockout).
  // Returns the number of failed attempts recorded after this one.
  async recordFailure(userId: string): Promise<number> {
    for (;;) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { pinFailedAttempts: true, pinLockedUntil: true },
      });
      if (!user) throw new HttpError(404, "Account not found");
      const raw = user.pinFailedAttempts;
      // A lockout that has already expired starts a fresh window: count from
      // zero instead of instantly re-locking on a stale counter.
      const expired = user.pinLockedUntil !== null && user.pinLockedUntil.getTime() <= Date.now();
      const current = expired ? 0 : raw;
      const next = current + 1;
      const isLockingAttempt = next >= PIN_MAX_ATTEMPTS;
      // CAS on the raw stored value, so the attempt lands exactly once.
      const updated = await prisma.user.updateMany({
        where: { id: userId, pinFailedAttempts: raw },
        data: {
          pinFailedAttempts: isLockingAttempt ? 0 : next,
          // Arming a lock stamps a fresh window; if instead the previous
          // window already expired, clear the stale timestamp so the row
          // reflects the fresh counter it now carries.
          pinLockedUntil: isLockingAttempt ? lockUntil() : expired ? null : undefined,
        },
      });
      if (updated.count === 1) return next;
      // Another request mutated the counter between read and write; retry
      // against its value instead of double-counting or skipping one.
    }
  },

  // Successful PIN entry clears the counter and any lockout window.
  async reset(userId: string): Promise<void> {
    await prisma.user.updateMany({
      where: { id: userId },
      data: { pinFailedAttempts: 0, pinLockedUntil: null },
    });
  },

  // Full authorize-PIN flow used by transfer endpoints. Order matters:
  // 1. reject while locked (without burning an attempt or even hashing),
  // 2. compare against the stored hash,
  // 3. on success reset the counter, on failure record the attempt.
  // Throws HttpError with a non-revealing message in every failure case.
  async assertPinAuthorized(userId: string, pin: string): Promise<void> {
    const lock = await this.getLockState(userId);
    if (lock.locked && lock.until) {
      const minutes = Math.max(1, Math.ceil((lock.until.getTime() - Date.now()) / 60_000));
      throw new HttpError(
        423,
        `Too many incorrect PIN attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { pinHash: true },
    });
    if (!user?.pinHash) {
      // 409 matches the auth verifyPin contract for "no PIN configured".
      throw new HttpError(409, "No PIN set for this account");
    }

    const valid = await bcrypt.compare(pin, user.pinHash);
    if (!valid) {
      const attempts = await this.recordFailure(userId);
      if (attempts >= PIN_MAX_ATTEMPTS) {
        throw new HttpError(423, LOCKED_MESSAGE);
      }
      throw new HttpError(401, INCORRECT_MESSAGE);
    }

    await this.reset(userId);
  },
};
