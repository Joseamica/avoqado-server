import { SaleVerificationStatus, SaleVerificationRejectionReason, PaymentMethod, Prisma } from '@prisma/client'
import { fromZonedTime } from 'date-fns-tz'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { reviewSaleVerification as reviewSaleVerificationVenue, type ReviewDecision } from './sale-verification.dashboard.service'
import { monthBucketSql, dayBucketSql, weekLabelSql, isoWeekKeySql, buildRangeConditions } from './sale-verification.org.sql'
import { venueCivilDate } from '../../utils/venueDateKeys'
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

// SIM-type buckets for the org Ventas tables/charts. Names are tenant data
// (confirmed against PlayTelecom's ItemCategory records). The 3 exact buckets +
// "e-SIM" (matched by substring, like the rest of the backend's eSIM detection)
// are always-present rows; everything else — null, legacy "Otro", the "de caja"
// family, etc. — collapses to "Otros SIMs" so row sums always reconcile with the
// weekly total. eSIM was split out of "Otros SIMs" on Isaac's request (2026-06-30).
export type SimBucket = 'SIM de Intercambio' | '$100 de Promotor' | 'SIM de Evento' | 'e-SIM' | 'Otros SIMs'
export const SIM_OTHERS: SimBucket = 'Otros SIMs'
/** Exact-name buckets (matched verbatim, case/space-insensitive). */
const SIM_EXACT_BUCKETS = ['SIM de Intercambio', '$100 de Promotor', 'SIM de Evento'] as const
/** Display/row order for the SIM-type tables: 3 exact + e-SIM ("Otros SIMs" appended last when > 0). */
export const SIM_FIXED_BUCKETS: readonly SimBucket[] = [...SIM_EXACT_BUCKETS, 'e-SIM']

export function toSimBucket(categoryName: string | null | undefined): SimBucket {
  const n = (categoryName ?? '').trim().toLowerCase()
  // eSIM by substring ("E-SIM de promotor" and any e-sim/esim variant), matching how
  // the rest of the backend detects eSIMs.
  if (n.includes('e-sim') || n.includes('esim')) return 'e-SIM'
  return SIM_EXACT_BUCKETS.find(b => b.toLowerCase() === n) ?? SIM_OTHERS
}

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
      // `id` is the TIEBREAK, not decoration — do NOT reduce this to `createdAt` alone.
      // Manual uploads ("Subir ventas fuera de TPV") backdate every sale of a given day
      // to the SAME noon-anchored instant, so a busy day is one big group of rows with a
      // byte-identical `createdAt`. With a non-unique sort key, Postgres is free to order
      // ties differently per query, and this list is read page-by-page (skip/take) by the
      // org Ventas Excel export. A tie group straddling a page boundary then lands a row
      // twice on one page and NEVER on the next: the sale vanishes from the export while
      // still being SOLD in the DB (Asana 1217127206664238 — 4 ICCIDs missing from the
      // historical-sales Excel, reproduced against prod: 5 of 5552 rows silently lost).
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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

/**
 * FROM + WHERE compartido por TODAS las agregaciones de ventas confirmadas en SQL.
 *
 * 🔴 Que sea UNO SOLO es lo que garantiza la regla de Isaac (2026-06-29): *"el total debe
 * cuadrar en todas las tablas y gráficas"*. Antes esa garantía venía de que las 12
 * agregaciones llamaban al mismo `baseAggregationWhere`; ahora viene de que arman su
 * consulta a partir de este mismo bloque. Si alguien escribe su propio WHERE "porque su
 * caso es especial", las tablas dejan de cuadrar entre sí — sin error visible.
 *
 * Alias fijos: `sv` = SaleVerification, `v` = Venue, `p` = Payment, `s` = Staff.
 *
 * Los tres joins van SIEMPRE, aunque una agregación concreta no use todas las columnas:
 * `venueId`, `paymentId` y `staffId` son obligatorios en el esquema y `paymentId` además
 * es único, así que ningún join puede multiplicar ni perder filas. Tenerlos fijos evita
 * que cada agregación arme su propio FROM y se desvíe.
 */
function completedSalesFromWhere(orgId: string, range: AggregationRange): Prisma.Sql {
  return Prisma.sql`
    FROM "SaleVerification" sv
    JOIN "Venue" v ON v."id" = sv."venueId"
    LEFT JOIN "Payment" p ON p."id" = sv."paymentId"
    LEFT JOIN "Staff" s ON s."id" = sv."staffId"
    WHERE sv."status" = 'COMPLETED'
      AND v."organizationId" = ${orgId}
      ${buildRangeConditions(range, 'sv."createdAt"')}
  `
}

