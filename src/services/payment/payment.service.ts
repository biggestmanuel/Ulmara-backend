import { prisma } from "../../config/database.js";

export const paymentService = {
  async createRequest(userId: string, input: { asset?: string; symbol?: string; amount?: string; expiresAt?: string }) {
    const request = await prisma.paymentRequest.create({
      data: {
        userId,
        asset: input.asset ?? input.symbol ?? "ETH",
        amount: input.amount,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      },
    });
    return { requestId: request.id, link: `https://ulmara.app/pay/${request.id}` };
  },

  async getRequest(id: string) {
    const request = await prisma.paymentRequest.findUnique({
      where: { id },
      include: { user: { select: { name: true, photoUrl: true } } },
    });
    if (!request) throw Object.assign(new Error("Payment request not found"), { statusCode: 404 });

    if (request.expiresAt && request.expiresAt < new Date() && request.status === "OPEN") {
      await prisma.paymentRequest.update({ where: { id }, data: { status: "EXPIRED" } });
      request.status = "EXPIRED";
    }

    return request;
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
    if (!transaction || transaction.status !== "COMPLETED") {
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
