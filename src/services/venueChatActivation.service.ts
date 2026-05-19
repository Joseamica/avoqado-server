import { hashActivationToken } from '@/utils/activationToken'
import prisma from '@/utils/prismaClient'

export type ActivationOutcome = 'ACTIVATED' | 'REPLAY_OK' | 'INVALID'

export interface ActivationResult {
  outcome: ActivationOutcome
  venueId?: string
}

// Process an "ACTIVAR <token>" WhatsApp message from a venue staff phone.
// Per spec §Onboarding command:
//   - INVALID: token unknown, expired, invalidated, OR already consumed by another
//     phone, OR consumed but venue is no longer in RELAY mode (deactivated since).
//   - REPLAY_OK: same token, same phone, venue still in RELAY mode with same opt-in
//     phone — happens when venue re-sends the activation message during a Meta retry
//     or by hand. Acknowledge without re-mutating state.
//   - ACTIVATED: first-time consumption; flips Venue to RELAY mode + records opt-in
//     phone + marks activation consumed atomically.
export async function handleActivationCommand(args: { token: string; senderPhone: string }): Promise<ActivationResult> {
  const tokenHash = hashActivationToken(args.token)
  const activation = await prisma.venueWhatsappActivation.findUnique({
    where: { tokenHash },
    include: { venue: true },
  })
  if (!activation) return { outcome: 'INVALID' }

  // Idempotent replay: same token + same phone + venue still in RELAY mode with same opt-in.
  if (
    activation.consumedAt &&
    activation.consumedByPhone === args.senderPhone &&
    activation.venue.whatsappContactMode === 'RELAY' &&
    activation.venue.whatsappOptInPhone === args.senderPhone
  ) {
    return { outcome: 'REPLAY_OK', venueId: activation.venueId }
  }

  // Fresh-activation validation: token must be unconsumed, not invalidated, not expired.
  if (activation.consumedAt || activation.invalidatedAt || activation.expiresAt < new Date()) {
    return { outcome: 'INVALID' }
  }

  // Atomic activation: mark consumed + flip venue mode + refresh contact window.
  await prisma.$transaction(async tx => {
    await tx.venueWhatsappActivation.update({
      where: { id: activation.id },
      data: { consumedAt: new Date(), consumedByPhone: args.senderPhone },
    })
    await tx.venue.update({
      where: { id: activation.venueId },
      data: {
        whatsappContactMode: 'RELAY',
        whatsappOptInPhone: args.senderPhone,
        whatsappOptInAt: new Date(),
      },
    })
    await tx.whatsappContactWindow.upsert({
      where: { phone: args.senderPhone },
      create: { phone: args.senderPhone, lastInboundAt: new Date() },
      update: { lastInboundAt: new Date() },
    })
  })

  return { outcome: 'ACTIVATED', venueId: activation.venueId }
}
