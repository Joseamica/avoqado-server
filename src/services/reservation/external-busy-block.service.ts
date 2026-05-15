/**
 * ExternalBusyBlock conflict check for the reservation write/read paths
 * (Phase 1 — Task 23).
 *
 * `checkExternalBusyBlock` is the single source of truth used by:
 *   - `createReservation` (dashboard)
 *   - `updateReservation` (dashboard reschedule)
 *   - Public booking + slot-hold controllers
 *   - `getAvailableSlots` availability read path
 *
 * Overlap semantics (half-open intervals):
 *   - A block `[bStart, bEnd)` overlaps a candidate `[rStart, rEnd)` iff
 *     `bStart < rEnd AND bEnd > rStart`.
 *   - Adjacent intervals (block ends exactly when reservation starts) do NOT
 *     overlap.
 *
 * Scope semantics:
 *   - Always considers `venueId` (venue-master blocks apply to every slot).
 *   - When `staffId` is provided, additionally considers staff-personal blocks.
 *     A staff member's personal block applies across every venue that staff
 *     works at, because it represents their real-life schedule.
 *
 * This function is read-only and safe to call from any `Prisma.TransactionClient`
 * (it does not acquire row locks; the surrounding SERIALIZABLE transaction is
 * what gives us the strong consistency guarantees).
 */
import { Prisma } from '@prisma/client'

export interface CheckExternalBusyBlockArgs {
  venueId: string
  staffId?: string | null
  startsAt: Date
  endsAt: Date
}

/**
 * Returns the first overlapping `ExternalBusyBlock` row for the given
 * (venueId, staffId, [startsAt, endsAt)) window, or `null` when none exist.
 *
 * Caller is responsible for translating a non-null result into a user-facing
 * error (e.g. `ConflictError('Este horario fue bloqueado por un evento de
 * calendario externo')`).
 */
export async function checkExternalBusyBlock(tx: Prisma.TransactionClient, args: CheckExternalBusyBlockArgs) {
  const orClauses: Prisma.ExternalBusyBlockWhereInput[] = [{ venueId: args.venueId }]
  if (args.staffId) {
    orClauses.push({ staffId: args.staffId })
  }
  return tx.externalBusyBlock.findFirst({
    where: {
      OR: orClauses,
      startsAt: { lt: args.endsAt },
      endsAt: { gt: args.startsAt },
    },
  })
}
