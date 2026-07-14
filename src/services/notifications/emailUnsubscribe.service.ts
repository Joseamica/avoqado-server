import { NotificationChannel, NotificationType } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { updateManyNotificationPreferences } from '../dashboard/notification.dashboard.service'
import type { EmailUnsubscribeCategory } from '../../utils/unsubscribeToken'

/**
 * Login-free email unsubscribe, tied to the recipient (staff) — not to whoever
 * is logged into the dashboard. Called by the public unsubscribe endpoint.
 *
 * "Unsubscribe from category X" = remove the EMAIL channel from every
 * notification type in that category for this (staffId, venueId), while keeping
 * the other channels (in-app) intact. A MISSING preference row means "email on"
 * by default (that's how the nightly job treats it), so we must CREATE a row
 * with EMAIL excluded to actually stop the mail.
 */

// Which notification types each email "category" turns off. Extend as more
// email streams get a one-click unsubscribe.
const CATEGORY_TYPES: Record<EmailUnsubscribeCategory, NotificationType[]> = {
  INVENTORY: [NotificationType.LOW_INVENTORY],
}

// Default channels a type has when no preference row exists yet (mirrors the
// dashboard defaults). Used to compute "what's left after removing EMAIL".
const DEFAULT_CHANNELS: Partial<Record<NotificationType, NotificationChannel[]>> = {
  [NotificationType.LOW_INVENTORY]: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
}

export const CATEGORY_LABELS: Record<EmailUnsubscribeCategory, string> = {
  INVENTORY: 'alertas de inventario',
}

export interface UnsubscribeContext {
  staffEmail: string
  staffFirstName: string | null
  venueName: string
  categoryLabel: string
}

/**
 * Look up who/what an unsubscribe token points at, for the confirmation page.
 * Returns null if the staff no longer exists.
 */
export async function getUnsubscribeContext(
  staffId: string,
  venueId: string,
  category: EmailUnsubscribeCategory,
): Promise<UnsubscribeContext | null> {
  const [staff, venue] = await Promise.all([
    prisma.staff.findUnique({ where: { id: staffId }, select: { email: true, firstName: true } }),
    prisma.venue.findUnique({ where: { id: venueId }, select: { name: true } }),
  ])
  if (!staff?.email) return null
  return {
    staffEmail: staff.email,
    staffFirstName: staff.firstName ?? null,
    venueName: venue?.name ?? '',
    categoryLabel: CATEGORY_LABELS[category],
  }
}

export interface UnsubscribeResult {
  affectedTypes: number
  alreadyUnsubscribed: boolean
}

/**
 * Turn off EMAIL for every type in `category` for this (staffId, venueId).
 * Atomic (single transaction via updateManyNotificationPreferences) and
 * idempotent — a second call with EMAIL already off is a no-op.
 */
export async function unsubscribeFromEmailCategory(
  staffId: string,
  venueId: string,
  category: EmailUnsubscribeCategory,
): Promise<UnsubscribeResult> {
  const types = CATEGORY_TYPES[category]

  const existing = await prisma.notificationPreference.findMany({
    where: { staffId, venueId, type: { in: types } },
    select: { type: true, channels: true },
  })
  const existingByType = new Map(existing.map(p => [p.type, p.channels]))

  const changes: Array<{ type: NotificationType; channels: NotificationChannel[] }> = []
  for (const type of types) {
    const current = existingByType.get(type) ?? DEFAULT_CHANNELS[type] ?? [NotificationChannel.IN_APP]
    const hadEmail = current.includes(NotificationChannel.EMAIL)
    const hasRow = existingByType.has(type)

    // No row + default already lacks EMAIL → nothing to persist (email is off).
    if (!hasRow && !hadEmail) continue
    // Row exists and EMAIL already absent → idempotent no-op.
    if (hasRow && !hadEmail) continue

    changes.push({ type, channels: current.filter(c => c !== NotificationChannel.EMAIL) })
  }

  if (changes.length > 0) {
    await updateManyNotificationPreferences(staffId, venueId, changes)
  }

  return { affectedTypes: changes.length, alreadyUnsubscribed: changes.length === 0 }
}
