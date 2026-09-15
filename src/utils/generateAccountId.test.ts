import { describe, expect, it } from "vitest";
import { generateAccountId } from "./generateAccountId.js";

describe("generateAccountId", () => {
  it("generates a ten-digit numeric identifier", () => {
    const accountId = generateAccountId();

    expect(accountId).toMatch(/^\d{10}$/);
  });

  it("generates identifiers without relying on a fixed value", () => {
    const identifiers = new Set(Array.from({ length: 25 }, generateAccountId));

    expect(identifiers.size).toBeGreaterThan(1);
  });
});
