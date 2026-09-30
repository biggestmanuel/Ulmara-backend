// Shared event names emitted over the websocket connection
export const WS_EVENTS = {
  TRANSACTION_UPDATED: "transaction:updated",
  BALANCE_UPDATED: "balance:updated",
  RAMP_UPDATED: "ramp:updated",
} as const;

export type WsEventName = (typeof WS_EVENTS)[keyof typeof WS_EVENTS];

/** Redis pub/sub channel carrying user-scoped events between processes. */
export const WS_PUBSUB_CHANNEL = "ulmara:ws:user-events";

export interface UserEvent {
  /** Recipient. The socket room is derived from this server-side. */
  userId: string;
  event: WsEventName;
  payload: unknown;
}
