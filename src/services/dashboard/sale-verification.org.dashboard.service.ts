import { SaleVerificationStatus, SaleVerificationRejectionReason, PaymentMethod, Prisma } from '@prisma/client'
import { fromZonedTime } from 'date-fns-tz'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { reviewSaleVerification as reviewSaleVerificationVenue, type ReviewDecision } from './sale-verification.dashboard.service'
import { moduleService, MODULE_CODES } from '../modules/module.service'
import socketManager from '../../communication/sockets'
import { SocketEventType } from '../../communication/sockets/types'

// ============================================================
// Org-Scoped Sale Verification Dashboard Service
// ============================================================
// Mirrors `sale-verification.dashboard.service.ts` but aggregates across
// ALL venues of an organization. Used by the PlayTelecom org-level
// "Ventas" view (back-office Walmart documentation approval flow).
//
// Tenant isolation: all queries filter by `order.venue.organizationId`.
// Approval (`reviewSaleVerification`) resolves the venueId from the
// verification record then delegates to the venue-scoped service so we
// don't duplicate validation, status guards, or socket emit logic.
// ============================================================

const VENUE_TIMEZONE_DEFAULT = 'America/Mexico_City'

export interface OrgSaleListFilters {
  pageSize: number
  pageNumber: number
  status?: SaleVerificationStatus
  staffId?: string
  venueId?: string
  categoryId?: string
  isPortabilidad?: boolean
  paymentMethod?: PaymentMethod
  fromDate?: Date
  toDate?: Date
  search?: string
}

export interface OrgSaleListRow {
  id: string
  paymentId: string
  status: SaleVerificationStatus
  isPortabilidad: boolean
  photos: string[]
  serialNumbers: string[]
  reviewedById: string | null
  reviewedAt: Date | null
  reviewNotes: string | null
  rejectionReasons: SaleVerificationRejectionReason[]
  createdAt: Date
  updatedAt: Date
  venue: { id: string; name: string; city: string | null; slug: string }
  staff: { id: string; firstName: string; lastName: string; email: string | null; photoUrl: string | null } | null
  reviewedBy: { id: string; firstName: string; lastName: string } | null
  payment: {
    id: string
    amount: number
    method: PaymentMethod
    paymentForm: 'CASH' | 'CARD' | 'OTHER' | 'NONE'
    status: string
    createdAt: Date
  } | null
  category: { id: string; name: string } | null
  saleType: 'LINEA_NUEVA' | 'PORTABILIDAD' | 'ESIM'
  /** Venue that originally registered/received the SIM into inventory (e.g. "Virtual"). Null for legacy items. */
  registeredFromVenue: { id: string; name: string; slug: string } | null
  /**
   * TPV terminal that captured the verification, resolved from
   * `SaleVerification.deviceId` (which equals `Terminal.serialNumber`, e.g.
   * "AVQD-2841548417"). Lets the dashboard link a sale to its terminal.
   * Null when the device serial doesn't match a Terminal in the org.
   */
  terminal: { id: string; name: string; serialNumber: string } | null
}

export interface OrgSaleListResponse {
  data: OrgSaleListRow[]
  pagination: { pageSize: number; pageNumber: number; totalCount: number; totalPages: number }
}

/**
 * Map Payment.method → "Forma de pago" bucket used by the dashboard table.
 *   CASH → Efectivo (CASH)
 *   CREDIT_CARD/DEBIT_CARD → Tarjeta (CARD)
 *   other → OTHER
 *   null payment / no verification → NONE ("No aplica")
 */
function derivePaymentForm(method: PaymentMethod | null | undefined): 'CASH' | 'CARD' | 'OTHER' | 'NONE' {
  if (!method) return 'NONE'
  if (method === 'CASH') return 'CASH'
  if (method === 'CREDIT_CARD' || method === 'DEBIT_CARD') return 'CARD'
  return 'OTHER'
}

/**
 * "Tipo de venta" → PORTABILIDAD or LINEA_NUEVA, decided solely by the
 * isPortabilidad toggle captured at sale time (PlayTelecom, 2026-06-08).
 *
 * eSIM is a *SIM type* (the category "E-SIM de promotor"), NOT a sale type, so
 * it no longer surfaces here — an eSIM sale is classified as portabilidad or
 * línea nueva like any physical SIM. Because saleType is derived at read time,
 * this reclassifies existing eSIM sales retroactively from their stored
 * isPortabilidad flag (no data migration). The ESIM union member is kept for
 * backwards compatibility with older filters but is never produced anymore.
 */
function deriveSaleType(isPortabilidad: boolean, _categoryName?: string | null): 'LINEA_NUEVA' | 'PORTABILIDAD' | 'ESIM' {
  return isPortabilidad ? 'PORTABILIDAD' : 'LINEA_NUEVA'
}

