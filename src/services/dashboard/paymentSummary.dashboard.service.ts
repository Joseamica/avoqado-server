/**
 * Resumen de /payments para el dashboard — conteos por estado y sumas, en Postgres.
 *
 * 2026-09-01 (incidente del query-guard): `Payments.tsx` pedía el listado con
 * `pageSize: 10000` para contar las pestañas y sumar las tarjetas en el navegador
 * (Testarudo: 10,000 filas, 37 veces en 6 h, 3.4 s de promedio). Este servicio
 * contesta lo mismo con UN `GROUP BY` por estado×tipo, y el dashboard suma grupos en
 * vez de filas.
 *
 * 🔴 El `WHERE` de aquí tiene que decir EXACTAMENTE lo mismo que
 * `buildPaymentsWhereClause` (el del listado y el export). Prisma no puede expresar el
 * único filtro que faltaba en SQL (`amount + tipAmount` entre dos valores), así que el
 * resumen va en SQL crudo y la paridad se PRUEBA contra base real
 * (`tests/integration/dashboard/listSummary-sql-parity.integration.test.ts`): para cada
 * combinación de filtros, `prisma.payment.count({ where })` === `summary.total`. Cada
 * predicado de abajo lleva el nombre del predicado de Prisma que espeja. Si tocas uno,
 * toca el otro y corre esa prueba.
 *
 * Devuelve dos juegos de grupos:
 *  - `groups`: sólo con los filtros del SERVIDOR (fechas, cuentas, métodos, orígenes,
 *    personal, búsqueda) — alimenta los conteos de las pestañas.
 *  - `filteredGroups`: además con los filtros que hoy aplica el CLIENTE (subtotal,
 *    propina, total, internacional, marca) — alimenta las tarjetas.
 * El tab activo se aplica en el cliente sobre los grupos (son por estado×tipo), igual
 * que hoy, para que la semántica de las pestañas siga viviendo en un solo sitio.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import { utcTs } from '../../utils/sqlDates'
import { PaymentFilters } from './payment.dashboard.service'
import { AmountFilter, amountPredicate, andAll, decimalBind, ilikeContains, orAny, passesAmountFilter } from './listSummary.shared'
import {
  MINDFORM_NEW_VENUE_ID,
  getLegacyPayments,
  shouldIncludeLegacyPayments,
  filterLegacyRowsByMethodSource,
} from '../legacy/qrPayments.legacy.service'

/** Los filtros que hoy aplica `Payments.tsx` en el navegador, encima del listado. */
export interface PaymentClientFilters {
  subtotal?: AmountFilter
  tip?: AmountFilter
  total?: AmountFilter
  /** 'yes' | 'no'. Con los dos (o ninguno) no filtra — igual que el cliente. */
  international?: string[]
  /** Marcas en MAYÚSCULAS (VISA, MASTERCARD, AMERICAN_EXPRESS…). */
  cardBrands?: string[]
}

export interface PaymentSummaryGroup {
  status: string
  type: string | null
  count: number
  amount: number
  tipAmount: number
}

export interface PaymentsSummary {
  groups: PaymentSummaryGroup[]
  filteredGroups: PaymentSummaryGroup[]
  total: number
  filteredTotal: number
}

// ─── El WHERE, predicado por predicado (espejo de buildPaymentsWhereClause) ────

const P = Prisma.raw('p')

