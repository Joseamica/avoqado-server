/**
 * The CRM's reports and its CSV export (spec 2026-10-30 §5.7, plan task 9).
 *
 * Every number is an aggregate the database computes (`groupBy`, or a `GROUP BY` for the month and week buckets Prisma
 * cannot group by): nothing is loaded to be counted here. Both read only what the caller may see (`scopeWhere`), and
 * archived accounts are out of the reports (spec §5.2). Months and weeks are Mexico City's, wherever the server runs.
 */
import { Prisma } from '@prisma/client'
import { fromZonedTime } from 'date-fns-tz'
import { ForbiddenError, ValidationError } from '../../errors/AppError'
import { DEFAULT_TIMEZONE, formatInVenueTimezone } from '../../utils/datetime'
import prisma from '../../utils/prismaClient'
import { localWallClock, utcTs } from '../../utils/sqlDates'
import { logAction } from '../dashboard/activity-log.service'
import { celdaCsv } from '../giftCards/giftCardReports.service'
import { scopeWhere, type CrmAccess } from './access.service'
import { accountsWhere, listLostReasons, listStages, staffNames, staleWhereFor, type AccountFilters } from './accounts.service'

const TZ = DEFAULT_TIMEZONE
const DAY_MS = 86_400_000
/** A year and a day: a leap year fits, two years do not (the week buckets stay ~53 per person). */
const MAX_RANGE_MS = 367 * DAY_MS
const EXPORT_CAP = 10_000
const EXPORT_PAGE = 1_000

// ── Reports ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `scopeWhere(access, 'ver')` written in SQL over the account aliased `a`, for the bucketed queries. The same three
 * answers: everyone, mine plus the unowned, or nothing.
 */
function scopeSql(access: CrmAccess): Prisma.Sql {
  if (access.ver === 'todos') return Prisma.sql`TRUE`
  if (access.ver === 'propios') return Prisma.sql`(a."ownerStaffId" = ${access.staffId} OR a."ownerStaffId" IS NULL)`
  return Prisma.sql`FALSE`
}

/** «desde»–«hasta», whole days on Mexico City's calendar, as instants. */
function teamRange(desde: string, hasta: string): { from: Date; to: Date } {
  const from = fromZonedTime(`${desde}T00:00:00.000`, TZ)
  const to = fromZonedTime(`${hasta}T23:59:59.999`, TZ)
  if (from > to) throw new ValidationError('La fecha inicial va antes de la final', 'CRM_RANGO_INVALIDO')
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw new ValidationError('El rango es de un año como máximo', 'CRM_RANGO_INVALIDO')
  return { from, to }
}

type Counted = { _count: { _all: number } }

const sumOf = (rows: Counted[]) => rows.reduce((sum, row) => sum + row._count._all, 0)

/** Won or lost per month: `wonAt` and `lostAt` are only set while the account is in that kind of stage. */
function byMonth(column: 'wonAt' | 'lostAt', access: CrmAccess, from: Date, to: Date) {
  const col = Prisma.raw(`a."${column}"`)
  // `GROUP BY 1`: the bucket's zone travels as a bind, and Postgres would not match two binds as the same expression.
  return prisma.$queryRaw<Array<{ mes: string; total: number }>>(Prisma.sql`
    SELECT to_char(date_trunc('month', ${localWallClock(TZ, col)}), 'YYYY-MM') AS "mes", COUNT(*)::int AS "total"
    FROM "CrmAccount" a
    WHERE ${col} >= ${utcTs(from)} AND ${col} <= ${utcTs(to)} AND a."archivedAt" IS NULL AND ${scopeSql(access)}
    GROUP BY 1
    ORDER BY 1`)
}

