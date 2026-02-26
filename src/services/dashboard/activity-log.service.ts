// src/services/dashboard/activity-log.service.ts

/**
 * Activity Log Service
 *
 * Centralized utility for writing and querying audit trail entries.
 * - logAction(): Fire-and-forget writer — NEVER throws
 * - queryActivityLogs(): Paginated query for the API
 * - getDistinctActions(): Unique action strings for filter dropdowns
 */

import prisma from '../../utils/prismaClient'
import { Prisma } from '@prisma/client'
import logger from '../../config/logger'

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
 * Fire-and-forget audit log writer.
 * Wraps prisma.activityLog.create() in try/catch — NEVER throws.
 */
export function logAction(params: LogActionParams): void {
  prisma.activityLog
    .create({
      data: {
        staffId: params.staffId ?? null,
        venueId: params.venueId ?? null,
        action: params.action,
        entity: params.entity ?? null,
        entityId: params.entityId ?? null,
        data: params.data ?? undefined,
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
      },
    })
    .catch(error => {
      logger.error('[ActivityLog] Failed to write audit log', {
        action: params.action,
        entity: params.entity,
        error: error.message,
      })
    })
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

/**
 * Query activity logs for an organization with filters and pagination.
 * Fetches all org venue IDs, then queries by venueId IN (...).
 */
export async function queryActivityLogs(params: QueryActivityLogsParams): Promise<PaginatedActivityLogs> {
  const { organizationId, page = 1, pageSize = 25 } = params

  // Get all venue IDs for this organization
  const orgVenues = await prisma.venue.findMany({
    where: { organizationId },
    select: { id: true, name: true },
  })

  if (orgVenues.length === 0) {
    return { logs: [], pagination: { page, pageSize, total: 0, totalPages: 0 } }
  }

  const venueIds = orgVenues.map(v => v.id)
  const venueNameMap = new Map(orgVenues.map(v => [v.id, v.name]))

  // Build where clause
  const where: Record<string, unknown> = {
    venueId: params.venueId ? { equals: params.venueId } : { in: venueIds },
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
      orderBy: { createdAt: 'desc' },
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

  if (orgVenues.length === 0) return []

  const venueIds = orgVenues.map(v => v.id)

  const results = await prisma.activityLog.findMany({
    where: { venueId: { in: venueIds } },
    select: { action: true },
    distinct: ['action'],
    orderBy: { action: 'asc' },
  })

  return results.map(r => r.action)
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
      orderBy: { createdAt: 'desc' },
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