/**
 * Ventas confirmadas agrupadas por `bucketExpr` × categoría de SIM.
 *
 * 🔴 AQUÍ VIVE EL ARREGLO DEL AZAR. El código anterior resolvía la categoría con
 * `payment.order.items.find(oi => oi.serializedItem)` — "el primer item que traiga un
 * serializado". Pero esa lista no tenía `orderBy`, así que "el primero" lo decidía
 * Postgres: una orden con DOS serializados de categorías distintas podía caer en un bucket
 * u otro entre corridas, sin que nada fallara. Es el mismo defecto de familia que la
 * pérdida silenciosa de filas en listas paginadas (arreglado el 2026-08-04 por la mañana).
 *
 * `DISTINCT ON (sv."id")` con un `ORDER BY` explícito lo fija:
 *   1. `si."id" IS NULL` — los items SIN serializado se van al final, así que si la orden
 *      tiene alguno con serializado, ese gana. Reproduce lo que hacía el `.find()`.
 *   2. `oi."id"` — el desempate estable que faltaba.
 *
 * `bucketExpr` debe construirse sobre `cv."created_at"` (la columna que expone el CTE).
 */
function categoriaPorVentaSql(orgId: string, range: AggregationRange, bucketExpr: string): Prisma.Sql {
  return Prisma.sql`
    WITH categoria_por_venta AS (
      SELECT DISTINCT ON (sv."id")
             sv."id"        AS verification_id,
             sv."createdAt" AS created_at,
             ic."name"      AS category_name
      FROM "SaleVerification" sv
      JOIN "Venue" v ON v."id" = sv."venueId"
      LEFT JOIN "Payment" p ON p."id" = sv."paymentId"
      LEFT JOIN "Order" o ON o."id" = p."orderId"
      LEFT JOIN "OrderItem" oi ON oi."orderId" = o."id"
      LEFT JOIN "SerializedItem" si ON si."orderItemId" = oi."id"
      LEFT JOIN "ItemCategory" ic ON ic."id" = si."categoryId"
      WHERE sv."status" = 'COMPLETED'
        AND v."organizationId" = ${orgId}
        ${buildRangeConditions(range, 'sv."createdAt"')}
      ORDER BY sv."id", (si."id" IS NULL), oi."id"
    )
    SELECT ${Prisma.raw(bucketExpr)} AS bucket,
           cv."category_name"        AS category_name,
           COUNT(*)                  AS count
    FROM categoria_por_venta cv
    GROUP BY 1, 2
    ORDER BY 1
  `
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
  /** Terminal "Rechazada" (REJECTED) sales — started but lost (couldn't link/port). */
  rejectedCount: number
  withoutVerificationCount: number
}> {
  // 🔴 Esta agregación NO usa `completedSalesFromWhere`: su universo es distinto a
  // propósito. Las demás cuentan sólo ventas CONFIRMADAS; ésta parte de TODOS los pagos
  // completados de la organización —incluidos los que ni siquiera tienen verificación— y
  // los desglosa por estado. Por eso el FROM arranca en "Payment" y la verificación entra
  // con LEFT JOIN.
  const rows = await prisma.$queryRaw<
    Array<{
      total_revenue: string | null
      confirmed_revenue: string | null
      total_count: bigint
      completed_count: bigint
      pending_count: bigint
      failed_count: bigint
      rejected_count: bigint
      without_verification_count: bigint
    }>
  >(Prisma.sql`
    SELECT
      COALESCE(SUM(p."amount"), 0)                                          AS total_revenue,
      COALESCE(SUM(p."amount") FILTER (WHERE sv."status" = 'COMPLETED'), 0) AS confirmed_revenue,
      COUNT(*)                                                              AS total_count,
      COUNT(*) FILTER (WHERE sv."status" = 'COMPLETED')                     AS completed_count,
      COUNT(*) FILTER (WHERE sv."status" = 'PENDING')                       AS pending_count,
      COUNT(*) FILTER (WHERE sv."status" = 'FAILED')                        AS failed_count,
      COUNT(*) FILTER (WHERE sv."status" = 'REJECTED')                      AS rejected_count,
      COUNT(*) FILTER (WHERE sv."id" IS NULL)                               AS without_verification_count
    FROM "Payment" p
    JOIN "Order" o ON o."id" = p."orderId"
    JOIN "Venue" v ON v."id" = o."venueId"
    LEFT JOIN "SaleVerification" sv ON sv."paymentId" = p."id"
    WHERE p."status" = 'COMPLETED'
      AND v."organizationId" = ${orgId}
      ${buildRangeConditions(range, 'p."createdAt"')}
  `)

  const r = rows[0]
  return {
    // Montos en PESOS, 1:1. `amount` es Decimal(x,2); Number() lo deja en pesos.
    totalRevenue: Number(r?.total_revenue ?? 0),
    confirmedRevenue: Number(r?.confirmed_revenue ?? 0),
    totalCount: Number(r?.total_count ?? 0),
    completedCount: Number(r?.completed_count ?? 0),
    pendingCount: Number(r?.pending_count ?? 0),
    failedCount: Number(r?.failed_count ?? 0),
    rejectedCount: Number(r?.rejected_count ?? 0),
    withoutVerificationCount: Number(r?.without_verification_count ?? 0),
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
  const bucket = monthBucketSql('sv."createdAt"', VENUE_TIMEZONE_DEFAULT)

  const rows = await prisma.$queryRaw<Array<{ bucket: string; count: bigint; revenue: string | null }>>(Prisma.sql`
    SELECT ${Prisma.raw(bucket)} AS bucket,
           COUNT(*)                     AS count,
           COALESCE(SUM(p."amount"), 0) AS revenue
    ${completedSalesFromWhere(orgId, range)}
    GROUP BY ${Prisma.raw(bucket)}
    ORDER BY bucket DESC
  `)

  return rows.map(r => ({
    month: r.bucket,
    count: Number(r.count),
    // `amount` es Decimal(x,2) en PESOS. Number() lo deja en pesos, 1:1 — nunca centavos.
    revenue: Number(r.revenue ?? 0),
  }))
}

/**
 * Sales grouped by month × SIM type (ItemCategory.name). Stacked bar.
 * Each row = one month; `byCategory` is a map of SimBucket → count.
 *
 * Uses the same COMPLETED SaleVerification base as getSalesBySimTypeWeekly so
 * the monthly chart's grand total reconciles with the weekly bar (Isaac: "el
 * total debe cuadrar en todas las tablas y gráficas", 2026-06-29).
 * Category is resolved via payment→order→items→serializedItem→category, identical
 * to the weekly variant — same join path, bucketed by month instead of week.
 */
export async function getSalesBySimType(
  orgId: string,
  range: AggregationRange,
): Promise<Array<{ month: string; byCategory: Record<string, number>; total: number }>> {
  const rows = await prisma.$queryRaw<Array<{ bucket: string; category_name: string | null; count: bigint }>>(
    categoriaPorVentaSql(orgId, range, monthBucketSql('cv."created_at"', VENUE_TIMEZONE_DEFAULT)),
  )

  const map = new Map<string, Record<string, number>>()
  for (const r of rows) {
    const row = map.get(r.bucket) ?? {}
    const bucket = toSimBucket(r.category_name)
    row[bucket] = (row[bucket] ?? 0) + Number(r.count)
    map.set(r.bucket, row)
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
  const bucket = weekLabelSql('sv."createdAt"', VENUE_TIMEZONE_DEFAULT)

  const rows = await prisma.$queryRaw<Array<{ bucket: string; count: bigint; revenue: string | null }>>(Prisma.sql`
    SELECT ${Prisma.raw(bucket)} AS bucket,
           COUNT(*)                     AS count,
           COALESCE(SUM(p."amount"), 0) AS revenue
    ${completedSalesFromWhere(orgId, range)}
    GROUP BY ${Prisma.raw(bucket)}
    ORDER BY bucket DESC
  `)

  return rows.map(r => ({
    week: r.bucket,
    count: Number(r.count),
    revenue: Number(r.revenue ?? 0),
  }))
}

/**
 * Confirmed sales by Tipo de Venta (Línea Nueva vs Portabilidad) × ISO week.
 * Same COMPLETED base as getSalesByWeek so weekly totals reconcile exactly.
 * Always returns both rows in fixed order, even if a week/type is empty.
 */
export async function getSalesBySaleTypeWeekly(
  orgId: string,
  range: AggregationRange,
): Promise<Array<{ name: 'Líneas Nuevas' | 'Portabilidades'; byWeek: Record<string, number>; total: number }>> {
  const bucket = isoWeekKeySql('sv."createdAt"', VENUE_TIMEZONE_DEFAULT)

  const grouped = await prisma.$queryRaw<Array<{ bucket: string; is_portabilidad: boolean; count: bigint }>>(Prisma.sql`
    SELECT ${Prisma.raw(bucket)} AS bucket,
           sv."isPortabilidad"   AS is_portabilidad,
           COUNT(*)              AS count
    ${completedSalesFromWhere(orgId, range)}
    GROUP BY ${Prisma.raw(bucket)}, sv."isPortabilidad"
    ORDER BY bucket
  `)

  // Las dos filas SIEMPRE presentes y en orden fijo: la gráfica las espera así aunque una
  // venga vacía.
  const rows: Record<'Líneas Nuevas' | 'Portabilidades', { byWeek: Record<string, number>; total: number }> = {
    'Líneas Nuevas': { byWeek: {}, total: 0 },
    Portabilidades: { byWeek: {}, total: 0 },
  }
  for (const r of grouped) {
    const key = r.is_portabilidad ? 'Portabilidades' : 'Líneas Nuevas'
    const n = Number(r.count)
    rows[key].byWeek[r.bucket] = (rows[key].byWeek[r.bucket] ?? 0) + n
    rows[key].total += n
  }
  return [
    { name: 'Líneas Nuevas', ...rows['Líneas Nuevas'] },
    { name: 'Portabilidades', ...rows.Portabilidades },
  ]
}

/**
 * Confirmed sales by Tipo de SIM × ISO week. Category resolved through
 * payment→order→items→serializedItem→category, mapped to 3 fixed buckets +
 * "Otros SIMs". Same COMPLETED base as getSalesByWeek → totals reconcile.
 * The 3 fixed rows are always present (fixed order); "Otros SIMs" only if > 0.
 */
export async function getSalesBySimTypeWeekly(
  orgId: string,
  range: AggregationRange,
): Promise<Array<{ name: SimBucket; byWeek: Record<string, number>; total: number }>> {
  const rows = await prisma.$queryRaw<Array<{ bucket: string; category_name: string | null; count: bigint }>>(
    categoriaPorVentaSql(orgId, range, isoWeekKeySql('cv."created_at"', VENUE_TIMEZONE_DEFAULT)),
  )
  const acc = new Map<SimBucket, { byWeek: Record<string, number>; total: number }>()
  const ensure = (b: SimBucket) => {
    let r = acc.get(b)
    if (!r) {
      r = { byWeek: {}, total: 0 }
      acc.set(b, r)
    }
    return r
  }
  for (const b of SIM_FIXED_BUCKETS) ensure(b) // las filas fijas siempre presentes
  for (const row of rows) {
    const r = ensure(toSimBucket(row.category_name))
    const n = Number(row.count)
    r.byWeek[row.bucket] = (r.byWeek[row.bucket] ?? 0) + n
    r.total += n
  }
  const ordered: SimBucket[] = [...SIM_FIXED_BUCKETS]
  const others = acc.get(SIM_OTHERS)
  if (others && others.total > 0) ordered.push(SIM_OTHERS)
  return ordered.map(name => ({ name, ...ensure(name) }))
}

/** Sales grouped by venue.city × month. */
export async function getSalesByCity(
  orgId: string,
  range: AggregationRange,
): Promise<Array<{ city: string; byMonth: Record<string, number>; total: number }>> {
  const bucket = monthBucketSql('sv."createdAt"', VENUE_TIMEZONE_DEFAULT)

  const rows = await prisma.$queryRaw<Array<{ city: string | null; bucket: string; count: bigint }>>(Prisma.sql`
    SELECT v."city"              AS city,
           ${Prisma.raw(bucket)} AS bucket,
           COUNT(*)              AS count
    ${completedSalesFromWhere(orgId, range)}
    GROUP BY v."city", ${Prisma.raw(bucket)}
    ORDER BY v."city", bucket
  `)

  const map = new Map<string, Record<string, number>>()
  for (const r of rows) {
    // Varias sucursales de PlayTelecom no tienen ciudad capturada; se agrupan juntas,
    // igual que antes.
    const city = r.city || 'Sin ciudad'
    const row = map.get(city) ?? {}
    row[r.bucket] = (row[r.bucket] ?? 0) + Number(r.count)
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
/** One MANAGER (ADMIN fallback) per venue, deterministic by staffId asc. Shared by supervisor aggregations. */
export async function resolveSupervisorByVenue(venueIds: string[]): Promise<Map<string, { id: string; name: string }>> {
  const supervisorByVenue = new Map<string, { id: string; name: string }>()
  if (venueIds.length === 0) return supervisorByVenue
  const venueManagers = await prisma.staffVenue.findMany({
    where: { venueId: { in: venueIds }, role: { in: ['ADMIN', 'MANAGER'] }, active: true },
    orderBy: { staffId: 'asc' },
    include: { staff: { select: { id: true, firstName: true, lastName: true } } },
  })
  for (const role of ['MANAGER', 'ADMIN'] as const) {
    for (const sv of venueManagers) {
      if (sv.role !== role) continue
      if (!supervisorByVenue.has(sv.venueId)) {
        supervisorByVenue.set(sv.venueId, { id: sv.staff.id, name: `${sv.staff.firstName} ${sv.staff.lastName}`.trim() })
      }
    }
  }
  return supervisorByVenue
}

export interface OrgStructureStore {
  venueId: string
  venueName: string
  promoters: Array<{ staffId: string; name: string }>
}
export interface OrgStructure {
  supervisors: Array<{ supervisorId: string; supervisorName: string; stores: OrgStructureStore[] }>
  unassignedStores: OrgStructureStore[]
}

/**
 * Org roster: supervisor (venue MANAGER, ADMIN fallback) → their stores → promoters
 * (StaffVenue role CASHIER/WAITER). Includes stores with zero sales. Venues with no
 * MANAGER/ADMIN land in `unassignedStores`.
 */
export async function getOrgStructure(orgId: string): Promise<OrgStructure> {
  const venues = await prisma.venue.findMany({ where: { organizationId: orgId }, select: { id: true, name: true } })
  const venueIds = venues.map(v => v.id)
  const supervisorByVenue = await resolveSupervisorByVenue(venueIds)
  const promoterRows =
    venueIds.length === 0
      ? []
      : await prisma.staffVenue.findMany({
          where: { venueId: { in: venueIds }, active: true, role: { in: ['CASHIER', 'WAITER'] } },
          select: { venueId: true, staff: { select: { id: true, firstName: true, lastName: true } } },
        })
  const promotersByVenue = new Map<string, Array<{ staffId: string; name: string }>>()
  for (const r of promoterRows) {
    const list = promotersByVenue.get(r.venueId) ?? []
    list.push({ staffId: r.staff.id, name: `${r.staff.firstName} ${r.staff.lastName}`.trim() })
    promotersByVenue.set(r.venueId, list)
  }
  const storeOf = (v: { id: string; name: string }): OrgStructureStore => ({
    venueId: v.id,
    venueName: v.name,
    promoters: promotersByVenue.get(v.id) ?? [],
  })

  const bySupervisor = new Map<string, { supervisorName: string; stores: OrgStructureStore[] }>()
  const unassignedStores: OrgStructureStore[] = []
  for (const v of venues) {
    const sup = supervisorByVenue.get(v.id)
    if (!sup) {
      unassignedStores.push(storeOf(v))
      continue
    }
    const entry = bySupervisor.get(sup.id) ?? { supervisorName: sup.name, stores: [] }
    entry.stores.push(storeOf(v))
    bySupervisor.set(sup.id, entry)
  }
  return {
    supervisors: Array.from(bySupervisor.entries()).map(([supervisorId, e]) => ({
      supervisorId,
      supervisorName: e.supervisorName,
      stores: e.stores,
    })),
    unassignedStores,
  }
}

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
  const week = weekLabelSql('sv."createdAt"', VENUE_TIMEZONE_DEFAULT)
  const month = monthBucketSql('sv."createdAt"', VENUE_TIMEZONE_DEFAULT)

  const grouped = await prisma.$queryRaw<Array<{ venue_id: string; week: string; month: string; count: bigint }>>(
    Prisma.sql`
      SELECT sv."venueId"         AS venue_id,
             ${Prisma.raw(week)}  AS week,
             ${Prisma.raw(month)} AS month,
             COUNT(*)             AS count
      ${completedSalesFromWhere(orgId, range)}
      GROUP BY sv."venueId", ${Prisma.raw(week)}, ${Prisma.raw(month)}
      ORDER BY sv."venueId", month, week
    `,
  )

  // La atribución de supervisor se queda en JS a propósito: es una regla de NEGOCIO
  // (MANAGER primero, ADMIN de respaldo, desempate determinista por staffId) sobre ~39
  // sucursales, no sobre miles de filas. Bajarla a SQL la volvería un JOIN con subconsulta
  // difícil de leer, para ahorrar un costo que no existe.
  const venueIds = Array.from(new Set(grouped.map(r => r.venue_id).filter(Boolean)))
  const supervisorByVenue = await resolveSupervisorByVenue(venueIds)

  const map = new Map<string, { name: string; byWeek: Record<string, number>; byMonth: Record<string, number> }>()
  for (const r of grouped) {
    const supervisor = supervisorByVenue.get(r.venue_id)
    const key = supervisor?.id ?? 'unassigned'
    const name = supervisor?.name ?? 'Sin supervisor'
    const n = Number(r.count)
    const row = map.get(key) ?? { name, byWeek: {}, byMonth: {} }
    row.byWeek[r.week] = (row.byWeek[r.week] ?? 0) + n
    row.byMonth[r.month] = (row.byMonth[r.month] ?? 0) + n
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

/**
 * Confirmed (COMPLETED) sales per promoter × ISO week, attributed to the store and its
 * supervisor. One row per (promoter, store). Weeks with zero sales are absent keys.
 */
export async function getSalesByPromoterWeekly(
  orgId: string,
  range: AggregationRange,
): Promise<
  Array<{
    staffId: string
    promoterName: string
    venueId: string
    venueName: string
    supervisorId: string | null
    supervisorName: string
    byWeek: Record<string, number>
    total: number
  }>
> {
  const week = weekLabelSql('sv."createdAt"', VENUE_TIMEZONE_DEFAULT)

  const grouped = await prisma.$queryRaw<
    Array<{
      staff_id: string | null
      first_name: string | null
      last_name: string | null
      venue_id: string | null
      venue_name: string | null
      week: string
      count: bigint
    }>
  >(Prisma.sql`
    SELECT s."id"             AS staff_id,
           s."firstName"      AS first_name,
           s."lastName"       AS last_name,
           v."id"             AS venue_id,
           v."name"           AS venue_name,
           ${Prisma.raw(week)} AS week,
           COUNT(*)           AS count
    ${completedSalesFromWhere(orgId, range)}
    GROUP BY s."id", s."firstName", s."lastName", v."id", v."name", ${Prisma.raw(week)}
    ORDER BY s."id", v."id", week
  `)

  const venueIds = Array.from(new Set(grouped.map(r => r.venue_id).filter((x): x is string => !!x)))
  const supervisorByVenue = await resolveSupervisorByVenue(venueIds)

  const map = new Map<
    string,
    { staffId: string; promoterName: string; venueId: string; venueName: string; byWeek: Record<string, number> }
  >()
  for (const r of grouped) {
    // Sin promotor o sin tienda no se puede atribuir la venta: se descarta, igual que antes.
    if (!r.staff_id || !r.venue_id) continue
    const key = `${r.staff_id}|${r.venue_id}`
    const row = map.get(key) ?? {
      staffId: r.staff_id,
      promoterName: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(),
      venueId: r.venue_id,
      venueName: r.venue_name ?? 'Sin tienda',
      byWeek: {},
    }
    row.byWeek[r.week] = (row.byWeek[r.week] ?? 0) + Number(r.count)
    map.set(key, row)
  }
  return Array.from(map.values())
    .map(r => {
      const sup = supervisorByVenue.get(r.venueId)
      const total = Object.values(r.byWeek).reduce((a, b) => a + b, 0)
      return { ...r, supervisorId: sup?.id ?? null, supervisorName: sup?.name ?? 'Sin supervisor', total }
    })
    .sort((a, b) => b.total - a.total)
}

/** Sales grouped by venue × ISO week and × month. */
export async function getSalesByStore(
  orgId: string,
  range: AggregationRange,
): Promise<Array<{ venueId: string; venueName: string; byWeek: Record<string, number>; byMonth: Record<string, number>; total: number }>> {
  const week = weekLabelSql('sv."createdAt"', VENUE_TIMEZONE_DEFAULT)
  const month = monthBucketSql('sv."createdAt"', VENUE_TIMEZONE_DEFAULT)

  const rows = await prisma.$queryRaw<
    Array<{ venue_id: string; venue_name: string | null; week: string; month: string; count: bigint }>
  >(Prisma.sql`
    SELECT v."id"               AS venue_id,
           v."name"             AS venue_name,
           ${Prisma.raw(week)}  AS week,
           ${Prisma.raw(month)} AS month,
           COUNT(*)             AS count
    ${completedSalesFromWhere(orgId, range)}
    GROUP BY v."id", v."name", ${Prisma.raw(week)}, ${Prisma.raw(month)}
    ORDER BY v."id", month, week
  `)

  const map = new Map<string, { name: string; byWeek: Record<string, number>; byMonth: Record<string, number> }>()
  for (const r of rows) {
    const n = Number(r.count)
    const row = map.get(r.venue_id) ?? { name: r.venue_name ?? 'Sin tienda', byWeek: {}, byMonth: {} }
    row.byWeek[r.week] = (row.byWeek[r.week] ?? 0) + n
    row.byMonth[r.month] = (row.byMonth[r.month] ?? 0) + n
    map.set(r.venue_id, row)
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
  const bucket = monthBucketSql('sv."createdAt"', VENUE_TIMEZONE_DEFAULT)

  const rows = await prisma.$queryRaw<
    Array<{ staff_id: string | null; first_name: string | null; last_name: string | null; bucket: string; count: bigint }>
  >(Prisma.sql`
    SELECT s."id"                AS staff_id,
           s."firstName"         AS first_name,
           s."lastName"          AS last_name,
           ${Prisma.raw(bucket)} AS bucket,
           COUNT(*)              AS count
    ${completedSalesFromWhere(orgId, range)}
    GROUP BY s."id", s."firstName", s."lastName", ${Prisma.raw(bucket)}
    ORDER BY s."id", bucket
  `)

  const map = new Map<string, { name: string; byMonth: Record<string, number> }>()
  for (const r of rows) {
    // `staffId` es obligatorio en el esquema, así que "Sin promotor" es defensivo:
    // sólo aparecería si el registro quedara huérfano. Se conserva el comportamiento previo.
    const key = r.staff_id ?? 'unassigned'
    const name = r.staff_id ? `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() : 'Sin promotor'
    const row = map.get(key) ?? { name, byMonth: {} }
    row.byMonth[r.bucket] = (row.byMonth[r.bucket] ?? 0) + Number(r.count)
    map.set(key, row)
  }
  return Array.from(map.entries())
    .map(([staffId, val]) => {
      const total = Object.values(val.byMonth).reduce((a, b) => a + b, 0)
      return { staffId: staffId === 'unassigned' ? null : staffId, promoterName: val.name, byMonth: val.byMonth, total }
    })
    .sort((a, b) => b.total - a.total)
}

export interface PromoterDailyRow {
  staffId: string | null
  promoterName: string
  /** Confirmed (COMPLETED) sales per day key ("YYYY-MM-DD"). */
  byDay: Record<string, number>
  /** Confirmed total for the current month (sum of byDay). Excludes toReview. */
  total: number
  /**
   * Count of FAILED verifications created THIS month — sales the PROMOTER must
   * fix on the TPV ("Pendientes de revisar por el promotor en TPV" → current
   * month column). NOT part of `total`.
   */
  toReview: number
  /**
   * Count of still-FAILED verifications created in PREVIOUS months — sales the
   * promoter never corrected ("Meses anteriores" column). NOT part of `total`.
   */
  toReviewPrevious: number
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
 * the monthly confirmed total, and TWO "to review" counts of FAILED verifications
 * the promoter must correct on the TPV — `toReview` (created this month) and
 * `toReviewPrevious` (created in earlier months, never corrected). Neither "to
 * review" count is EVER added to `total`. Rows sorted by confirmed total desc.
 * Always the current month for the daily/total breakdown.
 */
export async function getSalesByPromoterDaily(orgId: string): Promise<PromoterDailyResult> {
  const tz = VENUE_TIMEZONE_DEFAULT

  // "Hoy" en hora del venue. Antes esto era
  // `new Date(new Date().toLocaleString('en-US', { timeZone: tz }))`, que construye la
  // fecha en la zona del PROCESO — el mes en curso podía salir distinto en dev y en prod
  // cerca de medianoche. `venueCivilDate` no depende del host.
  const hoy = venueCivilDate(new Date(), tz)
  const monthKey = `${hoy.year}-${String(hoy.month).padStart(2, '0')}`
  // Cadena explícita: `fromZonedTime` la lee en la zona del VENUE. Pasarle un `Date`
  // (como antes) la haría depender otra vez del host — es la trampa del `YYYY-MM-DD`
  // documentada en `.claude/rules/critical-warnings.md`.
  const rangeStart = fromZonedTime(`${monthKey}-01T00:00:00.000`, tz)

  // Columnas de día: 01 → hoy.
  const days: string[] = []
  for (let d = 1; d <= hoy.day; d++) days.push(`${monthKey}-${String(d).padStart(2, '0')}`)

  const dayBucket = dayBucketSql('sv."createdAt"', tz)
  const monthBucket = monthBucketSql('sv."createdAt"', tz)

  // COMPLETED se limita al mes en curso (desglose diario y total); FAILED se trae de
  // TODAS las fechas para poder partirlo en "este mes" vs "meses anteriores".
  const rows = await prisma.$queryRaw<
    Array<{
      staff_id: string | null
      first_name: string | null
      last_name: string | null
      day_key: string | null
      completed_count: bigint
      to_review: bigint
      to_review_previous: bigint
    }>
  >(Prisma.sql`
    SELECT s."id"        AS staff_id,
           s."firstName" AS first_name,
           s."lastName"  AS last_name,
           CASE WHEN sv."status" = 'COMPLETED' THEN ${Prisma.raw(dayBucket)} END AS day_key,
           COUNT(*) FILTER (WHERE sv."status" = 'COMPLETED')                                          AS completed_count,
           COUNT(*) FILTER (WHERE sv."status" = 'FAILED' AND ${Prisma.raw(monthBucket)} = ${monthKey}) AS to_review,
           COUNT(*) FILTER (WHERE sv."status" = 'FAILED' AND ${Prisma.raw(monthBucket)} <> ${monthKey}) AS to_review_previous
    FROM "SaleVerification" sv
    JOIN "Venue" v ON v."id" = sv."venueId"
    LEFT JOIN "Staff" s ON s."id" = sv."staffId"
    WHERE v."organizationId" = ${orgId}
      AND (
        (sv."status" = 'COMPLETED' AND sv."createdAt" AT TIME ZONE 'UTC' >= ${rangeStart})
        OR sv."status" = 'FAILED'
      )
    GROUP BY s."id", s."firstName", s."lastName",
             CASE WHEN sv."status" = 'COMPLETED' THEN ${Prisma.raw(dayBucket)} END
  `)

  const map = new Map<string, PromoterDailyRow>()
  for (const r of rows) {
    const key = r.staff_id ?? 'unassigned'
    const row =
      map.get(key) ??
      ({
        staffId: r.staff_id,
        promoterName: r.staff_id ? `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() : 'Sin promotor',
        byDay: {},
        total: 0,
        toReview: 0,
        toReviewPrevious: 0,
      } as PromoterDailyRow)

    if (r.day_key) {
      const n = Number(r.completed_count)
      row.byDay[r.day_key] = (row.byDay[r.day_key] ?? 0) + n
      row.total += n
    }
    // Los "por revisar" NUNCA se suman a `total`: son ventas que el promotor debe corregir
    // en el TPV, no ventas confirmadas.
    row.toReview += Number(r.to_review)
    row.toReviewPrevious += Number(r.to_review_previous)
    map.set(key, row)
  }

  const rowsOrdenadas = Array.from(map.values()).sort((a, b) => b.total - a.total)
  return { month: monthKey, days, rows: rowsOrdenadas }
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

export type EditableForm = 'CASH' | 'CARD' | 'OTHER'

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
  if (params.paymentForm != null && !['CASH', 'CARD', 'OTHER'].includes(params.paymentForm)) {
    throw createServiceError('Forma de pago inválida', 400)
  }
  if (params.status != null && !['PENDING', 'COMPLETED', 'FAILED', 'REJECTED'].includes(params.status)) {
    throw createServiceError('Estado inválido', 400)
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
    // 1. Payment (monto / forma de pago). Only rewrite `method` when the user
    // actually changed the payment-form bucket — otherwise an unrelated edit would
    // silently flip e.g. DEBIT_CARD → CREDIT_CARD (both render as "Tarjeta").
    const methodChanged =
      params.paymentForm != null && existing.payment != null && derivePaymentForm(existing.payment.method) !== params.paymentForm
    if (existing.payment && (params.amount != null || methodChanged)) {
      await tx.payment.update({
        where: { id: existing.payment.id },
        data: {
          ...(params.amount != null ? { amount: params.amount } : {}),
          ...(methodChanged ? { method: PAYMENT_FORM_TO_METHOD[params.paymentForm!] } : {}),
        },
      })
    }

    // 2. SaleVerification (tipo de venta + estado + metadata de revisión).
    // Only touch reviewer metadata when the status actually TRANSITIONS — editing
    // data on an already-COMPLETED sale must not rewrite who/when it was approved.
    const statusChanged = nextStatus !== existing.status
    const reviewMeta = !statusChanged
      ? {}
      : nextStatus === 'PENDING'
        ? { reviewedById: null, reviewedAt: null, reviewNotes: null, rejectionReasons: [] }
        : nextStatus === 'COMPLETED'
          ? { reviewedById: params.editedById, reviewedAt: new Date(), rejectionReasons: [] }
          : { reviewedById: params.editedById, reviewedAt: new Date(), reviewNotes: null, rejectionReasons: [] } // FAILED / REJECTED: stamp reviewer, clear stale notes/reasons (P1 doesn't collect a promoter note on edit)

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
            method: methodChanged ? PAYMENT_FORM_TO_METHOD[params.paymentForm!] : before.method,
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
      reviewedBy: updated.reviewedBy ? `${updated.reviewedBy.firstName} ${updated.reviewedBy.lastName}`.trim() : null,
    })
  } catch (err: any) {
    logger.warn(`[SALE_VERIFICATION_EDIT] socket emit failed for staff ${existing.staffId}: ${err?.message ?? err}`)
  }

  return updated
}

// Utility — parse a single query date as a venue-local day boundary, converted
// to the UTC instant stored in the DB. A malformed/invalid string is IGNORED
// (returns undefined → the bound is simply not applied, matching "no param =
// no filter") so it never reaches Prisma as `new Date("Invalid Date")`, which
// Prisma rejects with a 500.
function parseVenueDayBoundary(dateStr: string, boundary: 'start' | 'end'): Date | undefined {
  // Expect a calendar day "YYYY-MM-DD" in venue-local time.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return undefined
  const time = boundary === 'end' ? 'T23:59:59.999' : 'T00:00:00'
  const local = new Date(`${dateStr}${time}`)
  if (Number.isNaN(local.getTime())) return undefined // shape ok but not a real date (e.g. 2026-13-99)
  return fromZonedTime(local, VENUE_TIMEZONE_DEFAULT)
}

// Utility — parse query dates with venue-timezone-aware day boundaries
export function parseRange(fromDateStr?: string, toDateStr?: string): AggregationRange {
  const range: AggregationRange = {}
  if (fromDateStr) {
    const from = parseVenueDayBoundary(fromDateStr, 'start')
    if (from) range.fromDate = from
  }
  if (toDateStr) {
    const to = parseVenueDayBoundary(toDateStr, 'end')
    if (to) range.toDate = to
  }
  return range
}
