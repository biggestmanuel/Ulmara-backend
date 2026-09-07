/**
 * controllers/wallet/registerWallets.controller.ts
 *
 * Wire into your existing wallet.controller.ts / wallet.routes.ts as
 * POST /api/wallet/register (auth-protected — requires session middleware).
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { registerWallets } from '../services/wallet/registerWallets.service.js';

const addressSchema = z.object({
  chain: z.enum(['ethereum', 'bsc', 'base', 'polygon', 'tron', 'solana', 'ton']),
  address: z.string().min(10).max(128),
});

const registerWalletsBodySchema = z.object({
  addresses: z.array(addressSchema).min(1),
});

export async function registerWalletsHandler(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const parsed = registerWalletsBodySchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      error: 'Invalid request body',
      details: parsed.error.flatten(),
    });
  }

  // Assumes your auth middleware attaches the authenticated user to the request.
  const userId = (request as any).user?.id;
  if (!userId) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  try {
    const result = await registerWallets({
      userId,
      addresses: parsed.data.addresses,
    });
    return reply.status(200).send(result);
  } catch (err: any) {
    request.log.error(err);
    return reply.status(400).send({ error: err.message ?? 'Wallet registration failed' });
  }
}