function buildPaymentWhere(orgId: string, filters: OrgSaleListFilters): Prisma.PaymentWhereInput {
  const where: Prisma.PaymentWhereInput = {
    status: 'COMPLETED',
    order: { venue: { organizationId: orgId } },
  }

  if (filters.venueId) {
    where.order = { ...(where.order as Prisma.OrderWhereInput), venueId: filters.venueId }
  }

  if (filters.fromDate && filters.toDate) {
    where.createdAt = { gte: filters.fromDate, lte: filters.toDate }
  } else if (filters.fromDate) {
    where.createdAt = { gte: filters.fromDate }
  } else if (filters.toDate) {
    where.createdAt = { lte: filters.toDate }
  }

  if (filters.paymentMethod) {
    where.method = filters.paymentMethod
  }

  // saleVerification-related filters
  const svFilter: Prisma.SaleVerificationWhereInput = {}
  if (filters.status) svFilter.status = filters.status
  if (filters.staffId) svFilter.staffId = filters.staffId
  if (filters.isPortabilidad !== undefined) svFilter.isPortabilidad = filters.isPortabilidad
  if (Object.keys(svFilter).length > 0) {
    where.saleVerification = svFilter
  }

  // Category filter goes via orderItem → serializedItem → categoryId
  if (filters.categoryId) {
    where.order = {
      ...(where.order as Prisma.OrderWhereInput),
      items: { some: { serializedItem: { categoryId: filters.categoryId } } },
    }
  }

  if (filters.search) {
    // `serialNumbers` is a scalar string[] — Prisma's `has` is an EXACT,
    // case-SENSITIVE match and (unlike `contains`) does NOT support
    // `mode: 'insensitive'`. ICCIDs are normally stored upper-cased
    // (normalizeSerial = trim().toUpperCase()), but a handful of legacy items
    // are stored lower-cased. So we match against several case variants of the
    // search term via `hasSome` to make the ICCID lookup case-insensitive.
    const term = filters.search.trim()
    const serialVariants = Array.from(new Set([term, term.toUpperCase(), term.toLowerCase()]))
    where.OR = [
      { id: { contains: filters.search, mode: 'insensitive' } },
      {
        saleVerification: {
          staff: {
            OR: [
              { firstName: { contains: filters.search, mode: 'insensitive' } },
              { lastName: { contains: filters.search, mode: 'insensitive' } },
            ],
          },
        },
      },
      { saleVerification: { serialNumbers: { hasSome: serialVariants } } },
    ]
  }

  return where
}

/**
 * List paginated sale verifications across all venues in the organization.
 * Returns ALL completed payments, including those without a SaleVerification
 * (status will be PENDING in that case to match the venue-scoped behavior).
 */
export async function listOrgSaleVerifications(orgId: string, filters: OrgSaleListFilters): Promise<OrgSaleListResponse> {
  logger.info(`[ORG SALE VERIFICATION] List org=${orgId} page=${filters.pageNumber} size=${filters.pageSize}`)

  const paymentWhere = buildPaymentWhere(orgId, filters)

  const [payments, totalCount] = await Promise.all([
    prisma.payment.findMany({
      where: paymentWhere,
      orderBy: { createdAt: 'desc' },
      skip: (filters.pageNumber - 1) * filters.pageSize,
      take: filters.pageSize,
      include: {
        order: {
          select: {
            id: true,
            venue: { select: { id: true, name: true, city: true, slug: true } },
            items: {
              select: {
                serializedItem: {
                  select: {
                    id: true,
                    serialNumber: true,
                    category: { select: { id: true, name: true } },
                    registeredFromVenue: { select: { id: true, name: true, slug: true } },
                  },
                },
              },
            },
          },
        },
        saleVerification: {
          include: {
            staff: { select: { id: true, firstName: true, lastName: true, email: true, photoUrl: true } },
            reviewedBy: { select: { id: true, firstName: true, lastName: true } },
          },
        },
      },
    }),
    prisma.payment.count({ where: paymentWhere }),
  ])

  // Resolve TPV terminals for this page in ONE query.
  // SaleVerification.deviceId stores the Terminal.serialNumber (e.g.
  // "AVQD-2841548417"), so we batch-match the page's device serials against
  // terminals in this org. Map keyed by serialNumber for O(1) lookup per row.
  const deviceSerials = Array.from(
    new Set(payments.map(p => p.saleVerification?.deviceId).filter((s): s is string => typeof s === 'string' && s.length > 0)),
  )
  const terminalBySerial = new Map<string, { id: string; name: string; serialNumber: string }>()
  if (deviceSerials.length > 0) {
    const terminals = await prisma.terminal.findMany({
      where: { serialNumber: { in: deviceSerials }, venue: { organizationId: orgId } },
      select: { id: true, name: true, serialNumber: true },
    })
    for (const t of terminals) {
      if (t.serialNumber) terminalBySerial.set(t.serialNumber, { id: t.id, name: t.name, serialNumber: t.serialNumber })
    }
  }

  const rows: OrgSaleListRow[] = payments.map(p => {
    const v = p.saleVerification
    const firstSerialized = p.order?.items?.find(oi => oi.serializedItem)?.serializedItem ?? null
    const category = firstSerialized?.category ?? null
    const isPort = v?.isPortabilidad ?? false

    return {
      id: v?.id ?? p.id,
      paymentId: p.id,
      status: v?.status ?? 'PENDING',
      isPortabilidad: isPort,
      photos: v?.photos ?? [],
      serialNumbers: v?.serialNumbers ?? (firstSerialized?.serialNumber ? [firstSerialized.serialNumber] : []),
      reviewedById: v?.reviewedById ?? null,
      reviewedAt: v?.reviewedAt ?? null,
      reviewNotes: v?.reviewNotes ?? null,
      rejectionReasons: v?.rejectionReasons ?? [],
      createdAt: v?.createdAt ?? p.createdAt,
      updatedAt: v?.updatedAt ?? p.createdAt,
      venue: p.order!.venue,
      staff: v?.staff
        ? {
            id: v.staff.id,
            firstName: v.staff.firstName,
            lastName: v.staff.lastName,
            email: v.staff.email ?? null,
            photoUrl: v.staff.photoUrl ?? null,
          }
        : null,
      reviewedBy: v?.reviewedBy ?? null,
      payment: {
        id: p.id,
        amount: typeof p.amount === 'number' ? p.amount : Number(p.amount),
        method: p.method,
        paymentForm: derivePaymentForm(p.method),
        status: p.status,
        createdAt: p.createdAt,
      },
      category,
      saleType: deriveSaleType(isPort, category?.name ?? null),
      registeredFromVenue: firstSerialized?.registeredFromVenue ?? null,
      terminal: v?.deviceId ? (terminalBySerial.get(v.deviceId) ?? null) : null,
    }
  })

  return {
    data: rows,
    pagination: {
      pageSize: filters.pageSize,
      pageNumber: filters.pageNumber,
      totalCount,
      totalPages: Math.ceil(totalCount / filters.pageSize),
    },
  }
}

