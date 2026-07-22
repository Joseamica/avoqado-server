/**
 * Read-only gate for the reservation staff-aware rollout.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/preflight-reservation-staff-rollout.ts
 *
 * This script deliberately reports violations instead of repairing them. Every
 * row must be resolved explicitly by the release owner before continuing.
 */

import { Prisma, PrismaClient } from '@prisma/client'

export const reservationStaffPreflightQueries = [
  {
    key: 'reservation_missing_staff_venue',
    query: Prisma.sql`
      SELECT r.id AS "reservationId", r."confirmationCode", r."venueId", r."assignedStaffId" AS "staffId"
      FROM "Reservation" r
      LEFT JOIN "StaffVenue" sv
        ON sv."staffId" = r."assignedStaffId" AND sv."venueId" = r."venueId"
      WHERE r.status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
        AND r."assignedStaffId" IS NOT NULL
        AND r."endsAt" > (clock_timestamp() AT TIME ZONE 'UTC')
        AND sv.id IS NULL
      ORDER BY r.id
    `,
  },
  {
    key: 'class_session_missing_staff_venue',
    query: Prisma.sql`
      SELECT c.id AS "classSessionId", c."venueId", c."assignedStaffId" AS "staffId"
      FROM "ClassSession" c
      LEFT JOIN "StaffVenue" sv
        ON sv."staffId" = c."assignedStaffId" AND sv."venueId" = c."venueId"
      WHERE c.status = 'SCHEDULED'
        AND c."assignedStaffId" IS NOT NULL
        AND c."endsAt" > (clock_timestamp() AT TIME ZONE 'UTC')
        AND sv.id IS NULL
      ORDER BY c.id
    `,
  },
  {
    key: 'reservation_reservation_overlap',
    query: Prisma.sql`
      SELECT a.id AS "reservationAId", a."confirmationCode" AS "reservationACode", a."venueId" AS "venueAId",
             b.id AS "reservationBId", b."confirmationCode" AS "reservationBCode", b."venueId" AS "venueBId",
             a."assignedStaffId" AS "staffId", va."organizationId"
      FROM "Reservation" a
      JOIN "Venue" va ON va.id = a."venueId"
      JOIN "Reservation" b
        ON a.id < b.id
       AND b."assignedStaffId" = a."assignedStaffId"
       AND a."startsAt" < b."endsAt"
       AND a."endsAt" > b."startsAt"
      JOIN "Venue" vb ON vb.id = b."venueId" AND vb."organizationId" = va."organizationId"
      WHERE a.status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
        AND b.status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
        AND a."assignedStaffId" IS NOT NULL
        AND a."endsAt" > (clock_timestamp() AT TIME ZONE 'UTC')
        AND b."endsAt" > (clock_timestamp() AT TIME ZONE 'UTC')
      ORDER BY a.id, b.id
    `,
  },
  {
    key: 'reservation_class_session_overlap',
    query: Prisma.sql`
      SELECT r.id AS "reservationId", r."confirmationCode", r."venueId" AS "reservationVenueId",
             c.id AS "classSessionId", c."venueId" AS "classSessionVenueId",
             r."assignedStaffId" AS "staffId", vr."organizationId"
      FROM "Reservation" r
      JOIN "Venue" vr ON vr.id = r."venueId"
      JOIN "ClassSession" c
        ON c."assignedStaffId" = r."assignedStaffId"
       AND r."startsAt" < c."endsAt"
       AND r."endsAt" > c."startsAt"
      JOIN "Venue" vc ON vc.id = c."venueId" AND vc."organizationId" = vr."organizationId"
      WHERE r.status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
        AND c.status = 'SCHEDULED'
        AND r."assignedStaffId" IS NOT NULL
        AND r."endsAt" > (clock_timestamp() AT TIME ZONE 'UTC')
        AND c."endsAt" > (clock_timestamp() AT TIME ZONE 'UTC')
      ORDER BY r.id, c.id
    `,
  },
  {
    key: 'class_session_class_session_overlap',
    query: Prisma.sql`
      SELECT a.id AS "classSessionAId", a."venueId" AS "venueAId",
             b.id AS "classSessionBId", b."venueId" AS "venueBId",
             a."assignedStaffId" AS "staffId", va."organizationId"
      FROM "ClassSession" a
      JOIN "Venue" va ON va.id = a."venueId"
      JOIN "ClassSession" b
        ON a.id < b.id
       AND b."assignedStaffId" = a."assignedStaffId"
       AND a."startsAt" < b."endsAt"
       AND a."endsAt" > b."startsAt"
      JOIN "Venue" vb ON vb.id = b."venueId" AND vb."organizationId" = va."organizationId"
      WHERE a.status = 'SCHEDULED'
        AND b.status = 'SCHEDULED'
        AND a."assignedStaffId" IS NOT NULL
        AND a."endsAt" > (clock_timestamp() AT TIME ZONE 'UTC')
        AND b."endsAt" > (clock_timestamp() AT TIME ZONE 'UTC')
      ORDER BY a.id, b.id
    `,
  },
  {
    key: 'reservation_lead_product_mismatch',
    query: Prisma.sql`
      SELECT r.id AS "reservationId", r."confirmationCode", r."venueId",
             r."productId", (r."productIds")[1] AS "firstProductId"
      FROM "Reservation" r
      WHERE r.status IN ('PENDING', 'CONFIRMED')
        AND r."endsAt" > (clock_timestamp() AT TIME ZONE 'UTC')
        AND cardinality(r."productIds") > 0
        AND r."productId" IS DISTINCT FROM (r."productIds")[1]
      ORDER BY r.id
    `,
  },
] as const