/** Activities done, per person who did them and per week (Monday to Sunday, Mexico City). */
function activitiesByWeek(access: CrmAccess, from: Date, to: Date) {
  return prisma.$queryRaw<Array<{ staffId: string | null; semana: string; total: number }>>(Prisma.sql`
    SELECT act."doneById" AS "staffId",
           to_char(date_trunc('week', ${localWallClock(TZ, Prisma.raw('act."doneAt"'))}), 'YYYY-MM-DD') AS "semana",
           COUNT(*)::int AS "total"
    FROM "CrmActivity" act
    JOIN "CrmAccount" a ON a."id" = act."accountId"
    WHERE act."doneAt" >= ${utcTs(from)} AND act."doneAt" <= ${utcTs(to)} AND a."archivedAt" IS NULL AND ${scopeSql(access)}
    GROUP BY 1, 2
    ORDER BY 2, 1`)
}

/**
 * The reports (spec §5.7): by stage, how many there are and how many are stale (today, whatever the range); won and lost
 * in the range, by month, reason, owner and source; activities done by person and week.
 */
export async function getReports(access: CrmAccess, input: { desde: string; hasta: string }, now = new Date()) {
  const { from, to } = teamRange(input.desde, input.hasta)
  const [stages, reasons] = await Promise.all([listStages(), listLostReasons()])

  const visible = (...more: Prisma.CrmAccountWhereInput[]): Prisma.CrmAccountWhereInput => ({
    AND: [scopeWhere(access, 'ver'), { archivedAt: null }, ...more],
  })
  const won = visible({ wonAt: { gte: from, lte: to } })
  const lost = visible({ lostAt: { gte: from, lte: to } })

  const [byStage, staleByStage, wonByOwner, wonBySource, lostByReason, lostByOwner, lostBySource, wonByMonth, lostByMonth, activities] =
    await Promise.all([
      prisma.crmAccount.groupBy({ by: ['stageId'], where: visible(), _count: { _all: true } }),
      prisma.crmAccount.groupBy({ by: ['stageId'], where: visible(staleWhereFor(stages, now)), _count: { _all: true } }),
      prisma.crmAccount.groupBy({ by: ['ownerStaffId'], where: won, _count: { _all: true } }),
      prisma.crmAccount.groupBy({ by: ['source'], where: won, _count: { _all: true } }),
      prisma.crmAccount.groupBy({ by: ['lostReasonId'], where: lost, _count: { _all: true } }),
      prisma.crmAccount.groupBy({ by: ['ownerStaffId'], where: lost, _count: { _all: true } }),
      prisma.crmAccount.groupBy({ by: ['source'], where: lost, _count: { _all: true } }),
      byMonth('wonAt', access, from, to),
      byMonth('lostAt', access, from, to),
      activitiesByWeek(access, from, to),
    ])

  const names = await staffNames([
    ...wonByOwner.map(row => row.ownerStaffId),
    ...lostByOwner.map(row => row.ownerStaffId),
    ...activities.map(row => row.staffId),
  ])
  const person = (id: string | null) => (id ? { id, name: names.get(id) ?? null } : null)
  const reasonNames = new Map(reasons.map(reason => [reason.id, reason.name]))
  const perOwner = (rows: Array<Counted & { ownerStaffId: string | null }>) =>
    rows.map(row => ({ owner: person(row.ownerStaffId), total: row._count._all }))
  const perSource = (rows: Array<Counted & { source: string }>) => rows.map(row => ({ source: row.source, total: row._count._all }))

  const inStage = new Map(byStage.map(row => [row.stageId, row._count._all]))
  const staleInStage = new Map(staleByStage.map(row => [row.stageId, row._count._all]))
  const porEtapa = stages.map(stage => ({
    id: stage.id,
    name: stage.name,
    kind: stage.kind,
    total: inStage.get(stage.id) ?? 0,
    estancados: staleInStage.get(stage.id) ?? 0,
  }))

  return {
    desde: input.desde,
    hasta: input.hasta,
    porEtapa,
    abiertos: porEtapa.filter(stage => stage.kind === 'ABIERTA').reduce((sum, stage) => sum + stage.total, 0),
    estancados: porEtapa.reduce((sum, stage) => sum + stage.estancados, 0),
    ganados: { total: sumOf(wonBySource), porMes: wonByMonth, porDueno: perOwner(wonByOwner), porFuente: perSource(wonBySource) },
    perdidos: {
      total: sumOf(lostBySource),
      porMes: lostByMonth,
      porMotivo: lostByReason.map(row => ({
        motivo: row.lostReasonId ? { id: row.lostReasonId, name: reasonNames.get(row.lostReasonId) ?? null } : null,
        total: row._count._all,
      })),
      porDueno: perOwner(lostByOwner),
      porFuente: perSource(lostBySource),
    },
    actividades: activities.map(row => ({ persona: person(row.staffId), semana: row.semana, total: row.total })),
  }
}

