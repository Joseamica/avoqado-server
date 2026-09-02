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
import { normalizeNativePaymentMethods, PaymentFilters } from './payment.dashboard.service'
import { AmountFilter, amountPredicate, andAll, decimalBind, ilikeContains, orAny, passesAmountFilter } from './listSummary.shared'
import {
  MINDFORM_NEW_VENUE_ID,
  getLegacyPaymentFacets,
  forEachLegacyPaymentPage,
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
    parts.push(Prisma.sql`${P}."method"::text IN (${Prisma.join(normalizeNativePaymentMethods(filters.methods) ?? [])})`)
  } else if (filters.method) {
    const nativeMethods = normalizeNativePaymentMethods([filters.method]) ?? []
    parts.push(Prisma.sql`${P}."method"::text IN (${Prisma.join(nativeMethods)})`)
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

type GroupRow = {
  status: string
  type: string | null
  count: number
  amount: Prisma.Decimal
  tipAmount: Prisma.Decimal
  fcount: number
  famount: Prisma.Decimal
  ftipAmount: Prisma.Decimal
}

/**
 * UNA pasada sobre los pagos del alcance: los agregados "de las pestañas" y los "de las
 * tarjetas" salen del mismo escaneo con `FILTER (WHERE …)`. Sin filtros del cliente el
 * segundo juego es idéntico al primero (el FILTER es `TRUE`).
 */
async function groupPayments(
  scope: Prisma.Sql,
  clientScope: Prisma.Sql,
): Promise<{ groups: PaymentSummaryGroup[]; filteredGroups: PaymentSummaryGroup[] }> {
  const rows = await prisma.$queryRaw<GroupRow[]>`
    SELECT p."status"::text AS "status", p."type"::text AS "type",
           COUNT(*)::int AS "count",
           COALESCE(SUM(p."amount"), 0) AS "amount",
           COALESCE(SUM(p."tipAmount"), 0) AS "tipAmount",
           COUNT(*) FILTER (WHERE ${clientScope})::int AS "fcount",
           COALESCE(SUM(p."amount") FILTER (WHERE ${clientScope}), 0) AS "famount",
           COALESCE(SUM(p."tipAmount") FILTER (WHERE ${clientScope}), 0) AS "ftipAmount"
    FROM "Payment" p
    WHERE ${scope}
    GROUP BY p."status", p."type"
    ORDER BY p."status", p."type"
  `
  const all = rows ?? []
  return {
    groups: all.map(r => ({ status: r.status, type: r.type, count: r.count, amount: Number(r.amount), tipAmount: Number(r.tipAmount) })),
    // Un grupo que el filtro del cliente vacía no aparece (igual que un GROUP BY sobre el subconjunto).
    filteredGroups: all
      .filter(r => r.fcount > 0)
      .map(r => ({ status: r.status, type: r.type, count: r.fcount, amount: Number(r.famount), tipAmount: Number(r.ftipAmount) })),
  }
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

/**
 * MindForm: las filas del QR legacy viven en otra base. Se traen con las MISMAS puertas que
 * el listado (pre-flight por método/origen, filtro post-fetch); merchant/staff no aplican a
 * legacy (sus ids son nulos), exactamente como en `getPaymentsData`. Cualquier otro venue: [].
 */
async function foldLegacyPages(
  venueId: string,
  filters: PaymentFilters | undefined,
  client: PaymentClientFilters | undefined,
  groups: PaymentSummaryGroup[],
  filteredGroups: PaymentSummaryGroup[],
): Promise<{ groups: PaymentSummaryGroup[]; filteredGroups: PaymentSummaryGroup[] }> {
  if (venueId !== MINDFORM_NEW_VENUE_ID) return { groups, filteredGroups }
  const legacyFilter = {
    methods: filters?.methods ?? (filters?.method ? [filters.method] : undefined),
    sources: filters?.sources ?? (filters?.source ? [filters.source] : undefined),
  }
  if (!shouldIncludeLegacyPayments(legacyFilter)) return { groups, filteredGroups }
  const withClient = hasClientFilters(client)

  await forEachLegacyPaymentPage(
    { startDate: filters?.startDate, endDate: filters?.endDate, search: filters?.search, methods: legacyFilter.methods },
    rows => {
      const legacy = filterLegacyRowsByMethodSource(rows, legacyFilter)
      groups = foldRowsIntoGroups(groups, legacy)
      filteredGroups = withClient
        ? foldRowsIntoGroups(
            filteredGroups,
            legacy.filter(row => paymentRowPassesClientFilters(row, client)),
          )
        : groups
    },
  )
  return { groups, filteredGroups }
}

export async function getPaymentsSummary(
  venueId: string,
  filters?: PaymentFilters,
  client?: PaymentClientFilters,
): Promise<PaymentsSummary> {
  if (!venueId) throw new NotFoundError('Venue ID es requerido')

  const withClient = hasClientFilters(client)
  let { groups, filteredGroups } = await groupPayments(
    paymentsSqlScope(venueId, filters),
    withClient ? paymentsClientSqlScope(client) : Prisma.sql`TRUE`,
  )

  ;({ groups, filteredGroups } = await foldLegacyPages(venueId, filters, client, groups, filteredGroups))

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

const uniqSorted = (values: Array<string | null | undefined>): string[] =>
  Array.from(new Set(values.filter((v): v is string => Boolean(v)))).sort()

/**
 * Valores DISTINTOS que aparecen en los pagos del venue (todo el historial, no sólo las
 * 500 filas más recientes): son las opciones de las píldoras de filtro. Mismo alcance base
 * que el listado (`status <> PENDING`). UN escaneo de los pagos (`array_agg(DISTINCT …)`)
 * y dos búsquedas por id para los nombres — no cinco escaneos en paralelo.
 */
export async function getPaymentFilterOptions(venueId: string): Promise<PaymentFilterOptions> {
  if (!venueId) throw new NotFoundError('Venue ID es requerido')
  const scope = paymentsSqlScope(venueId)

  const [facets] = await prisma.$queryRaw<
    Array<{
      merchantIds: string[] | null
      methods: string[] | null
      sources: string[] | null
      staffIds: string[] | null
      brands: string[] | null
    }>
  >`
    SELECT array_agg(DISTINCT p."merchantAccountId") FILTER (WHERE p."merchantAccountId" IS NOT NULL) AS "merchantIds",
           array_agg(DISTINCT p."method"::text) AS "methods",
           array_agg(DISTINCT p."source"::text) AS "sources",
           array_agg(DISTINCT p."processedById") FILTER (WHERE p."processedById" IS NOT NULL) AS "staffIds",
           array_agg(DISTINCT ${BRAND_SQL}) FILTER (WHERE ${BRAND_SQL} <> '') AS "brands"
    FROM "Payment" p
    WHERE ${scope}
  `
  const merchantIds = facets?.merchantIds ?? []
  const staffIds = facets?.staffIds ?? []

  const [merchantAccounts, waiters] = await Promise.all([
    merchantIds.length > 0
      ? prisma.merchantAccount.findMany({
          where: { id: { in: merchantIds } },
          select: { id: true, displayName: true, externalMerchantId: true },
          orderBy: [{ displayName: 'asc' }, { externalMerchantId: 'asc' }],
        })
      : Promise.resolve([]),
    staffIds.length > 0
      ? prisma.staff.findMany({
          where: { id: { in: staffIds } },
          select: { id: true, firstName: true, lastName: true },
          orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }],
        })
      : Promise.resolve([]),
  ])

  // MindForm: las facetas salen de DISTINCT en la base legacy; nunca se materializa
  // todo el historial sólo para poblar cinco selectores.
  const legacy =
    venueId === MINDFORM_NEW_VENUE_ID
      ? await getLegacyPaymentFacets()
      : { methods: [] as string[], sources: [] as string[], cardBrands: [] as string[] }

  return {
    merchantAccounts,
    methods: uniqSorted([...(facets?.methods ?? []), ...legacy.methods]),
    sources: uniqSorted([...(facets?.sources ?? []), ...legacy.sources]),
    waiters,
    cardBrands: uniqSorted([...(facets?.brands ?? []), ...legacy.cardBrands]),
  }
}
