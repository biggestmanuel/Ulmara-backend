import pino from "pino";
import { env } from "./env.js";

/**
 * Application logger (pino).
 *
 * This is the system log of record and is configured in every environment.
 * Sentry augments it from config/sentry.ts — deliberately NOT imported here,
 * because sentry.ts needs this logger for its own crash handlers and a
 * direct import would create a cycle.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  transport:
    env.NODE_ENV === "development"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
          },
        }
      : undefined,
});
