import { Prisma, TerminalStatus, TerminalType } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { computeTerminalMigration, migrationCommandWhere } from './terminals.superadmin.service'
import { ACTIVATABLE_TERMINAL_TYPES, toDeviceManagementDto } from '../device-capabilities.service'

export interface TpvFleetFilters {
  page?: number
  pageSize?: number
  search?: string
  statuses?: TerminalStatus[]
  types?: TerminalType[]
  connection?: 'all' | 'online' | 'offline' | 'pending'
}

/** Dedicated paginated TPV inventory; the legacy all-device contract stays intact. */
export async function getTpvFleet(filters: TpvFleetFilters = {}) {
  const page = Math.max(1, Math.floor(filters.page || 1))
  const pageSize = Math.min(100, Math.max(1, Math.floor(filters.pageSize || 25)))
  const now = new Date()
  const cutoff = new Date(now.getTime() - 120_000)
  const base: Prisma.TerminalWhereInput = { type: { in: [...ACTIVATABLE_TERMINAL_TYPES] } }
  const online: Prisma.TerminalWhereInput = { lastHeartbeat: { gt: cutoff, lte: now } }
  const offline: Prisma.TerminalWhereInput = {
    OR: [{ lastHeartbeat: null }, { lastHeartbeat: { lte: cutoff } }, { lastHeartbeat: { gt: now } }],
  }
  const pending: Prisma.TerminalWhereInput = { status: 'PENDING_ACTIVATION', activatedAt: null }
  const where: Prisma.TerminalWhereInput = { ...base }
  if (filters.types?.length) where.type = { in: filters.types.filter(t => ACTIVATABLE_TERMINAL_TYPES.some(type => type === t)) }
  if (filters.statuses?.length) where.status = { in: filters.statuses }
  const search = filters.search?.trim()
  if (search)
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { serialNumber: { contains: search, mode: 'insensitive' } },
      { venue: { name: { contains: search, mode: 'insensitive' } } },
    ]
  if (filters.connection === 'online') Object.assign(where, online)
  if (filters.connection === 'offline') where.AND = [offline, { NOT: pending }]
  if (filters.connection === 'pending') where.AND = [pending]

  const [rows, total, fleetTotal, onlineCount, offlineCount, pendingCount, maintenance] = await Promise.all([
    prisma.terminal.findMany({
      where,
      take: pageSize,
      skip: (page - 1) * pageSize,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        venue: { select: { id: true, name: true, slug: true } },
        commandQueue: {
          where: {
            ...migrationCommandWhere(),
            payload: { path: ['migration', 'toVenueId'], not: Prisma.DbNull },
          },
          take: 1,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true, createdAt: true, payload: true, status: true },
        },
      },
    }),
    prisma.terminal.count({ where }),
    prisma.terminal.count({ where: base }),
    prisma.terminal.count({ where: { ...base, ...online } }),
    prisma.terminal.count({ where: { ...base, ...offline, status: 'ACTIVE' } }),
    prisma.terminal.count({ where: { ...base, ...pending } }),
    prisma.terminal.count({ where: { ...base, status: 'MAINTENANCE' } }),
  ])
  return {
    data: rows.map(({ commandQueue, commandTokenHash: _credential, ...terminal }) => ({
      ...toDeviceManagementDto(terminal),
      migration: computeTerminalMigration(commandQueue[0], terminal.lastActivationStatusCheckAt, terminal.commandSessionId),
    })),
    total,
    page,
    pageSize,
    stats: { total: fleetTotal, online: onlineCount, offline: offlineCount, pending: pendingCount, maintenance },
  }
}
