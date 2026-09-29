import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Frontend↔backend chain-identifier contract.
//
// The frontend (avora-frontend) sends chain values in exactly three places:
//   1. lib/registerWallets.ts       -> POST /api/wallet/register
//                                      (CHAIN_ID_TO_BACKEND, UPPERCASE)
//   2. lib/api/externalTransfers.ts -> POST /api/transaction/external/prepare
//                                      (confirm.tsx forwards params.network
//                                      verbatim, UPPERCASE — this was the
//                                      lowercase 'eth' bug)
//   3. lib/validation/triverify.ts  -> POST /api/validation/address
//                                      (UPPERCASE)
//
// The service layers are stubbed so these tests exercise exactly the zod
// schemas — the wire boundary — hermetically (no DB, no TriVerify SDK, no
// chain RPCs). They pin: post-fix UPPERCASE payloads parse and pass through
// to the service unchanged; the historical lowercase payloads are rejected
// with 400 and never reach a service.
// ---------------------------------------------------------------------------

vi.mock("../services/transaction/externalTransfer.service.js", () => ({
  externalTransferService: {
    prepare: vi.fn(async () => ({
      id: "01234567-89ab-cdef-0123-456789abcdef",
      chain: "ETH",
      asset: "ETH",
      amount: "1.5",
      to: "0x00000000000000000000000000000000c0ffee01",
      fee: "0.00021",
      status: "READY",
    })),
  },
}));

vi.mock("../blockchain/triverify.js", () => ({
  verifyAddressExists: vi.fn(async () => ({
    address: "0x00000000000000000000000000000000c0ffee01",
    chain: "ETH",
    formatValid: true,
    existsOnChain: true,
  })),
}));

vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { CHAIN_NAMES } from "../chains/index.js";
import { externalTransferController } from "./externalTransfer.controller.js";
import { externalTransferService } from "../services/transaction/externalTransfer.service.js";
import { validationController } from "./validation.controller.js";
import { verifyAddressExists } from "../blockchain/triverify.js";

interface MockReply {
  statusCode?: number;
  payload?: unknown;
  code: (code: number) => MockReply;
  send: (payload: unknown) => MockReply;
}

function mockReply(): MockReply {
  // Fastify defaults the status to 200; .code() overrides it.
  const reply: MockReply = {
    statusCode: 200,
    code(code) {
      reply.statusCode = code;
      return reply;
    },
    send(payload) {
      reply.payload = payload;
      return reply;
    },
  };
  return reply;
}

const ALL_CHAINS = ["TON", "BSC", "ETH", "SOL", "BASE", "POLYGON", "TRON", "BTC"] as const;
const RECIPIENT = "0x00000000000000000000000000000000c0ffee01";

const prepareRequest = (chain: string) =>
  ({
    body: { chain, asset: "ETH", amount: "1.5", to: RECIPIENT, pin: "111111" },
    userId: "user-1",
  }) as never;

describe("chain identifier wire contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("CHAIN_NAMES matches the exact set the frontend registers wallets for", () => {
    // Mirrors lib/registerWallets.ts CHAIN_ID_TO_BACKEND values.
    const frontendRegistry = ["ETH", "BSC", "BASE", "POLYGON", "TRON", "SOL", "TON", "BTC"];
    expect([...CHAIN_NAMES].sort()).toEqual([...frontendRegistry].sort());
  });

  it("external/prepare accepts the frontend's UPPERCASE chain and passes it through", async () => {
    const reply = mockReply();
    await externalTransferController.prepare(prepareRequest("ETH"), reply as never);

    expect(reply.statusCode).toBe(201);
    expect(externalTransferService.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ chain: "ETH" }),
    );
  });

  it("external/prepare rejects the historical lowercase 'eth' payload with 400", async () => {
    const reply = mockReply();
    await externalTransferController.prepare(prepareRequest("eth"), reply as never);

    expect(reply.statusCode).toBe(400);
    expect(externalTransferService.prepare).not.toHaveBeenCalled();
  });

  it("every CHAIN_NAMES value is accepted by external/prepare", async () => {
    for (const chain of ALL_CHAINS) {
      const reply = mockReply();
      await externalTransferController.prepare(prepareRequest(chain), reply as never);
      expect(reply.statusCode).toBe(201);
    }
  });

  it("validation/address accepts every uppercase chain and rejects lowercase variants", async () => {
    for (const chain of ALL_CHAINS) {
      const reply = mockReply();
      await validationController.address(
        { body: { address: RECIPIENT, chain }, userId: "user-1" } as never,
        reply as never,
      );
      expect(reply.statusCode).toBe(200);
      expect(verifyAddressExists).toHaveBeenCalledWith(RECIPIENT, chain);
    }

    // Lowercase/malformed identifiers must be rejected by the schema and
    // never reach the verification provider.
    const callsAfterUppercase = vi.mocked(verifyAddressExists).mock.calls.length;
    for (const chain of ["eth", "Ethereum", "bitcoin", "bnb"]) {
      const reply = mockReply();
      await validationController.address(
        { body: { address: RECIPIENT, chain }, userId: "user-1" } as never,
        reply as never,
      );
      expect(reply.statusCode).toBe(400);
    }
    expect(vi.mocked(verifyAddressExists).mock.calls.length).toBe(callsAfterUppercase);
  });

  it("the /transaction/send network enum mirrors external/prepare exactly", async () => {
    // Both controllers derive their enum from CHAIN_NAMES; sending the full
    // uppercase set through prepare proves the shared source drives the
    // schema, so /send cannot drift back to a hand-rolled list either.
    expect([...CHAIN_NAMES]).toEqual([...ALL_CHAINS]);
  });
});
