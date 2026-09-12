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
};
