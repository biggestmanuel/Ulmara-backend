import type { FastifyRequest, FastifyReply } from "fastify";
import {
  rampDepositSchema,
  rampWithdrawSchema,
} from "../utils/requestSchemas.js";
import { rampService } from "../services/ramp/ramp.service.js";
import {
  getRampProvider,
  getRampProviderName,
  getRampWebhookSignatureHeader,
} from "../services/ramp/providers/index.js";
import { successResponse, handleError } from "../utils/apiResponse.js";
import { referenceParamSchema } from "../utils/requestSchemas.js";
import { logger } from "../config/logger.js";

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export const rampController = {
  async deposit(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = rampDepositSchema.parse(request.body);
      return reply.code(201).send(successResponse(await rampService.deposit(request.userId!, body)));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async withdraw(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = rampWithdrawSchema.parse(request.body);
      return reply.code(201).send(successResponse(await rampService.withdraw(request.userId!, body)));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async getStatus(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { reference } = referenceParamSchema.parse(request.params);
      return reply.send(successResponse(await rampService.getStatus(request.userId!, reference)));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  /**
   * Provider webhook receiver.
   *
   * Order matters and is the whole security contract:
   *   1. read the RAW body (a re-serialised body would not match the
   *      signature),
   *   2. verify the signature BEFORE parsing or acting,
   *   3. only then map and apply, idempotently.
   *
   * Always answers 200 for a signature-valid delivery — including duplicates
   * — so the provider stops retrying.
   */
  async webhook(request: FastifyRequest, reply: FastifyReply) {
    const provider = getRampProviderName();
    const raw = request.rawBody ?? Buffer.from(JSON.stringify(request.body ?? {}));

    let signatureValid = false;
    let event;
    try {
      const signature = headerValue(request, getRampWebhookSignatureHeader());
      signatureValid = getRampProvider().verifyWebhookSignature(raw, signature);
    } catch (err) {
      logger.error(
        { event: "ramp_webhook_verify_error", provider, err: (err as Error).message },
        "Ramp webhook signature verification threw",
      );
      return reply.code(401).send({ success: false, message: "Invalid signature" });
    }

    if (!signatureValid) {
      logger.warn(
        { event: "ramp_webhook_bad_signature", provider, ip: request.ip },
        "Rejected a ramp webhook with an invalid or missing signature",
      );
      return reply.code(401).send({ success: false, message: "Invalid signature" });
    }

    try {
      event = getRampProvider().parseWebhook(raw, request.headers);
    } catch (err) {
      logger.warn(
        { event: "ramp_webhook_unparseable", provider, err: (err as Error).message },
        "Could not parse a verified ramp webhook",
      );
      return reply.code(400).send({ success: false, message: "Unsupported webhook payload" });
    }

    try {
      const result = await rampService.handleWebhook({
        provider,
        event,
        rawPayload: event.raw,
        signatureValid,
      });
      return reply.code(200).send({ success: true, applied: result.applied, reason: result.reason ?? null });
    } catch (err) {
      // A 5xx here makes the provider retry, which is the desired behaviour
      // for a genuine internal failure.
      logger.error({ event: "ramp_webhook_failed", provider, reference: event?.reference, err }, "Ramp webhook handling failed");
      return reply.code(500).send({ success: false, message: "Webhook processing failed" });
    }
  },
};
