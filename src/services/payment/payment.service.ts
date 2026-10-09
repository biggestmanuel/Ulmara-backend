import { prisma } from "../../config/database.js";

export const paymentService = {
  async createRequest(userId: string, input: { asset?: string; symbol?: string; amount?: string; expiresAt?: string; note?: string }) {
    const request = await prisma.paymentRequest.create({
      data: {
        userId,
        asset: input.asset ?? input.symbol ?? "ETH",
        amount: input.amount,
        note: input.note ?? null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      },
    });
    return { requestId: request.id, link: `https://ulmara.app/pay/${request.id}` };
  },

  async getRequest(id: string) {
    const request = await prisma.paymentRequest.findUnique({
      where: { id },
      include: { user: { select: { name: true } } },
    });
    if (!request) throw Object.assign(new Error("Payment request not found"), { statusCode: 404 });

    // `note` only exists once the B3 migration has been applied to whichever
    // database this is talking to. Prisma's client is generated from the
    // schema, so until `prisma migrate deploy` has run the generated type has
    // no such field — hence the explicit pick rather than reading it inline.
    // Read AFTER the not-found guard: touching it on a null row is a TypeError,
    // which would turn a 404 into a 500.
    const note = (request as { note?: string | null }).note ?? null;

    if (request.expiresAt && request.expiresAt < new Date() && request.status === "OPEN") {
      await prisma.paymentRequest.update({ where: { id }, data: { status: "EXPIRED" } });
      request.status = "EXPIRED";
    }

    // C3: the public pay-link shape, built explicitly rather than by returning
    // the Prisma row. Returning the row would leak `userId` (the internal user
    // id) on an UNAUTHENTICATED endpoint, and would silently publish any field
    // added to the model later. `symbol` is derived from `asset` because the
    // model stores one and the pay-link contract exposes both.
    const owner = await prisma.accountId.findUnique({
      where: { userId: request.userId },
      select: { accountId: true },
    });

    return {
      id: request.id,
      status: request.status,
      amount: request.amount === null ? null : request.amount.toString(),
      asset: request.asset,
      symbol: request.asset,
      note,
      requesterAccountId: owner?.accountId ?? "",
      requesterName: request.user.name,
      expiresAt: request.expiresAt,
      createdAt: request.createdAt,
    };
  },

  async fulfillRequest(requestId: string, payerId: string, transactionId: string) {
    const request = await prisma.paymentRequest.findUnique({ where: { id: requestId } });
    if (!request) throw Object.assign(new Error("Payment request not found"), { statusCode: 404 });
    if (request.status !== "OPEN") throw Object.assign(new Error(`Payment request is ${request.status.toLowerCase()}`), { statusCode: 409 });
    if (request.expiresAt && request.expiresAt <= new Date()) {
      await prisma.paymentRequest.update({ where: { id: requestId }, data: { status: "EXPIRED" } });
      throw Object.assign(new Error("Payment request has expired"), { statusCode: 409 });
    }
    if (request.userId === payerId) throw Object.assign(new Error("A payment request cannot be fulfilled by its owner"), { statusCode: 400 });
    const ownerAccount = await prisma.accountId.findUnique({ where: { userId: request.userId } });
    const transaction = await prisma.transaction.findFirst({ where: { id: transactionId, senderId: payerId } });
    if (transaction?.status !== "COMPLETED") {
      throw Object.assign(new Error("A completed transaction from the payer is required"), { statusCode: 400 });
    }
    if (transaction.recipientAccountId !== ownerAccount?.accountId || transaction.asset !== request.asset ||
        (request.amount !== null && request.amount?.toString() !== transaction.amount.toString())) {
      throw Object.assign(new Error("Transaction does not match this payment request"), { statusCode: 400 });
    }
    return prisma.paymentRequest.update({
      where: { id: requestId },
      data: { status: "FULFILLED", fulfilledTransactionId: transaction.id, fulfilledAt: new Date() },
    });
  },
};
