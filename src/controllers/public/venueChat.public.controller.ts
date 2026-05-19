import { Request, Response } from 'express'

import { appendCustomerMessage, createSessionWithIdempotency, listMessages, maybeUpdateCustomerSeen } from '@/services/venueChat.service'

// POST /api/v1/public/venue-chat/sessions
// Creates a brand-new chat session OR returns 409 on nonce reuse / venue not
// in RELAY mode. Per spec §Session creation idempotency.
export async function postSession(req: Request, res: Response) {
  const result = await createSessionWithIdempotency(req.body)
  if (result.kind === 'NONCE_COLLISION') return res.status(409).json({ error: 'nonce_collision' })
  if (result.kind === 'VENUE_NOT_AVAILABLE') return res.status(409).json({ error: 'venue_not_available' })

  return res.status(201).json({
    sessionId: result.sessionId,
    shortCode: result.shortCode,
    accessToken: result.accessToken,
    messages: [result.firstMessage],
  })
}

// GET /api/v1/public/venue-chat/sessions/:id/messages
// Cursor-paginated polling for the customer widget. `visible=true` (default
// is false-equivalent — only update on explicit true) signals the customer
// has the widget on-screen, which conditionally bumps lastCustomerSeenAt
// (throttled to once per 20s).
export async function getMessages(req: Request, res: Response) {
  const sessionId = req.params.id
  const after = (req.query.after as string | undefined) || undefined
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200)
  const visible = req.query.visible === 'true'

  // Polling responses must not be cached anywhere (proxies, browsers, CDN).
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.set('Vary', 'Authorization')

  try {
    const out = await listMessages({ sessionId, after, limit })
    if (visible) await maybeUpdateCustomerSeen(sessionId)
    return res.status(200).json(out)
  } catch (err: unknown) {
    if ((err as Error).message === 'Cursor inválido') return res.status(400).json({ error: 'invalid_cursor' })
    throw err
  }
}

// POST /api/v1/public/venue-chat/sessions/:id/messages
// Append a customer message. Idempotent via clientMessageId. Persistence is
// independent of relay success — if WhatsApp send fails, the row is still
// stored and the relay service will mark it FAILED for the next poll.
export async function postMessage(req: Request, res: Response) {
  const sessionId = req.params.id
  const row = await appendCustomerMessage({
    sessionId,
    body: req.body.body,
    clientMessageId: req.body.clientMessageId,
  })
  return res.status(201).json(row)
}

// GET /api/v1/public/venue-chat/sessions/:id
// Returns session metadata. Used by the widget on page load (after a refresh)
// to rehydrate from the accessToken stored in sessionStorage.
export async function getSession(req: Request, res: Response) {
  const session = (req as Request & { venueChatSession?: any }).venueChatSession
  return res.status(200).json({
    sessionId: session.id,
    shortCode: session.shortCode,
    customerName: session.customerName,
    sessionStatus: session.status,
    createdAt: session.createdAt,
  })
}