// ── Export ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the CSV carries. No phone and no email: a prospect's contact data stays in the CRM (spec §5.10). */
const EXPORT_SELECT = {
  id: true,
  name: true,
  giro: true,
  ventasRango: true,
  sucursales: true,
  source: true,
  owner: { select: { firstName: true, lastName: true } },
  stage: { select: { name: true } },
  nextActivityAt: true,
  lastTouchAt: true,
  wonAt: true,
  lostAt: true,
  lostReason: { select: { name: true } },
  createdAt: true,
} satisfies Prisma.CrmAccountSelect

type ExportRow = Prisma.CrmAccountGetPayload<{ select: typeof EXPORT_SELECT }>

const HEADER = [
  'Negocio',
  'Giro',
  'Ventas al mes',
  'Sucursales',
  'Fuente',
  'Dueño',
  'Etapa',
  'Próxima actividad',
  'Último toque',
  'Ganado',
  'Perdido',
  'Motivo de pérdida',
  'Creado',
]

const when = (date: Date | null) => (date ? formatInVenueTimezone(date, TZ, 'yyyy-MM-dd HH:mm') : null)

function csvLine(row: ExportRow): string {
  return [
    row.name,
    row.giro,
    row.ventasRango,
    row.sucursales === null ? null : String(row.sucursales),
    row.source,
    row.owner ? `${row.owner.firstName} ${row.owner.lastName}`.trim() : 'Sin dueño',
    row.stage.name,
    when(row.nextActivityAt),
    when(row.lastTouchAt),
    when(row.wonAt),
    when(row.lostAt),
    row.lostReason?.name ?? null,
    when(row.createdAt),
  ]
    .map(celdaCsv)
    .join(',')
}

export type ExportFilters = Omit<AccountFilters, 'cursor' | 'limit'>

/**
 * The CSV of what the list shows for these filters (spec §5.7), with «Exportar». It walks pages of 1,000 up to 10,000
 * rows and says so when there were more (`truncado`, with the real `total`). Every export leaves its ActivityLog.
 */
export async function exportAccountsCsv(access: CrmAccess, filtros: ExportFilters, now = new Date()) {
  if (!access.exportar) throw new ForbiddenError('No tienes la llave «Exportar»', 'CRM_FORBIDDEN')
  const where = await accountsWhere(access, filtros, now)

  const total = await prisma.crmAccount.count({ where })
  const lines = [HEADER.join(',')]
  let cursor: string | null = null
  while (lines.length - 1 < EXPORT_CAP) {
    const size = Math.min(EXPORT_PAGE, EXPORT_CAP - (lines.length - 1))
    const page: ExportRow[] = await prisma.crmAccount.findMany({
      where,
      select: EXPORT_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: size,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    for (const row of page) lines.push(csvLine(row))
    if (page.length < size) break
    cursor = page[page.length - 1].id
  }
  const filas = lines.length - 1
  const truncado = total > filas

  await logAction({
    staffId: access.staffId,
    venueId: null,
    action: 'CRM_EXPORT',
    entity: 'CrmAccount',
    // 🔴 Lo que se escribió en el buscador no se guarda (D1): puede ser el nombre, el correo o el teléfono de una persona.
    data: { filas, total, truncado, filtros: { ...filtros, ...(filtros.q ? { q: '[búsqueda]' } : {}) } as Prisma.InputJsonObject },
  })
  return { csv: lines.join('\r\n'), filas, total, truncado }
}