/** Espejo SQL de `buildPaymentsWhereClause(venueId, filters)`. */
export function paymentsSqlScope(venueId: string, filters?: PaymentFilters): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    // { venueId }
    Prisma.sql`${P}."venueId" = ${venueId}`,
    // { status: { not: 'PENDING' } }
    Prisma.sql`${P}."status"::text <> 'PENDING'`,
  ]
  if (!filters) return andAll(parts)

  // { merchantAccountId: { in } } | { merchantAccountId }
  if (filters.merchantAccountIds && filters.merchantAccountIds.length > 0) {
    parts.push(Prisma.sql`${P}."merchantAccountId" IN (${Prisma.join(filters.merchantAccountIds)})`)
  } else if (filters.merchantAccountId) {
    parts.push(Prisma.sql`${P}."merchantAccountId" = ${filters.merchantAccountId}`)
  }
  // { method: { in } } | { method }
  if (filters.methods && filters.methods.length > 0) {
    parts.push(Prisma.sql`${P}."method"::text IN (${Prisma.join(filters.methods as string[])})`)
  } else if (filters.method) {
    parts.push(Prisma.sql`${P}."method"::text = ${filters.method as string}`)
  }
  // { source: { in } } | { source }
  if (filters.sources && filters.sources.length > 0) {
    parts.push(Prisma.sql`${P}."source"::text IN (${Prisma.join(filters.sources)})`)
  } else if (filters.source) {
    parts.push(Prisma.sql`${P}."source"::text = ${filters.source}`)
  }
  // { processedById: { in } } | { processedById }
  if (filters.staffIds && filters.staffIds.length > 0) {
    parts.push(Prisma.sql`${P}."processedById" IN (${Prisma.join(filters.staffIds)})`)
  } else if (filters.staffId) {
    parts.push(Prisma.sql`${P}."processedById" = ${filters.staffId}`)
  }
  // { createdAt: { gte, lte } } — 🔴 siempre utcTs: un bind pelón corre 6 h en local
  if (filters.startDate) parts.push(Prisma.sql`${P}."createdAt" >= ${utcTs(new Date(filters.startDate))}`)
  if (filters.endDate) parts.push(Prisma.sql`${P}."createdAt" <= ${utcTs(new Date(filters.endDate))}`)

  // { OR: [ amount≈n, tipAmount≈n, maskedPan~, referenceNumber~, authorizationNumber~, processedBy.{firstName|lastName}~ ] }
  if (filters.search) {
    const term = filters.search.trim()
    const n = parseFloat(term)
    const or: Prisma.Sql[] = []
    if (!isNaN(n)) {
      or.push(Prisma.sql`${P}."amount" >= ${decimalBind(n)} AND ${P}."amount" < ${decimalBind(n + 1)}`)
      or.push(Prisma.sql`${P}."tipAmount" >= ${decimalBind(n)} AND ${P}."tipAmount" < ${decimalBind(n + 1)}`)
    }
    or.push(ilikeContains(Prisma.sql`${P}."maskedPan"`, term))
    or.push(ilikeContains(Prisma.sql`${P}."referenceNumber"`, term))
    or.push(ilikeContains(Prisma.sql`${P}."authorizationNumber"`, term))
    or.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "Staff" s WHERE s."id" = ${P}."processedById" AND (${ilikeContains(
        Prisma.sql`s."firstName"`,
        term,
      )} OR ${ilikeContains(Prisma.sql`s."lastName"`, term)}))`,
    )
    parts.push(orAny(or))
  }
  return andAll(parts)
}

// ─── Los filtros del cliente, en SQL y en Node (para las filas legacy) ─────────

/** `processorData.isInternational` puede venir como boolean o como la cadena "true". */
const INTL_SQL = Prisma.sql`COALESCE(${P}."processorData"->>'isInternational', '') = 'true'`
/** `payment.cardBrand || processorData.cardBrand || ''`, en mayúsculas. */
const BRAND_SQL = Prisma.sql`UPPER(COALESCE(NULLIF(${P}."cardBrand"::text, ''), NULLIF(${P}."processorData"->>'cardBrand', ''), ''))`

function internationalWanted(filter?: string[]): 'yes' | 'no' | null {
  if (!filter || filter.length === 0) return null
  const wantYes = filter.includes('yes')
  const wantNo = filter.includes('no')
  if (wantYes && wantNo) return null
  return wantYes ? 'yes' : 'no'
}

export function paymentsClientSqlScope(client?: PaymentClientFilters): Prisma.Sql {
  if (!client) return Prisma.sql`TRUE`
  const parts: Prisma.Sql[] = []
  if (client.subtotal) parts.push(amountPredicate(Prisma.sql`${P}."amount"`, client.subtotal))
  if (client.tip) parts.push(amountPredicate(Prisma.sql`${P}."tipAmount"`, client.tip))
  if (client.total) parts.push(amountPredicate(Prisma.sql`(${P}."amount" + ${P}."tipAmount")`, client.total))
  const intl = internationalWanted(client.international)
  if (intl === 'yes') parts.push(INTL_SQL)
  if (intl === 'no') parts.push(Prisma.sql`NOT (${INTL_SQL})`)
  if (client.cardBrands && client.cardBrands.length > 0) {
    parts.push(Prisma.sql`${BRAND_SQL} IN (${Prisma.join(client.cardBrands.map(b => b.toUpperCase()))})`)
  }
  return andAll(parts)
}

export function hasClientFilters(client?: PaymentClientFilters): boolean {
  if (!client) return false
  return Boolean(
    client.subtotal ||
      client.tip ||
      client.total ||
      internationalWanted(client.international) ||
      (client.cardBrands && client.cardBrands.length > 0),
  )
}

/** La misma decisión, en Node, para una fila que no vive en Postgres (QR legacy de MindForm). */
export function paymentRowPassesClientFilters(
  row: { amount: unknown; tipAmount: unknown; cardBrand?: string | null; processorData?: unknown },
  client?: PaymentClientFilters,
): boolean {
  if (!client) return true
  const amount = Number(row.amount) || 0
  const tip = Number(row.tipAmount) || 0
  if (!passesAmountFilter(amount, client.subtotal)) return false
  if (!passesAmountFilter(tip, client.tip)) return false
  if (!passesAmountFilter(amount + tip, client.total)) return false
  const intl = internationalWanted(client.international)
  if (intl) {
    const raw = (row.processorData as any)?.isInternational
    const isIntl = raw === true || raw === 'true'
    if (intl === 'yes' ? !isIntl : isIntl) return false
  }
  if (client.cardBrands && client.cardBrands.length > 0) {
    const brand = String(row.cardBrand || (row.processorData as any)?.cardBrand || '').toUpperCase()
    if (!client.cardBrands.map(b => b.toUpperCase()).includes(brand)) return false
  }
  return true
}

// ─── Grupos ────────────────────────────────────────────────────────────────────

async function groupPayments(scope: Prisma.Sql, clientScope: Prisma.Sql): Promise<PaymentSummaryGroup[]> {
  const rows = await prisma.$queryRaw<
    Array<{ status: string; type: string | null; count: number; amount: Prisma.Decimal; tipAmount: Prisma.Decimal }>
  >`
    SELECT p."status"::text AS "status", p."type"::text AS "type",
           COUNT(*)::int AS "count",
           COALESCE(SUM(p."amount"), 0) AS "amount",
           COALESCE(SUM(p."tipAmount"), 0) AS "tipAmount"
    FROM "Payment" p
    WHERE ${scope} AND ${clientScope}
    GROUP BY p."status", p."type"
    ORDER BY p."status", p."type"
  `
  return (rows ?? []).map(r => ({
    status: r.status,
    type: r.type,
    count: r.count,
    amount: Number(r.amount),
    tipAmount: Number(r.tipAmount),
  }))
}

/** Suma filas sueltas a los grupos (las legacy de MindForm no están en Postgres). */
export function foldRowsIntoGroups(
  groups: PaymentSummaryGroup[],
  rows: Array<{ status: string; type?: string | null; amount: unknown; tipAmount: unknown }>,
): PaymentSummaryGroup[] {
  const out = groups.map(g => ({ ...g }))
  for (const row of rows) {
    const type = row.type ?? null
    let g = out.find(x => x.status === row.status && x.type === type)
    if (!g) {
      g = { status: row.status, type, count: 0, amount: 0, tipAmount: 0 }
      out.push(g)
    }
    g.count += 1
    g.amount += Number(row.amount) || 0
    g.tipAmount += Number(row.tipAmount) || 0
  }
  return out
}

export const sumGroupCount = (groups: PaymentSummaryGroup[]): number => groups.reduce((s, g) => s + g.count, 0)

export async function getPaymentsSummary(
  venueId: string,
  filters?: PaymentFilters,
  client?: PaymentClientFilters,
): Promise<PaymentsSummary> {
  if (!venueId) throw new NotFoundError('Venue ID es requerido')

  const scope = paymentsSqlScope(venueId, filters)
  const withClient = hasClientFilters(client)

  let groups = await groupPayments(scope, Prisma.sql`TRUE`)
  let filteredGroups = withClient ? await groupPayments(scope, paymentsClientSqlScope(client)) : groups

  // ─── MindForm: las filas del QR legacy viven en otra base y se suman aquí, con las
  // MISMAS puertas que el listado (pre-flight por método/origen + filtro post-fetch).
  if (venueId === MINDFORM_NEW_VENUE_ID) {
    const legacyFilter = { methods: filters?.methods as readonly string[] | undefined, sources: filters?.sources }
    if (shouldIncludeLegacyPayments(legacyFilter)) {
      const legacy = await getLegacyPayments({
        startDate: filters?.startDate,
        endDate: filters?.endDate,
        search: filters?.search,
      })
      const kept = filterLegacyRowsByMethodSource(legacy.rows, legacyFilter)
      groups = foldRowsIntoGroups(groups, kept)
      filteredGroups = withClient
        ? foldRowsIntoGroups(
            filteredGroups,
            kept.filter(r => paymentRowPassesClientFilters(r, client)),
          )
        : groups
    }
  }

  return {
    groups,
    filteredGroups,
    total: sumGroupCount(groups),
    filteredTotal: sumGroupCount(filteredGroups),
  }
}

// ─── Opciones de los filtros (antes: las 500 filas más recientes del listado) ──

export interface PaymentFilterOptions {
  merchantAccounts: Array<{ id: string; displayName: string | null; externalMerchantId: string }>
  methods: string[]
  sources: string[]
  waiters: Array<{ id: string; firstName: string; lastName: string }>
  cardBrands: string[]
}

/**
 * Valores DISTINTOS que aparecen en los pagos del venue (todo el historial, no sólo
 * las 500 filas más recientes): son las opciones de las píldoras de filtro. Mismo
 * alcance base que el listado (`status <> PENDING`).
 */
export async function getPaymentFilterOptions(venueId: string): Promise<PaymentFilterOptions> {
  if (!venueId) throw new NotFoundError('Venue ID es requerido')
  const scope = paymentsSqlScope(venueId)

  const [merchantAccounts, methods, sources, waiters, cardBrands] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string; displayName: string | null; externalMerchantId: string }>>`
      SELECT m."id", m."displayName", m."externalMerchantId"
      FROM "MerchantAccount" m
      WHERE m."id" IN (SELECT DISTINCT p."merchantAccountId" FROM "Payment" p WHERE ${scope} AND p."merchantAccountId" IS NOT NULL)
      ORDER BY m."displayName" NULLS LAST, m."externalMerchantId"
    `,
    prisma.$queryRaw<Array<{ v: string }>>`
      SELECT DISTINCT p."method"::text AS "v" FROM "Payment" p WHERE ${scope} ORDER BY 1
    `,
    prisma.$queryRaw<Array<{ v: string }>>`
      SELECT DISTINCT p."source"::text AS "v" FROM "Payment" p WHERE ${scope} ORDER BY 1
    `,
    prisma.$queryRaw<Array<{ id: string; firstName: string; lastName: string }>>`
      SELECT s."id", s."firstName", s."lastName"
      FROM "Staff" s
      WHERE s."id" IN (SELECT DISTINCT p."processedById" FROM "Payment" p WHERE ${scope} AND p."processedById" IS NOT NULL)
      ORDER BY s."firstName", s."lastName", s."id"
    `,
    prisma.$queryRaw<Array<{ v: string }>>`
      SELECT DISTINCT ${BRAND_SQL} AS "v" FROM "Payment" p WHERE ${scope} ORDER BY 1
    `,
  ])

  return {
    merchantAccounts: merchantAccounts ?? [],
    methods: (methods ?? []).map(r => r.v).filter(Boolean),
    sources: (sources ?? []).map(r => r.v).filter(Boolean),
    waiters: waiters ?? [],
    cardBrands: (cardBrands ?? []).map(r => r.v).filter(Boolean),
  }
}