export type ReservationStaffPreflightCategory = (typeof reservationStaffPreflightQueries)[number]['key']

type ActionableRow = Record<string, unknown>

export interface ReservationStaffPreflightDatabase {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>
}

export interface ReservationStaffPreflightResult {
  exitCode: 0 | 1
  counts: Record<ReservationStaffPreflightCategory, number>
}

const ACTIONABLE_FIELDS = new Set([
  'reservationId',
  'confirmationCode',
  'venueId',
  'staffId',
  'classSessionId',
  'reservationAId',
  'reservationACode',
  'venueAId',
  'reservationBId',
  'reservationBCode',
  'venueBId',
  'reservationVenueId',
  'classSessionVenueId',
  'classSessionAId',
  'classSessionBId',
  'organizationId',
  'productId',
  'firstProductId',
])

function actionableDetails(rows: ActionableRow[]): string {
  return rows
    .map(row =>
      Object.entries(row)
        .filter(([key, value]) => ACTIONABLE_FIELDS.has(key) && (typeof value === 'string' || typeof value === 'number'))
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(','),
    )
    .filter(Boolean)
    .join(' | ')
}

export async function runReservationStaffPreflight(
  database: ReservationStaffPreflightDatabase,
  writeLine: (line: string) => void = console.log,
): Promise<ReservationStaffPreflightResult> {
  const counts = {} as Record<ReservationStaffPreflightCategory, number>
  let hasViolations = false

  for (const definition of reservationStaffPreflightQueries) {
    const rows = await database.$queryRaw<ActionableRow[]>(definition.query)
    const count = rows.length
    counts[definition.key] = count
    hasViolations ||= count > 0
    const details = actionableDetails(rows)
    writeLine(`${definition.key} count=${count}${details ? ` rows=${details}` : ''}`)
  }

  return { exitCode: hasViolations ? 1 : 0, counts }
}

export function assertSafePreflightEnvironment(env: NodeJS.ProcessEnv): void {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL es obligatoria')
  if (env.NODE_ENV === 'test' && (!env.TEST_DATABASE_URL || env.DATABASE_URL !== env.TEST_DATABASE_URL)) {
    throw new Error('En NODE_ENV=test, DATABASE_URL debe coincidir exactamente con TEST_DATABASE_URL')
  }
}

async function main(): Promise<void> {
  assertSafePreflightEnvironment(process.env)
  const prisma = new PrismaClient()
  try {
    const result = await runReservationStaffPreflight(prisma)
    process.exitCode = result.exitCode
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  void main().catch(error => {
    const errorName = error instanceof Error ? error.name : 'UnknownError'
    console.error(`No se pudo ejecutar el preflight (${errorName}); no se realizó ninguna escritura.`)
    process.exitCode = 1
  })
}
