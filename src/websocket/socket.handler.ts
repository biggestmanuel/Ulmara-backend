import type { FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export async function registerWebsocketHandlers(app: FastifyInstance) {
  app.get("/ws", { websocket: true }, (connection, request) => {
    const { token } = request.query as { token?: string };
    if (!token) {
      connection.socket.close(1008, "Authentication required");
      return;
    }
    try {
      jwt.verify(token, env.JWT_SECRET);
    } catch {
      connection.socket.close(1008, "Invalid authentication token");
      return;
    }
    connection.socket.on("message", (message: Buffer) => {
      void message;
    });
  });
}
