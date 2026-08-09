// src/services/dashboard/activity-log.service.ts

/**
 * Activity Log Service
 *
 * Centralized utility for writing and querying audit trail entries.
 * - logAction(): Best-effort writer — NEVER throws
 * - queryActivityLogs(): Paginated query for the API
 * - getDistinctActions(): Unique action strings for filter dropdowns
 */

import prisma from '../../utils/prismaClient'
import { Prisma } from '@prisma/client'
import logger from '../../config/logger'
import { fromZonedTime } from 'date-fns-tz'

export interface LogActionParams {
  staffId?: string | null
  venueId?: string | null
  action: string
  entity?: string
  entityId?: string
  data?: Prisma.InputJsonValue
  ipAddress?: string
  userAgent?: string
}

/**
 * Sentinel strings callers pass as the actor of an action when the trigger
 * is not a real staff user. Persisting these would violate the staffId FK,
 * so we normalize them to null here.
 */
const ACTOR_SENTINELS = new Set(['SYSTEM', 'CUSTOMER', 'PUBLIC', 'WEBHOOK'])

/**
 * Best-effort audit log writer.
 * Wraps prisma.activityLog.create() in try/catch — NEVER throws.
 * Callers may await it when they need audit persistence attempted before
 * returning a response.
 */
export async function logAction(params: LogActionParams): Promise<void> {
  try {
    // Normalize sentinel actor strings (SYSTEM, CUSTOMER, etc.) to null so we
    // don't trip the ActivityLog_staffId_fkey constraint. The action itself
    // (e.g. RESERVATION_NO_SHOW) records what happened; the absence of staffId
    // already signals "no human did this".
    const staffId = params.staffId && !ACTOR_SENTINELS.has(params.staffId) ? params.staffId : null

    await prisma.activityLog.create({
      data: {
        staffId,
        venueId: params.venueId ?? null,
        action: params.action,
        entity: params.entity ?? null,
        entityId: params.entityId ?? null,
        data: params.data ?? undefined,
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
      },
    })
  } catch (error) {
    logger.error('[ActivityLog] Failed to write audit log', {
      action: params.action,
      entity: params.entity,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

export interface QueryActivityLogsParams {
  organizationId: string
  venueId?: string
  staffId?: string
  action?: string
  entity?: string
  search?: string
  startDate?: string
  endDate?: string
  page?: number
  pageSize?: number
}

export interface ActivityLogEntry {
  id: string
  action: string
  entity: string | null
  entityId: string | null
  data: unknown
  ipAddress: string | null
  createdAt: Date
  staff: { id: string; firstName: string; lastName: string } | null
  venueName: string
}

export interface PaginatedActivityLogs {
  logs: ActivityLogEntry[]
  pagination: {
    page: number
    pageSize: number
    total: number
    totalPages: number
  }
}

/** Build the authoritative tenant predicate shared by organization list/dropdown queries. */
export function buildOrganizationActivityLogTenantScope(organizationId: string, venueIds: string[]): Prisma.ActivityLogWhereInput {
  // Classified rows use organizationId; only legacy null-attribution rows may
  // fall back to the organization's current venue set.
  return {
    OR: [{ organizationId }, { organizationId: null, venueId: { in: venueIds } }],
  }
}

/** Build organization scope and user filters without allowing either OR to replace the other. */
export function buildOrganizationActivityLogWhere(params: QueryActivityLogsParams, venueIds: string[]): Prisma.ActivityLogWhereInput {
  const and: Prisma.ActivityLogWhereInput[] = [buildOrganizationActivityLogTenantScope(params.organizationId, venueIds)]

  if (params.venueId) {
    and.push({ venueId: params.venueId })
    // An explicit venue filter must itself belong to the route organization;
    // this remains defense-in-depth even for newly classified rows.
    and.push({ venueId: { in: venueIds } })
  }
  if (params.staffId) and.push({ staffId: params.staffId })
  if (params.action) and.push({ action: params.action })
  if (params.entity) and.push({ entity: params.entity })
  if (params.search) {
    and.push({
      OR: [
        { action: { contains: params.search, mode: 'insensitive' } },
        { entity: { contains: params.search, mode: 'insensitive' } },
        { entityId: { contains: params.search, mode: 'insensitive' } },
      ],
    })
  }
  if (params.startDate || params.endDate) {
    const createdAt: Prisma.DateTimeFilter = {}
    if (params.startDate) createdAt.gte = new Date(params.startDate)
    if (params.endDate) createdAt.lte = new Date(params.endDate)
    and.push({ createdAt })
  }

  return { AND: and }
}

/** Query activity logs for one organization with classified + legacy compatibility. */
export async function queryActivityLogs(params: QueryActivityLogsParams): Promise<PaginatedActivityLogs> {
  const { organizationId, page = 1, pageSize = 25 } = params

  const orgVenues = await prisma.venue.findMany({
    where: { organizationId },
    select: { id: true, name: true },
  })
  const venueIds = orgVenues.map(v => v.id)
  const venueNameMap = new Map(orgVenues.map(v => [v.id, v.name]))
  // No zero-venue early return: H1 organization-level audit rows have no venue
  // and must remain visible to the corporate audit screen.
  const where = buildOrganizationActivityLogWhere(params, venueIds)

  // Count + fetch in parallel
  const [total, logs] = await Promise.all([
    prisma.activityLog.count({ where }),
    prisma.activityLog.findMany({
      where,
      include: {
        staff: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
      // `id` is the TIEBREAK — keep it. Audit rows are written in bursts (one request touching
      // several entities, a bulk import, a fan-out over a venue's staff), so many land on a
      // byte-identical `createdAt`: prod holds groups of up to 71 across 15,508 rows. Ordering on
      // `createdAt` alone lets Postgres arrange those ties freely, and this list is read
      // page-by-page — a tie group straddling a page boundary drops rows from the audit trail,
      // which is exactly what an auditor cannot afford to silently miss. (Asana 1217127206664238)
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])

  // Enrich with venue names
  const enrichedLogs: ActivityLogEntry[] = logs.map(log => ({
    id: log.id,
    action: log.action,
    entity: log.entity,
    entityId: log.entityId,
    data: log.data,
    ipAddress: log.ipAddress,
    createdAt: log.createdAt,
    staff: log.staff,
    venueName: log.venueId ? venueNameMap.get(log.venueId) || 'Unknown' : 'Organization',
  }))

  return {
    logs: enrichedLogs,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  }
}

/**
 * Get distinct action types for an organization's venues.
 * Used for filter dropdowns.
 */
export async function getDistinctActions(organizationId: string): Promise<string[]> {
  const orgVenues = await prisma.venue.findMany({
    where: { organizationId },
    select: { id: true },
  })

  const venueIds = orgVenues.map(v => v.id)

  const results = await prisma.activityLog.findMany({
    // Reusing the exact tenant predicate keeps dropdown values from disclosing
    // actions that the corresponding organization list can never display.
    where: buildOrganizationActivityLogTenantScope(organizationId, venueIds),
    select: { action: true },
    distinct: ['action'],
    orderBy: { action: 'asc' },
  })

  return results.map(r => r.action)
}

// ==========================================
// VENUE-SCOPED — Owner audit log (single venue)
// ==========================================

export interface QueryVenueActivityLogsParams {
  venueId: string
  staffId?: string
  action?: string
  entity?: string
  search?: string
  startDate?: string
  endDate?: string
  page?: number
  pageSize?: number
}

/**
 * The filter set, in ONE place. The listing and the export must never diverge: an export
 * that quietly matches a different set of rows than the screen the user is looking at is a
 * bug nobody reports, because the file looks plausible.
 */
export function buildVenueActivityLogWhere(params: QueryVenueActivityLogsParams, venueTimezone?: string | null): Record<string, unknown> {
  const where: Record<string, unknown> = { venueId: params.venueId }
  if (params.staffId) where.staffId = params.staffId
  if (params.action) where.action = params.action
  if (params.entity) where.entity = params.entity
  if (params.search) {
    where.OR = [
      { action: { contains: params.search, mode: 'insensitive' } },
      { entity: { contains: params.search, mode: 'insensitive' } },
      { entityId: { contains: params.search, mode: 'insensitive' } },
    ]
  }
  if (params.startDate || params.endDate) {
    // Parse the bare YYYY-MM-DD in the VENUE timezone (pass a STRING, not new Date()) so a
    // venue-local day range is correct under any host TZ (prod runs UTC). See critical-warnings.md.
    const venueTz = venueTimezone || 'America/Mexico_City'
    const createdAt: Record<string, Date> = {}
    if (params.startDate) createdAt.gte = fromZonedTime(`${params.startDate}T00:00:00.000`, venueTz)
    if (params.endDate) createdAt.lte = fromZonedTime(`${params.endDate}T23:59:59.999`, venueTz)
    where.createdAt = createdAt
  }
  return where
}

/** Query activity logs for ONE venue with filters + pagination. */
export async function queryVenueActivityLogs(params: QueryVenueActivityLogsParams): Promise<PaginatedActivityLogs> {
  const { venueId, page = 1, pageSize = 25 } = params

  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { id: true, name: true, timezone: true } })
  if (!venue) {
    return { logs: [], pagination: { page, pageSize, total: 0, totalPages: 0 } }
  }

  const where = buildVenueActivityLogWhere(params, venue.timezone)

  const [total, logs] = await Promise.all([
    prisma.activityLog.count({ where: where as any }),
    prisma.activityLog.findMany({
      where: where as any,
      include: { staff: { select: { id: true, firstName: true, lastName: true } } },
      // `id` is the TIEBREAK — see `queryActivityLogs` above; this is the owner audit screen.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])

  const enrichedLogs: ActivityLogEntry[] = logs.map(log => ({
    id: log.id,
    action: log.action,
    entity: log.entity,
    entityId: log.entityId,
    data: log.data,
    ipAddress: log.ipAddress,
    createdAt: log.createdAt,
    staff: log.staff,
    venueName: venue.name,
  }))

  return { logs: enrichedLogs, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } }
}

/**
 * Every matching row for an export, capped. Deliberately NOT paginated: an export that
 * silently returns page 1 is worse than one that refuses, so the caller counts first and
 * rejects over the cap rather than truncating.
 *
 * `orderBy` carries `id` as a tiebreaker — two rows written in the same millisecond would
 * otherwise come back in arbitrary order, and a file whose row order changes between
 * downloads is indefensible in front of an auditor.
 */
export async function fetchVenueActivityLogsForExport(params: QueryVenueActivityLogsParams & { cap: number }): Promise<ActivityLogEntry[]> {
  const venue = await prisma.venue.findUnique({ where: { id: params.venueId }, select: { name: true, timezone: true } })
  if (!venue) return []

  const logs = await prisma.activityLog.findMany({
    where: buildVenueActivityLogWhere(params, venue.timezone),
    include: { staff: { select: { id: true, firstName: true, lastName: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: params.cap,
  })

  return logs.map(log => ({
    id: log.id,
    action: log.action,
    entity: log.entity,
    entityId: log.entityId,
    data: log.data,
    ipAddress: log.ipAddress,
    createdAt: log.createdAt,
    staff: log.staff,
    venueName: venue.name,
  }))
}

/** Row count for the same filters, so the caller can refuse before building a huge file. */
export async function countVenueActivityLogsForExport(params: QueryVenueActivityLogsParams): Promise<number> {
  const venue = await prisma.venue.findUnique({ where: { id: params.venueId }, select: { timezone: true } })
  return prisma.activityLog.count({ where: buildVenueActivityLogWhere(params, venue?.timezone) as never })
}

/** Distinct action strings for ONE venue (filter dropdown). */
export async function getVenueDistinctActions(venueId: string): Promise<string[]> {
  const results = await prisma.activityLog.findMany({
    where: { venueId },
    select: { action: true },
    distinct: ['action'],
    orderBy: { action: 'asc' },
  })
  return results.map(r => r.action)
}

/** Distinct entity strings for ONE venue (filter dropdown). */
export async function getVenueDistinctEntities(venueId: string): Promise<string[]> {
  const results = await prisma.activityLog.findMany({
    where: { venueId, entity: { not: null } },
    select: { entity: true },
    distinct: ['entity'],
    orderBy: { entity: 'asc' },
  })
  return results.map(r => r.entity!).filter(Boolean)
}

// ==========================================
// SUPERADMIN — Global Activity Logs
// ==========================================

export interface SuperadminQueryActivityLogsParams {
  organizationId?: string
  venueId?: string
  staffId?: string
  action?: string
  entity?: string
  search?: string
  startDate?: string
  endDate?: string
  page?: number
  pageSize?: number
}

export interface SuperadminActivityLogEntry extends ActivityLogEntry {
  venueId: string | null
  organizationName: string | null
}

export interface PaginatedSuperadminActivityLogs {
  logs: SuperadminActivityLogEntry[]
  pagination: {
    page: number
    pageSize: number
    total: number
    totalPages: number
  }
}

/**
 * Query activity logs across ALL venues (superadmin only).
 * Optionally filter by organization or venue.
 */
export async function querySuperadminActivityLogs(params: SuperadminQueryActivityLogsParams): Promise<PaginatedSuperadminActivityLogs> {
  const { page = 1, pageSize = 50 } = params

  // Build where clause (no org scoping — all logs visible)
  const where: Record<string, unknown> = {}

  // If filtering by org, get that org's venue IDs
  if (params.organizationId) {
    const orgVenues = await prisma.venue.findMany({
      where: { organizationId: params.organizationId },
      select: { id: true },
    })
    where.venueId = { in: orgVenues.map(v => v.id) }
  }

  if (params.venueId) {
    where.venueId = params.venueId
  }

  if (params.staffId) {
    where.staffId = params.staffId
  }

  if (params.action) {
    where.action = params.action
  }

  if (params.entity) {
    where.entity = params.entity
  }

  if (params.search) {
    where.OR = [
      { action: { contains: params.search, mode: 'insensitive' } },
      { entity: { contains: params.search, mode: 'insensitive' } },
      { entityId: { contains: params.search, mode: 'insensitive' } },
    ]
  }

  if (params.startDate || params.endDate) {
    const createdAt: Record<string, Date> = {}
    if (params.startDate) createdAt.gte = new Date(params.startDate)
    if (params.endDate) createdAt.lte = new Date(params.endDate)
    where.createdAt = createdAt
  }

  // Count + fetch in parallel
  const [total, logs] = await Promise.all([
    prisma.activityLog.count({ where: where as any }),
    prisma.activityLog.findMany({
      where: where as any,
      include: {
        staff: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
      // `id` is the TIEBREAK — see `queryActivityLogs` above. Same bulk-write ties, no venue scoping.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])

  // Collect unique venueIds to batch-fetch venue + org names
  const venueIds = [...new Set(logs.map(l => l.venueId).filter(Boolean))] as string[]
  const venues =
    venueIds.length > 0
      ? await prisma.venue.findMany({
          where: { id: { in: venueIds } },
          select: { id: true, name: true, organization: { select: { name: true } } },
        })
      : []

  const venueMap = new Map(venues.map(v => [v.id, { name: v.name, orgName: v.organization?.name ?? null }]))

  const enrichedLogs: SuperadminActivityLogEntry[] = logs.map(log => {
    const venueInfo = log.venueId ? venueMap.get(log.venueId) : null
    return {
      id: log.id,
      action: log.action,
      entity: log.entity,
      entityId: log.entityId,
      data: log.data,
      ipAddress: log.ipAddress,
      createdAt: log.createdAt,
      staff: log.staff,
      venueId: log.venueId,
      venueName: venueInfo?.name ?? (log.venueId ? 'Unknown' : 'Organization'),
      organizationName: venueInfo?.orgName ?? null,
    }
  })

  return {
    logs: enrichedLogs,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  }
}

/**
 * Get distinct action types across ALL venues (superadmin only).
 */
export async function getSuperadminDistinctActions(): Promise<string[]> {
  const results = await prisma.activityLog.findMany({
    select: { action: true },
    distinct: ['action'],
    orderBy: { action: 'asc' },
  })

  return results.map(r => r.action)
}

/**
 * Get distinct entities across ALL venues (superadmin only).
 */
export async function getSuperadminDistinctEntities(): Promise<string[]> {
  const results = await prisma.activityLog.findMany({
    where: { entity: { not: null } },
    select: { entity: true },
    distinct: ['entity'],
    orderBy: { entity: 'asc' },
  })

  return results.map(r => r.entity!).filter(Boolean)
}
