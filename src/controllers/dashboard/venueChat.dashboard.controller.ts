import { Request, Response } from 'express'

import { deactivateVenueChat, generateActivationForVenue, getVenueChatStatus } from '@/services/venueChatAdmin.service'

// POST /api/v1/dashboard/venues/:venueId/chat/activation
// Mints a fresh activation token. Returns the RAW token only once — clients
// MUST capture it immediately because only the hash + last4 are stored.
// Any previously open token for this venue is invalidated server-side.
export async function postActivation(req: Request, res: Response) {
  const venueId = req.params.venueId
  const out = await generateActivationForVenue(venueId)
  return res.status(201).json(out)
}

// GET /api/v1/dashboard/venues/:venueId/chat/status
// Returns the current relay mode, opt-in phone, fallback phone, and any
// pending (unconsumed, non-expired) activation token's last4 + expiresAt.
export async function getChatStatus(req: Request, res: Response) {
  const venueId = req.params.venueId
  const status = await getVenueChatStatus(venueId)
  if (!status) return res.status(404).json({ error: 'not_found' })
  return res.status(200).json(status)
}

// POST /api/v1/dashboard/venues/:venueId/chat/deactivate
// Reverts the venue to WA_ME_FALLBACK mode, closes OPEN sessions, and
// invalidates any open activation tokens. Idempotent — calling on a venue
// that's already in WA_ME_FALLBACK is a no-op (close 0 sessions, update
// venue row, etc.).
export async function deactivate(req: Request, res: Response) {
  const venueId = req.params.venueId
  await deactivateVenueChat(venueId)
  return res.status(204).end()
}
