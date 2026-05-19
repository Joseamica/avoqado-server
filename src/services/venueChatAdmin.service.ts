import { VenueChatMode } from '@prisma/client'

import { generateActivationToken, hashActivationToken, last4 } from '@/utils/activationToken'
import prisma from '@/utils/prismaClient'

const MAX_RETRIES = 3
const TOKEN_TTL_MINUTES = 30

export type ActivationGenerationResult = { token: string; expiresAt: Date; last4: string }

// Mint a new WhatsApp activation token for a venue. Invalidates any previous
// open (unconsumed, non-expired) tokens for the same venue inside a single
// transaction so the partial unique index — one open token per venue —
// stays consistent across concurrent admin clicks.
export async function generateActivationForVenue(venueId: string): Promise<ActivationGenerationResult> {
  return prisma.$transaction(async tx => {
    await tx.venueWhatsappActivation.updateMany({
      where: { venueId, consumedAt: null, invalidatedAt: null },
      data: { invalidatedAt: new Date() },
    })

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const token = generateActivationToken()
      const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60_000)
      try {
        await tx.venueWhatsappActivation.create({
          data: {
            venueId,
            tokenHash: hashActivationToken(token),
            tokenLast4: last4(token),
            expiresAt,
          },
        })
        return { token, expiresAt, last4: last4(token) }
      } catch (err: any) {
        // P2002 = tokenHash collision — astronomically rare, but retry just
        // in case (e.g., random source briefly biased in tests).
        if (err?.code !== 'P2002') throw err
      }
    }
    throw new Error('activation token generation: exhausted retries (P2002)')
  })
}

export type VenueChatStatus = {
  mode: VenueChatMode
  optInPhone: string | null
  optInAt: Date | null
  fallbackPhone: string | null
  pendingActivation: { tokenLast4: string; expiresAt: Date } | null
}

// Snapshot of the venue's WhatsApp relay state for the dashboard "Chat
// settings" page. `pendingActivation.tokenLast4` is the only piece of the
// token surfaced post-mint (the raw token is shown to the admin exactly once
// on generation, then is unrecoverable since the DB only keeps the hash).
export async function getVenueChatStatus(venueId: string): Promise<VenueChatStatus | null> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { whatsappContactMode: true, whatsappOptInPhone: true, whatsappOptInAt: true, phone: true },
  })
  if (!venue) return null

  const openActivation = await prisma.venueWhatsappActivation.findFirst({
    where: { venueId, consumedAt: null, invalidatedAt: null, expiresAt: { gt: new Date() } },
    select: { tokenLast4: true, expiresAt: true },
  })

  return {
    mode: venue.whatsappContactMode,
    optInPhone: venue.whatsappOptInPhone,
    optInAt: venue.whatsappOptInAt,
    fallbackPhone: venue.phone,
    pendingActivation: openActivation,
  }
}

// Hard-deactivate the venue's WhatsApp relay. Reverts the venue to
// WA_ME_FALLBACK mode and closes every OPEN session so the dashboard's
// active-chats list and the partial shortCode unique index stay clean. The
// venue's opt-in phone is cleared so a future re-activation requires a
// fresh ACTIVAR command from the venue's WhatsApp.
export async function deactivateVenueChat(venueId: string): Promise<void> {
  await prisma.$transaction(async tx => {
    await tx.venue.update({
      where: { id: venueId },
      data: { whatsappContactMode: 'WA_ME_FALLBACK', whatsappOptInPhone: null, whatsappOptInAt: null },
    })
    await tx.venueChatSession.updateMany({
      where: { venueId, status: 'OPEN' },
      data: { status: 'CLOSED_BY_VENUE_DEACTIVATION', closedAt: new Date() },
    })
    // Also invalidate any open activation tokens for this venue so a stale
    // token can't be redeemed after deactivation.
    await tx.venueWhatsappActivation.updateMany({
      where: { venueId, consumedAt: null, invalidatedAt: null },
      data: { invalidatedAt: new Date() },
    })
  })
}
