import prisma from '../../utils/prismaClient'

/**
 * Staff onboarding/tour state service.
 *
 * Stores per-staff, per-venue key/value records for UI onboarding state:
 *   - Tour banner dismissals
 *   - Checklist progress
 *   - Welcome tour auto-launch flags
 *
 * Replaces client-side localStorage so progress syncs across devices and
 * is available for analytics ("how many OWNERs finished the setup?").
 */

const MAX_PAYLOAD_BYTES = 8 * 1024 // 8 KB — plenty for onboarding state, guards against abuse

function sizeOfJson(payload: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(payload ?? null), 'utf8')
  } catch {
    return MAX_PAYLOAD_BYTES + 1
  }
}

/**
 * Returns all onboarding state records for a staff member at a venue,
 * flattened into a `{ [key]: state }` map for easy frontend consumption.
 */
export async function getOnboardingState(staffId: string, venueId: string): Promise<Record<string, unknown>> {
  const rows = await prisma.staffOnboardingState.findMany({
    where: { staffId, venueId },
    select: { key: true, state: true },
  })

  const map: Record<string, unknown> = {}
  for (const row of rows) {
    map[row.key] = row.state
  }
  return map
}

/**
 * Upserts a single onboarding state key for (staffId, venueId).
 * `state` is any JSON-serializable value — schema is intentionally freeform
 * because it's owned by the frontend feature that writes it.
 */
export async function setOnboardingState(
  staffId: string,
  venueId: string,
  key: string,
  state: unknown,
): Promise<{ key: string; state: unknown; updatedAt: Date }> {
  if (!key || typeof key !== 'string' || key.length > 200) {
    throw new Error('La clave del estado de onboarding es inválida')
  }

  if (sizeOfJson(state) > MAX_PAYLOAD_BYTES) {
    throw new Error('El estado excede el tamaño máximo permitido')
  }

  // Prisma's Json field accepts any JSON value (including primitives) — no wrapping needed.
  const row = await prisma.staffOnboardingState.upsert({
    where: { staffId_venueId_key: { staffId, venueId, key } },
    update: { state: state as any },
    create: { staffId, venueId, key, state: state as any },
    select: { key: true, state: true, updatedAt: true },
  })

  return { key: row.key, state: row.state, updatedAt: row.updatedAt }
}

/**
 * Clears a single onboarding state key. Useful for debugging / reset flows.
 */
export async function clearOnboardingState(staffId: string, venueId: string, key: string): Promise<void> {
  await prisma.staffOnboardingState
    .delete({
      where: { staffId_venueId_key: { staffId, venueId, key } },
    })
    .catch(() => {
      // Swallow "record not found" — idempotent delete.
    })
}