// ============================================================
// Aggregations (executive dashboard)
// ============================================================
// All aggregations only count `SaleVerification.status='COMPLETED'`
// (confirmed sales), per requirement "ventas mostradas solo deben ser
// las confirmadas".

interface AggregationRange {
  fromDate?: Date
  toDate?: Date
}

function baseAggregationWhere(orgId: string, range: AggregationRange): Prisma.SaleVerificationWhereInput {
  const where: Prisma.SaleVerificationWhereInput = {
    status: 'COMPLETED',
    venue: { organizationId: orgId },
  }
  if (range.fromDate && range.toDate) where.createdAt = { gte: range.fromDate, lte: range.toDate }
  else if (range.fromDate) where.createdAt = { gte: range.fromDate }
  else if (range.toDate) where.createdAt = { lte: range.toDate }
  return where
}

/** ISO week label "Wxx" in venue timezone. */
function toWeekLabel(d: Date, tz: string = VENUE_TIMEZONE_DEFAULT): string {
  // Convert UTC to venue local for week extraction
  const local = new Date(d.toLocaleString('en-US', { timeZone: tz }))
  // ISO week (Mon-based)
  const day = local.getUTCDay() || 7
  local.setUTCDate(local.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(local.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((local.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `W${String(week).padStart(2, '0')}`
}

function toMonthKey(d: Date, tz: string = VENUE_TIMEZONE_DEFAULT): string {
  const local = new Date(d.toLocaleString('en-US', { timeZone: tz }))
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}`
}

/** Summary metrics for the org Ventas page (top KPI cards). */
export async function getOrgSalesSummary(
  orgId: string,
  range: AggregationRange,
): Promise<{
  totalRevenue: number
  /** Revenue from CONFIRMED sales only (SaleVerification.status=COMPLETED). The "Monto confirmado" KPI must use this, not totalRevenue. */
  confirmedRevenue: number
  totalCount: number
  completedCount: number
  pendingCount: number
  failedCount: number
  withoutVerificationCount: number
}> {
  const paymentWhere: Prisma.PaymentWhereInput = {
    status: 'COMPLETED',
    order: { venue: { organizationId: orgId } },
  }
  if (range.fromDate && range.toDate) paymentWhere.createdAt = { gte: range.fromDate, lte: range.toDate }
  else if (range.fromDate) paymentWhere.createdAt = { gte: range.fromDate }
  else if (range.toDate) paymentWhere.createdAt = { lte: range.toDate }

  const payments = await prisma.payment.findMany({
    where: paymentWhere,
    select: { amount: true, saleVerification: { select: { status: true } } },
  })

  let totalRevenue = 0
  let confirmedRevenue = 0
  let completedCount = 0
  let pendingCount = 0
  let failedCount = 0
  let withoutVerificationCount = 0

  for (const p of payments) {
    const amount = typeof p.amount === 'number' ? p.amount : Number(p.amount)
    totalRevenue += amount
    if (!p.saleVerification) {
      withoutVerificationCount++
      continue
    }
    if (p.saleVerification.status === 'COMPLETED') {
      completedCount++
      confirmedRevenue += amount
    } else if (p.saleVerification.status === 'PENDING') pendingCount++
    else if (p.saleVerification.status === 'FAILED') failedCount++
  }

  return {
    totalRevenue,
    confirmedRevenue,
    totalCount: payments.length,
    completedCount,
    pendingCount,
    failedCount,
    withoutVerificationCount,
  }
}

/**
 * Sales count + revenue grouped by month (venue timezone).
 * Returns months sorted descending (newest first), matching the mockup.
 */
export async function getSalesByMonth(
  orgId: string,
  range: AggregationRange,
): Promise<Array<{ month: string; count: number; revenue: number }>> {
  const verifications = await prisma.saleVerification.findMany({
    where: baseAggregationWhere(orgId, range),
    include: { payment: { select: { amount: true } } },
  })

  const map = new Map<string, { count: number; revenue: number }>()
  for (const v of verifications) {
    const key = toMonthKey(v.createdAt)
    const prev = map.get(key) ?? { count: 0, revenue: 0 }
    const amount = v.payment?.amount ? Number(v.payment.amount) : 0
    map.set(key, { count: prev.count + 1, revenue: prev.revenue + amount })
  }
  return Array.from(map.entries())
    .map(([month, agg]) => ({ month, ...agg }))
    .sort((a, b) => b.month.localeCompare(a.month))
}

/**
 * Sales grouped by month × SIM type (ItemCategory.name). Stacked bar.
 * Each row = one month; `byCategory` is a map of categoryName → count.
 */
export async function getSalesBySimType(
  orgId: string,
  range: AggregationRange,
): Promise<Array<{ month: string; byCategory: Record<string, number>; total: number }>> {
  // Need to join through Payment → Order → OrderItem → SerializedItem → ItemCategory
  // The SaleVerification doesn't have a direct FK to category, so we use payment-driven.
  const paymentWhere: Prisma.PaymentWhereInput = {
    status: 'COMPLETED',
    order: { venue: { organizationId: orgId } },
    saleVerification: { status: 'COMPLETED' },
  }
  if (range.fromDate && range.toDate) paymentWhere.createdAt = { gte: range.fromDate, lte: range.toDate }
  else if (range.fromDate) paymentWhere.createdAt = { gte: range.fromDate }
  else if (range.toDate) paymentWhere.createdAt = { lte: range.toDate }

  const payments = await prisma.payment.findMany({
    where: paymentWhere,
    select: {
      createdAt: true,
      order: {
        select: {
          items: {
            select: { serializedItem: { select: { category: { select: { name: true } } } } },
          },
        },
      },
    },
  })

  const map = new Map<string, Record<string, number>>()
  for (const p of payments) {
    const month = toMonthKey(p.createdAt)
    const first = p.order?.items?.find(oi => oi.serializedItem)?.serializedItem
    const categoryName = first?.category?.name ?? 'Otro'
    const row = map.get(month) ?? {}
    row[categoryName] = (row[categoryName] ?? 0) + 1
    map.set(month, row)
  }
  return Array.from(map.entries())
    .map(([month, byCategory]) => {
      const total = Object.values(byCategory).reduce((a, b) => a + b, 0)
      return { month, byCategory, total }
    })
    .sort((a, b) => b.month.localeCompare(a.month))
}

/** Sales grouped by ISO week label (Wxx). */
export async function getSalesByWeek(
  orgId: string,
  range: AggregationRange,
): Promise<Array<{ week: string; count: number; revenue: number }>> {
  const verifications = await prisma.saleVerification.findMany({
    where: baseAggregationWhere(orgId, range),
    include: { payment: { select: { amount: true } } },
  })
  const map = new Map<string, { count: number; revenue: number }>()
  for (const v of verifications) {
    const key = toWeekLabel(v.createdAt)
    const prev = map.get(key) ?? { count: 0, revenue: 0 }
    const amount = v.payment?.amount ? Number(v.payment.amount) : 0
    map.set(key, { count: prev.count + 1, revenue: prev.revenue + amount })
  }
  return Array.from(map.entries())
    .map(([week, agg]) => ({ week, ...agg }))
    .sort((a, b) => b.week.localeCompare(a.week))
}

/** Sales grouped by venue.city × month. */
export async function getSalesByCity(
  orgId: string,
  range: AggregationRange,
): Promise<Array<{ city: string; byMonth: Record<string, number>; total: number }>> {
  const verifications = await prisma.saleVerification.findMany({
    where: baseAggregationWhere(orgId, range),
    include: { venue: { select: { city: true } } },
  })
  const map = new Map<string, Record<string, number>>()
  for (const v of verifications) {
    const city = v.venue?.city || 'Sin ciudad'
    const month = toMonthKey(v.createdAt)
    const row = map.get(city) ?? {}
    row[month] = (row[month] ?? 0) + 1
    map.set(city, row)
  }
  return Array.from(map.entries())
    .map(([city, byMonth]) => {
      const total = Object.values(byMonth).reduce((a, b) => a + b, 0)
      return { city, byMonth, total }
    })
    .sort((a, b) => b.total - a.total)
}

/**
 * Sales grouped by supervisor × ISO week and × month.
 *
 * Supervisor attribution: in the PlayTelecom hierarchy the "Supervisor
 * responsable" of a store is its MANAGER (Admin=OWNER/ADMIN → Supervisor=MANAGER
 * → Promoter=WAITER), so a venue's active MANAGER takes precedence. ADMIN is
 * only a fallback for venues with no MANAGER assigned — org admins must NOT
 * displace the real supervisor (Asana 1215613218390496: org admins were being
 * reported as supervisors because attribution took the first ADMIN/MANAGER by
 * staffId). Staff has no direct supervisor FK.
 */
export async function getSalesBySupervisor(
  orgId: string,
  range: AggregationRange,
): Promise<
  Array<{
    supervisorId: string | null
    supervisorName: string
    byWeek: Record<string, number>
    byMonth: Record<string, number>
    total: number
  }>
> {
  const verifications = await prisma.saleVerification.findMany({
    where: baseAggregationWhere(orgId, range),
    select: { createdAt: true, venueId: true },
  })

  // Bulk lookup of one supervisor per venue: MANAGER first, ADMIN as fallback,
  // deterministic by staffId asc within each role.
  const venueIds = Array.from(new Set(verifications.map(v => v.venueId).filter(Boolean) as string[]))
  const venueManagers = await prisma.staffVenue.findMany({
    where: {
      venueId: { in: venueIds },
      role: { in: ['ADMIN', 'MANAGER'] },
      active: true,
    },
    orderBy: { staffId: 'asc' },
    include: { staff: { select: { id: true, firstName: true, lastName: true } } },
  })
  const supervisorByVenue = new Map<string, { id: string; name: string }>()
  for (const role of ['MANAGER', 'ADMIN'] as const) {
    for (const sv of venueManagers) {
      if (sv.role !== role) continue
      if (!supervisorByVenue.has(sv.venueId)) {
        supervisorByVenue.set(sv.venueId, {
          id: sv.staff.id,
          name: `${sv.staff.firstName} ${sv.staff.lastName}`.trim(),
        })
      }
    }
  }

  const map = new Map<string, { name: string; byWeek: Record<string, number>; byMonth: Record<string, number> }>()
  for (const v of verifications) {
    const supervisor = v.venueId ? supervisorByVenue.get(v.venueId) : undefined
    const key = supervisor?.id ?? 'unassigned'
    const name = supervisor?.name ?? 'Sin supervisor'
    const week = toWeekLabel(v.createdAt)
    const month = toMonthKey(v.createdAt)
    const row = map.get(key) ?? { name, byWeek: {}, byMonth: {} }
    row.byWeek[week] = (row.byWeek[week] ?? 0) + 1
    row.byMonth[month] = (row.byMonth[month] ?? 0) + 1
    map.set(key, row)
  }
  return Array.from(map.entries())
    .map(([supervisorId, val]) => {
      const total = Object.values(val.byWeek).reduce((a, b) => a + b, 0)
      return {
        supervisorId: supervisorId === 'unassigned' ? null : supervisorId,
        supervisorName: val.name,
        byWeek: val.byWeek,
        byMonth: val.byMonth,
        total,
      }
    })
    .sort((a, b) => b.total - a.total)
}

/** Sales grouped by venue × ISO week and × month. */
export async function getSalesByStore(
  orgId: string,
  range: AggregationRange,
): Promise<Array<{ venueId: string; venueName: string; byWeek: Record<string, number>; byMonth: Record<string, number>; total: number }>> {
  const verifications = await prisma.saleVerification.findMany({
    where: baseAggregationWhere(orgId, range),
    include: { venue: { select: { id: true, name: true } } },
  })
  const map = new Map<string, { name: string; byWeek: Record<string, number>; byMonth: Record<string, number> }>()
  for (const v of verifications) {
    const id = v.venue?.id ?? 'unknown'
    const name = v.venue?.name ?? 'Sin tienda'
    const week = toWeekLabel(v.createdAt)
    const month = toMonthKey(v.createdAt)
    const row = map.get(id) ?? { name, byWeek: {}, byMonth: {} }
    row.byWeek[week] = (row.byWeek[week] ?? 0) + 1
    row.byMonth[month] = (row.byMonth[month] ?? 0) + 1
    map.set(id, row)
  }
  return Array.from(map.entries())
    .map(([venueId, val]) => {
      const total = Object.values(val.byWeek).reduce((a, b) => a + b, 0)
      return { venueId, venueName: val.name, byWeek: val.byWeek, byMonth: val.byMonth, total }
    })
    .sort((a, b) => b.total - a.total)
}

/**
 * Sales grouped by promoter (the staff who registered the sale on the TPV) × month.
 * Promoter attribution comes straight from `SaleVerification.staffId` — no
 * role lookup needed, unlike supervisors.
 */
export async function getSalesByPromoter(
  orgId: string,
  range: AggregationRange,
): Promise<Array<{ staffId: string | null; promoterName: string; byMonth: Record<string, number>; total: number }>> {
  const verifications = await prisma.saleVerification.findMany({
    where: baseAggregationWhere(orgId, range),
    select: {
      createdAt: true,
      staff: { select: { id: true, firstName: true, lastName: true } },
    },
  })
  const map = new Map<string, { name: string; byMonth: Record<string, number> }>()
  for (const v of verifications) {
    const key = v.staff?.id ?? 'unassigned'
    const name = v.staff ? `${v.staff.firstName} ${v.staff.lastName}`.trim() : 'Sin promotor'
    const month = toMonthKey(v.createdAt)
    const row = map.get(key) ?? { name, byMonth: {} }
    row.byMonth[month] = (row.byMonth[month] ?? 0) + 1
    map.set(key, row)
  }
  return Array.from(map.entries())
    .map(([staffId, val]) => {
      const total = Object.values(val.byMonth).reduce((a, b) => a + b, 0)
      return { staffId: staffId === 'unassigned' ? null : staffId, promoterName: val.name, byMonth: val.byMonth, total }
    })
    .sort((a, b) => b.total - a.total)
}

/** "YYYY-MM-DD" day key in venue timezone (same tz convention as toMonthKey/toWeekLabel). */
function toDayKey(d: Date, tz: string = VENUE_TIMEZONE_DEFAULT): string {
  const local = new Date(d.toLocaleString('en-US', { timeZone: tz }))
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
}

export interface PromoterDailyRow {
  staffId: string | null
  promoterName: string
  /** Confirmed (COMPLETED) sales per day key ("YYYY-MM-DD"). */
  byDay: Record<string, number>
  /** Confirmed total for the current month (sum of byDay). Excludes toReview. */
  total: number
  /**
   * Count of FAILED verifications — sales the PROMOTER must fix on the TPV
   * ("Pendientes de revisar por el promotor en TPV"). NOT part of `total`.
   */
  toReview: number
}

export interface PromoterDailyResult {
  /** Current month "YYYY-MM". */
  month: string
  /** Ordered day keys of the current month, day 1 → today (venue tz). */
  days: string[]
  rows: PromoterDailyRow[]
}

/**
 * "Ventas Totales por Promotor por día" — current month only (PlayTelecom, Asana
 * 1215613218390496). Per promoter: confirmed (COMPLETED) sales broken down by day,
 * the monthly confirmed total, and a `toReview` count of FAILED verifications the
 * promoter must correct on the TPV. Sales "to review" are NEVER added to `total`.
 * Rows sorted by confirmed total desc. Always the current month, ignores any range.
 */
export async function getSalesByPromoterDaily(orgId: string): Promise<PromoterDailyResult> {
  const tz = VENUE_TIMEZONE_DEFAULT
  // "Now" in venue local time → current month boundaries.
  const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: tz }))
  const year = nowLocal.getFullYear()
  const month0 = nowLocal.getMonth() // 0-based
  const mm = String(month0 + 1).padStart(2, '0')
  const monthKey = `${year}-${mm}`
  const rangeStart = fromZonedTime(new Date(`${monthKey}-01T00:00:00`), tz)

  // Day columns: 01 → today.
  const days: string[] = []
  for (let d = 1; d <= nowLocal.getDate(); d++) days.push(`${monthKey}-${String(d).padStart(2, '0')}`)

  // Need both COMPLETED (daily/total) and FAILED (toReview) for the current month.
  const verifications = await prisma.saleVerification.findMany({
    where: {
      venue: { organizationId: orgId },
      status: { in: ['COMPLETED', 'FAILED'] },
      createdAt: { gte: rangeStart },
    },
    select: {
      createdAt: true,
      status: true,
      staff: { select: { id: true, firstName: true, lastName: true } },
    },
  })

  const map = new Map<string, { name: string; byDay: Record<string, number>; toReview: number }>()
  for (const v of verifications) {
    const key = v.staff?.id ?? 'unassigned'
    const name = v.staff ? `${v.staff.firstName} ${v.staff.lastName}`.trim() : 'Sin promotor'
    const row = map.get(key) ?? { name, byDay: {}, toReview: 0 }
    if (v.status === 'COMPLETED') {
      const dayKey = toDayKey(v.createdAt, tz)
      row.byDay[dayKey] = (row.byDay[dayKey] ?? 0) + 1
    } else if (v.status === 'FAILED') {
      row.toReview += 1
    }
    map.set(key, row)
  }

  const rows: PromoterDailyRow[] = Array.from(map.entries())
    .map(([staffId, val]) => ({
      staffId: staffId === 'unassigned' ? null : staffId,
      promoterName: val.name,
      byDay: val.byDay,
      total: Object.values(val.byDay).reduce((a, b) => a + b, 0),
      toReview: val.toReview,
    }))
    .sort((a, b) => b.total - a.total)

  return { month: monthKey, days, rows }
}

// ============================================================
// Review (approve/reject) — delegates to venue-scoped service
// ============================================================

interface ServiceError extends Error {
  statusCode?: number
}

function createServiceError(message: string, statusCode: number): ServiceError {
  const err = new Error(message) as ServiceError
  err.statusCode = statusCode
  return err
}

/**
 * Org-scoped review wrapper.
 *
 * Validates the verification belongs to a venue inside `orgId`, then
 * delegates to `reviewSaleVerification` (venue service) which handles
 * status guard, validation, socket emit.
 */
export async function reviewOrgSaleVerification(
  orgId: string,
  params: {
    saleVerificationId: string
    reviewedById: string
    decision: ReviewDecision
    rejectionReasons?: SaleVerificationRejectionReason[]
    reviewNotes?: string
  },
) {
  const existing = await prisma.saleVerification.findUnique({
    where: { id: params.saleVerificationId },
    select: {
      id: true,
      venueId: true,
      venue: { select: { organizationId: true } },
    },
  })

  if (!existing) throw createServiceError('Sale verification not found', 404)
  if (existing.venue?.organizationId !== orgId) {
    throw createServiceError('Sale verification does not belong to this organization', 403)
  }

  return reviewSaleVerificationVenue(existing.venueId, params)
}

/**
 * Reopen an APPROVED (COMPLETED) sale verification — reverts it to PENDING so
 * the back-office can re-evaluate it. OWNER-only operation (gated upstream by
 * `sale-verifications:reopen` permission, OWNER-default per `permissions.ts`).
 *
 * Safety contract (verified cross-repo before shipping):
 *   - The SerializedItem (SIM) status stays SOLD — sale of physical inventory
 *     is unaffected. Approval/rejection is purely a documentation review state.
 *   - Payment / Order / CommissionCalculation / DigitalReceipt are untouched.
 *     No money moves, no inventory unwinds.
 *   - The TPV ("Mis Ventas") just re-renders the badge as Pendiente via the
 *     `sale-verification.reviewed` socket. The correction screen does NOT open
 *     on PENDING (only on FAILED), so the promoter sees no false prompt.
 *   - A future photo re-upload on the reopened sale stays PENDING (does NOT
 *     auto-complete) because serialized-inventory venues are gated by
 *     `requiresBackOfficeReview` in `createOrUpdateProofOfSale`.
 *
 * Scoping:
 *   - Verification must belong to a venue inside `orgId`.
 *   - The venue's org must have SERIALIZED_INVENTORY active (extra defense:
 *     reopen is meaningless for a restaurant that has no review step).
 *
 * Idempotency: the status guard `existing.status === 'COMPLETED'` makes double
 * calls / races into a 409 instead of a silent no-op or drift.
 */
export async function reopenOrgSaleVerification(
  orgId: string,
  params: {
    saleVerificationId: string
    reopenedById: string
    reason: string
  },
) {
  const trimmedReason = params.reason?.trim() ?? ''
  if (trimmedReason.length < 5) {
    throw createServiceError('Un motivo de al menos 5 caracteres es obligatorio para reabrir la revisión', 400)
  }

  const existing = await prisma.saleVerification.findUnique({
    where: { id: params.saleVerificationId },
    select: {
      id: true,
      venueId: true,
      staffId: true,
      paymentId: true,
      status: true,
      venue: { select: { organizationId: true } },
    },
  })

  if (!existing) throw createServiceError('Sale verification not found', 404)
  if (existing.venue?.organizationId !== orgId) {
    throw createServiceError('Sale verification does not belong to this organization', 403)
  }
  if (existing.status !== 'COMPLETED') {
    throw createServiceError(`Only COMPLETED verifications can be reopened (current status=${existing.status})`, 409)
  }

  // Defense-in-depth: reopen is a white-label / serialized-inventory feature.
  // Block it for any venue that somehow lacks the module (shouldn't happen via
  // normal UI, but a stray API call should not bypass the scope).
  const serializedActive = await moduleService.isModuleEnabled(existing.venueId, MODULE_CODES.SERIALIZED_INVENTORY)
  if (!serializedActive) {
    throw createServiceError('Reopen is only available on serialized-inventory venues', 403)
  }

  const updated = await prisma.saleVerification.update({
    where: { id: existing.id },
    data: {
      status: 'PENDING',
      reviewedById: null,
      reviewedAt: null,
      reviewNotes: null,
      rejectionReasons: [],
    },
    include: {
      staff: { select: { id: true, firstName: true, lastName: true, email: true, photoUrl: true } },
      reviewedBy: { select: { id: true, firstName: true, lastName: true } },
      payment: { select: { id: true, amount: true, status: true, createdAt: true } },
    },
  })

  // Audit trail — Render logs / BetterStack are the system of record.
  // Structured so a future query can filter by event name.
  logger.info(
    `[SALE_VERIFICATION_REOPEN] verification=${updated.id} org=${orgId} by=${params.reopenedById} ` +
      `previousStatus=COMPLETED reason="${trimmedReason.replace(/"/g, '\\"')}"`,
  )

  // Notify the promoter — TPV's "Mis Ventas" refreshes the badge via the same
  // socket event used for normal approve/reject. PENDING is already a handled
  // state on the TPV (no correction screen pops on PENDING).
  try {
    socketManager.broadcastToUser(existing.staffId, SocketEventType.SALE_VERIFICATION_REVIEWED, {
      saleVerificationId: updated.id,
      paymentId: updated.paymentId,
      status: updated.status,
      reviewedAt: null,
      reviewNotes: null,
      rejectionReasons: [],
      reviewedBy: null,
    })
  } catch (err: any) {
    logger.warn(`[SALE_VERIFICATION_REOPEN] socket emit failed for staff ${existing.staffId}: ${err?.message ?? err}`)
  }

  return updated
}

