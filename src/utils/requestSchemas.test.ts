import { describe, expect, it } from "vitest";
import { CHAIN_NAMES } from "../chains/index.js";
import {
  accountIdParamSchema,
  chainParamSchema,
  idParamSchema,
  paginationQuerySchema,
  referenceParamSchema,
  registerWalletsSchema,
  signedTxSchema,
} from "./requestSchemas.js";

/**
 * Path/query/body shape validation.
 *
 * These are the gaps the endpoint audit found: request BODIES were validated
 * with zod nearly everywhere, but path and query values were read through a
 * bare cast (`request.params as { id: string }`), which has no runtime effect.
 * A client could therefore send `/api/transaction/not-a-uuid` or
 * `?limit=1e9` and the value went straight into a Prisma `where` clause or an
 * `OFFSET`. Every case below is a value a real client can send.
 */

const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("idParamSchema", () => {
  it("accepts a UUID", () => {
    expect(idParamSchema.safeParse({ id: UUID }).success).toBe(true);
  });

  it("rejects anything that cannot be a row id", () => {
    for (const bad of ["not-a-uuid", "", "1", "1; DROP TABLE", "../../etc/passwd", "null", "%00"]) {
      expect(idParamSchema.safeParse({ id: bad }).success, bad).toBe(false);
    }
  });

  it("rejects a missing id", () => {
    expect(idParamSchema.safeParse({}).success).toBe(false);
  });
});

describe("accountIdParamSchema", () => {
  it("accepts exactly 10 digits", () => {
    expect(accountIdParamSchema.safeParse({ accountId: "1234567890" }).success).toBe(true);
    expect(accountIdParamSchema.safeParse({ accountId: "0000000001" }).success).toBe(true);
  });

  it("rejects the wrong length or non-digits", () => {
    for (const bad of ["123456789", "12345678901", "123456789a", "", " 123456789", "1234 567890"]) {
      expect(accountIdParamSchema.safeParse({ accountId: bad }).success, bad).toBe(false);
    }
  });
});

describe("chainParamSchema", () => {
  it("accepts every wire chain identifier", () => {
    for (const chain of CHAIN_NAMES) {
      expect(chainParamSchema.safeParse({ chain }).success, chain).toBe(true);
    }
  });

  it("rejects lowercase and unknown chains", () => {
    // Chain identifiers are UPPERCASE on the wire; "eth" is a client bug.
    for (const bad of ["eth", "Eth", "DOGE", "", "ETH; DROP"]) {
      expect(chainParamSchema.safeParse({ chain: bad }).success, bad).toBe(false);
    }
  });
});

describe("referenceParamSchema", () => {
  it("accepts a bounded reference and rejects an empty or huge one", () => {
    expect(referenceParamSchema.safeParse({ reference: "ord_123" }).success).toBe(true);
    expect(referenceParamSchema.safeParse({ reference: "   " }).success).toBe(false);
    expect(referenceParamSchema.safeParse({ reference: "a".repeat(192) }).success).toBe(false);
  });
});

describe("paginationQuerySchema", () => {
  it("defaults to page 1, limit 20", () => {
    expect(paginationQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
  });

  it("coerces digit strings to numbers", () => {
    expect(paginationQuerySchema.parse({ page: "3", limit: "50" })).toEqual({ page: 3, limit: 50 });
  });

  it("rejects a limit that would ask for the whole table", () => {
    // Without a ceiling `?limit=100000000` becomes an unbounded OFFSET query.
    expect(paginationQuerySchema.safeParse({ limit: "100" }).success).toBe(true);
    expect(paginationQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: "100000" }).success).toBe(false);
  });

  it("rejects zero, negatives and non-numeric values", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "1e3", " 1", "NaN", "Infinity", "٣"]) {
      expect(paginationQuerySchema.safeParse({ page: bad }).success, `page=${bad}`).toBe(false);
      expect(paginationQuerySchema.safeParse({ limit: bad }).success, `limit=${bad}`).toBe(false);
    }
  });

  it("rejects a leading zero, so ?page=01 is not silently page 1", () => {
    expect(paginationQuerySchema.safeParse({ page: "01" }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: "020" }).success).toBe(false);
  });

  it("rejects a page so large it cannot be an integer offset", () => {
    expect(paginationQuerySchema.safeParse({ page: "99999999999999999999" }).success).toBe(false);
  });
});

describe("signedTxSchema", () => {
  it("accepts a plausible serialized transaction", () => {
    expect(signedTxSchema.safeParse({ signedTx: "0x" + "ab".repeat(200) }).success).toBe(true);
  });

  it("rejects an empty, blank or absurdly large payload", () => {
    expect(signedTxSchema.safeParse({ signedTx: "" }).success).toBe(false);
    expect(signedTxSchema.safeParse({ signedTx: "   " }).success).toBe(false);
    expect(signedTxSchema.safeParse({ signedTx: "a".repeat(1_000_001) }).success).toBe(false);
  });

  it("rejects a non-string", () => {
    expect(signedTxSchema.safeParse({ signedTx: 12345 }).success).toBe(false);
    expect(signedTxSchema.safeParse({}).success).toBe(false);
  });
});

describe("registerWalletsSchema", () => {
  it("accepts a bounded batch", () => {
    const r = registerWalletsSchema.safeParse({
      addresses: CHAIN_NAMES.map((chain) => ({ chain, address: "0xabc" })),
    });
    expect(r.success).toBe(true);
  });

  it("rejects an empty or oversized batch", () => {
    // An unbounded array would drive an unbounded number of on-chain lookups.
    expect(registerWalletsSchema.safeParse({ addresses: [] }).success).toBe(false);
    const many = Array.from({ length: 21 }, () => ({ chain: "ETH", address: "0xabc" }));
    expect(registerWalletsSchema.safeParse({ addresses: many }).success).toBe(false);
  });

  it("rejects an unknown chain or a missing address", () => {
    expect(registerWalletsSchema.safeParse({ addresses: [{ chain: "DOGE", address: "0xabc" }] }).success).toBe(false);
    expect(registerWalletsSchema.safeParse({ addresses: [{ chain: "ETH" }] }).success).toBe(false);
  });

  it("rejects unknown fields so a typo is an error, not a silent no-op", () => {
    // e.g. a client sending `network` instead of `chain` used to be ignored.
    expect(registerWalletsSchema.safeParse({ addresses: [], extra: 1 }).success).toBe(false);
    expect(
      registerWalletsSchema.safeParse({ addresses: [{ chain: "ETH", address: "0xabc", network: "eth" }] }).success,
    ).toBe(false);
  });

  it("rejects a body that is not an object", () => {
    expect(registerWalletsSchema.safeParse(null).success).toBe(false);
    expect(registerWalletsSchema.safeParse("addresses").success).toBe(false);
  });
});
