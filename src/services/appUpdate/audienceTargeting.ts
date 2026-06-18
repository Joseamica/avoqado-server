// src/services/appUpdate/audienceTargeting.ts
//
// Pure audience-targeting logic for AppUpdate rollouts, shared by:
//  - the superadmin create/update controllers (validate/normalize the payload), and
//  - the public TPV check-update controller (build the Prisma filter).
//
// Kept dependency-free (only a type-only Prisma import) so it can be unit-tested
// without pulling in Firebase / Prisma client / Express.
import type { Prisma } from '@prisma/client'

/** The three ways an AppUpdate can be targeted (mirror of the AppUpdateTargetType enum). */
export type AppUpdateTargetTypeValue = 'ALL' | 'VENUES' | 'TERMINALS'

/**
 * Validate + normalize audience-targeting fields from a request body.
 * - ALL clears both lists (every terminal — today's behavior).
 * - VENUES keeps targetVenueIds only; requires at least one venue.
 * - TERMINALS keeps targetTerminalIds only; requires at least one terminal.
 * Non-string array entries are dropped. Returns `{ error }` on invalid input.
 */
export function normalizeTargeting(body: {
  targetType?: unknown
  targetVenueIds?: unknown
  targetTerminalIds?: unknown
}): { targetType: AppUpdateTargetTypeValue; targetVenueIds: string[]; targetTerminalIds: string[] } | { error: string } {
  const targetType = (body.targetType ?? 'ALL') as string
  if (!['ALL', 'VENUES', 'TERMINALS'].includes(targetType)) {
    return { error: 'Invalid targetType. Must be ALL, VENUES, or TERMINALS' }
  }

  const venueIds = Array.isArray(body.targetVenueIds) ? body.targetVenueIds.filter((v): v is string => typeof v === 'string') : []
  const terminalIds = Array.isArray(body.targetTerminalIds) ? body.targetTerminalIds.filter((v): v is string => typeof v === 'string') : []

  if (targetType === 'VENUES' && venueIds.length === 0) {
    return { error: 'targetType VENUES requiere al menos un venue en targetVenueIds' }
  }
  if (targetType === 'TERMINALS' && terminalIds.length === 0) {
    return { error: 'targetType TERMINALS requiere al menos una terminal en targetTerminalIds' }
  }

  return {
    targetType: targetType as AppUpdateTargetTypeValue,
    targetVenueIds: targetType === 'VENUES' ? venueIds : [],
    targetTerminalIds: targetType === 'TERMINALS' ? terminalIds : [],
  }
}

/**
 * Build the Prisma OR conditions that decide which AppUpdate rows apply to a
 * requesting terminal on GET /tpv/check-update.
 * - ALL always applies (default / today's behavior).
 * - VENUES applies only when the venue is known (from X-Venue-Id) and listed.
 * - TERMINALS applies only when the terminal is identified (X-Terminal-Serial → id) and listed.
 * An unknown terminal (no venue, no serial) matches ONLY ALL → fail-safe: it can never
 * receive a build scoped to a venue/terminal it doesn't belong to.
 */
export function buildAudienceConditions(venueId?: string, terminalId?: string): Prisma.AppUpdateWhereInput[] {
  const conditions: Prisma.AppUpdateWhereInput[] = [{ targetType: 'ALL' }]
  if (venueId) conditions.push({ targetType: 'VENUES', targetVenueIds: { has: venueId } })
  if (terminalId) conditions.push({ targetType: 'TERMINALS', targetTerminalIds: { has: terminalId } })
  return conditions
}