type EditableForm = 'CASH' | 'CARD' | 'OTHER'

// Reverse of derivePaymentForm: the UI's 3 buckets map back to a canonical
// PaymentMethod. CREDIT_CARD round-trips to 'CARD' so the row redisplays stably.
const PAYMENT_FORM_TO_METHOD: Record<EditableForm, PaymentMethod> = {
  CASH: 'CASH',
  CARD: 'CREDIT_CARD',
  OTHER: 'OTHER',
}

/**
 * Edit/correct a sale verification at org scope (back-office, OWNER-only).
 *
 * P1 fields: amount + forma de pago (Payment), isPortabilidad + status
 * (SaleVerification). Writes are atomic; an ActivityLog row records before/after
 * + reason for audit (this mutates a financial record). Commissions are NOT
 * recomputed (PlayTelecom doesn't use them; revenue charts are query-time and
 * self-correct). `reason` is mandatory (min 5 chars).
 */
export async function editOrgSaleVerification(
  orgId: string,
  params: {
    saleVerificationId: string
    editedById: string
    amount?: number
    paymentForm?: EditableForm
    isPortabilidad?: boolean
    status?: SaleVerificationStatus
    reason: string
  },
) {
  const trimmedReason = params.reason?.trim() ?? ''
  if (trimmedReason.length < 5) {
    throw createServiceError('Un motivo de al menos 5 caracteres es obligatorio para editar la venta', 400)
  }
  if (params.amount != null && (!Number.isFinite(params.amount) || params.amount < 0)) {
    throw createServiceError('El monto debe ser un número mayor o igual a 0', 400)
  }

  const existing = await prisma.saleVerification.findUnique({
    where: { id: params.saleVerificationId },
    select: {
      id: true,
      venueId: true,
      staffId: true,
      paymentId: true,
      status: true,
      isPortabilidad: true,
      payment: { select: { id: true, amount: true, method: true } },
      venue: { select: { organizationId: true } },
    },
  })

  if (!existing) throw createServiceError('Venta no encontrada', 404)
  if (existing.venue?.organizationId !== orgId) {
    throw createServiceError('La venta no pertenece a esta organización', 403)
  }

  const before = {
    status: existing.status,
    isPortabilidad: existing.isPortabilidad,
    amount: existing.payment ? Number(existing.payment.amount) : null,
    method: existing.payment?.method ?? null,
  }
  const nextStatus: SaleVerificationStatus = params.status ?? existing.status

  const updated = await prisma.$transaction(async tx => {
    // 1. Payment (monto / forma de pago)
    if (existing.payment && (params.amount != null || params.paymentForm != null)) {
      await tx.payment.update({
        where: { id: existing.payment.id },
        data: {
          ...(params.amount != null ? { amount: params.amount } : {}),
          ...(params.paymentForm != null ? { method: PAYMENT_FORM_TO_METHOD[params.paymentForm] } : {}),
        },
      })
    }

    // 2. SaleVerification (tipo de venta + estado + metadata de revisión)
    const reviewMeta =
      nextStatus === 'PENDING'
        ? { reviewedById: null, reviewedAt: null, reviewNotes: null, rejectionReasons: [] }
        : nextStatus === 'COMPLETED'
          ? { reviewedById: params.editedById, reviewedAt: new Date(), rejectionReasons: [] }
          : { reviewedById: params.editedById, reviewedAt: new Date() } // FAILED keeps existing reasons/notes

    const sv = await tx.saleVerification.update({
      where: { id: existing.id },
      data: {
        ...(params.isPortabilidad != null ? { isPortabilidad: params.isPortabilidad } : {}),
        status: nextStatus,
        ...reviewMeta,
      },
      include: {
        staff: { select: { id: true, firstName: true, lastName: true, email: true, photoUrl: true } },
        reviewedBy: { select: { id: true, firstName: true, lastName: true } },
        payment: { select: { id: true, amount: true, method: true, status: true, createdAt: true } },
      },
    })

    // 3. Audit (financial edit → DB record, not just logs)
    await tx.activityLog.create({
      data: {
        staffId: params.editedById,
        venueId: existing.venueId,
        action: 'SALE_VERIFICATION_EDIT',
        entity: 'SaleVerification',
        entityId: existing.id,
        data: {
          reason: trimmedReason,
          before,
          after: {
            status: nextStatus,
            isPortabilidad: params.isPortabilidad ?? existing.isPortabilidad,
            amount: params.amount ?? before.amount,
            method: params.paymentForm ? PAYMENT_FORM_TO_METHOD[params.paymentForm] : before.method,
          },
        } as Prisma.InputJsonValue,
      },
    })

    return sv
  })

  logger.info(
    `[SALE_VERIFICATION_EDIT] verification=${existing.id} org=${orgId} by=${params.editedById} ` +
      `status=${before.status}->${nextStatus} amount=${before.amount}->${params.amount ?? before.amount} ` +
      `reason="${trimmedReason.replace(/"/g, '\\"')}"`,
  )

  // Best-effort: refresh the promoter's TPV badge (harmless if the promoter left).
  try {
    socketManager.broadcastToUser(existing.staffId, SocketEventType.SALE_VERIFICATION_REVIEWED, {
      saleVerificationId: updated.id,
      paymentId: updated.paymentId,
      status: updated.status,
      reviewedAt: updated.reviewedAt,
      reviewNotes: updated.reviewNotes ?? null,
      rejectionReasons: updated.rejectionReasons ?? [],
      reviewedBy: updated.reviewedBy ?? null,
    })
  } catch (err: any) {
    logger.warn(`[SALE_VERIFICATION_EDIT] socket emit failed for staff ${existing.staffId}: ${err?.message ?? err}`)
  }

  return updated
}

// Utility — parse query dates with venue-timezone-aware day boundaries
export function parseRange(fromDateStr?: string, toDateStr?: string): AggregationRange {
  const range: AggregationRange = {}
  if (fromDateStr) {
    range.fromDate = fromZonedTime(new Date(`${fromDateStr}T00:00:00`), VENUE_TIMEZONE_DEFAULT)
  }
  if (toDateStr) {
    range.toDate = fromZonedTime(new Date(`${toDateStr}T23:59:59.999`), VENUE_TIMEZONE_DEFAULT)
  }
  return range
}
