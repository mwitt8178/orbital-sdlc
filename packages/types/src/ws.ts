import { z } from 'zod'

/** Per Primitives §11 — UI ↔ orchestrator WebSocket envelope. */
export const WSTypeSchema = z.enum(['event', 'snapshot', 'ack', 'error', 'ping', 'pong'])

export const WSMessageSchema = z.object({
  ws_message_id: z.string(),
  ws_type: WSTypeSchema,
  cursor: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
  trace_id: z.string(),
})

export type WSMessage = z.infer<typeof WSMessageSchema>
