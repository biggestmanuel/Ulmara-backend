import { randomInt } from "node:crypto";

// Generates a random 10-digit Account ID.
// Uniqueness must be enforced by checking against the DB before saving.
export function generateAccountId(): string {
  let id = "";
  for (let i = 0; i < 10; i++) {
    id += randomInt(0, 10).toString();
  }
  return id;
}
