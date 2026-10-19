/**
 * Tarjetas de regalo — reportes del dashboard y del MCP (índice C4; spec §7 «Reportes para el contador»).
 *
 * Capacidad (`.claude/rules/bounded-queries-and-server-load.md`): todo listado pagina en el SERVIDOR (50 por default; el
 * tope de 100 lo impone este archivo aunque el cliente pida más), con orden estable y desempate por `id`, y devuelve el
 * total real; las cifras salen de agregados en SQL, nunca de sumar filas en memoria. El CSV recorre páginas acotadas y sólo
 * corre tras un clic explícito.
 *
 * Dinero: PESOS (`number` con 2 decimales) en todo lo que sale. Fechas: días del negocio (`YYYY-MM-DD` en su zona).
 * 🔴 El código de la tarjeta NUNCA sale de aquí: sólo sus últimos 4.
 */
import { GiftCardStatus, Prisma, type GiftCardActivityType, type GiftCardReason, type PaymentType } from '@prisma/client'
import type { Response } from 'express'
import prisma from '@/utils/prismaClient'
import { BadRequestError } from '@/errors/AppError'
import { formatInVenueTimezone, parseDbDateRange } from '@/utils/datetime'
import { utcTs } from '@/utils/sqlDates'
import { getVenueTimezone } from '@/services/dashboard/commission/commission-utils'
import { clampPage } from '@/services/dashboard/listSummary.shared'
import { csvField } from '@/services/dashboard/export.helpers'
import { WHERE_PAGO_CONTABILIZABLE_SIN_ESTADO_DE_ORDEN } from '@/services/fiscal/autoPosting.service'
import { SIN_VENTA, bloqueosVigentes, estadoDeCancelacionDeVenta, type CancelacionDeVenta } from './giftCardCancel.service'
import { GiftCardError } from './giftCardErrors'
import { isGiftCardTenderKind } from './giftCardTender'
import {
  WHERE_COBRO_ES_SALDO_DE_REGALO,
  WHERE_COBRO_NO_ES_SALDO_DE_REGALO,
  WHERE_ORDEN_DE_TARJETAS,
  WHERE_PAGO_PENDIENTE_DE_REVISION_CONTABLE,
} from './giftCardMarks'

export const PAGINA_DEFAULT = 50
export const PAGINA_MAXIMA = 100
export const LOTE_CSV = 500
/** Saldo vivo = lo que el negocio todavía debe. Un sobre bloqueado se sigue debiendo; uno sin cobrar, todavía no. */
const VIVOS: GiftCardStatus[] = [GiftCardStatus.ACTIVE, GiftCardStatus.BLOCKED]

// ── Lo que sale por HTTP y por el MCP ──────────────────────────────────────────────────────────────────────────────

export interface Paginated<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
}

export interface ListGiftCardsQuery {
  page?: number
  pageSize?: number
  /** Últimos 4, destinatario, comprador (nombre o contacto) o cliente del negocio. */
  search?: string
  /** Últimos 4 exactos (el MCP los pide así). */
  last4?: string
  /** Folio de la venta (`Order.orderNumber`) exacto, sin importar mayúsculas: el MCP escoge así la tarjeta (tarea 4). */
  folio?: string
  status?: EstadoDeListaDeTarjetas[]
}

/** Decisión 1 del coordinador: el filtro acepta además `EXPIRED` = ACTIVE con `expiresAt` ya pasado (comparación en UTC). */
export type EstadoDeListaDeTarjetas = GiftCardStatus | 'EXPIRED'

/** La lista del dashboard: la página, su total y el saldo de TODO el filtro (decisión 1; un solo agregado, mismo WHERE). */
export interface GiftCardListPage extends Paginated<GiftCardRow> {
  totalBalance: number
}

export interface GiftCardRow {
  id: string
  last4: string
  status: GiftCardStatus
  initialAmount: number
  balance: number
  createdAt: string
  activatedAt: string | null
  expiresAt: string | null
  deliveryChannel: string
  deliveryStatus: string
  recipientName: string | null
  purchaserName: string | null
  source: string
  customer: { id: string; name: string } | null
  order: { id: string; orderNumber: string } | null
}

export interface GiftCardActivityRow {
  id: string
  type: GiftCardActivityType
  amount: number
  balanceAfter: number
  reason: string | null
  note: string | null
  createdAt: string
  staff: { id: string; name: string } | null
  paymentId: string | null
  refundPaymentId: string | null
  orderId: string | null
}

export interface GiftCardDetail extends GiftCardRow {
  validityMonths: number | null
  termsVersion: string
  message: string | null
  recipientPhone: string | null
  recipientEmail: string | null
  purchaserContact: string | null
  deliveredAt: string | null
  deactivatedAt: string | null
  /** Se usó alguna vez (un `REDEEM` en su libreta): ya no se puede cancelar su venta ni reponer su código. */
  hasRedeem: boolean
  /** Spec §5.7: sólo un sobre sin guardar, nunca usado y vivo se repone. */
  canReplaceCode: boolean
  /**
   * Decisión 1 del coordinador: ¿se puede cancelar la VENTA de esta tarjeta, y si no, por qué? Sale de la MISMA regla que
   * `iniciarCancelacionDeVenta` (B2, `estadoDeCancelacionDeVenta`), con el texto de su rechazo en `message` (nota 2: distingue los
   * tres `NOT_PAID`). Sin venta: `{ allowed: false, reason: null, message: null }`.
   */
  cancel: CancelacionDeVenta
  /**
   * Full-testing v2 #3: la venta de la tarjeta, para que «Cancelar la venta» diga qué cancela: cuántas tarjetas tiene esa cuenta y
   * cuánto costaron (suma de `initialAmount`; los ajustes mueven el saldo, no esto). `null` sin venta. Aditivo.
   */
  sale: { cards: number; amount: number } | null
  /**
   * Auditoría r1 D-2: el bloqueo VIGENTE (último BLOCK/UNBLOCK de la libreta, con `bloqueosVigentes` de B2), leído aparte de
   * la libreta paginada. `null` si la tarjeta no está BLOCKED. El panel decide con esto el motivo que enseña.
   */
  currentBlock: { reason: GiftCardReason | null; note: string | null; at: string } | null
  activities: { items: GiftCardActivityRow[]; nextCursor: string | null; total: number }
}

export interface GiftCardSummary {
  from: string
  to: string
  timezone: string
  /** Activadas en el periodo (= vendidas y cobradas). */
  sold: { cards: number; amount: number }
  /** Saldo usado en el periodo, neto de los reversos. */
  redeemed: { movements: number; amount: number; reversed: number; net: number }
  /** Ventas canceladas en el periodo (su saldo salió de la deuda). */
  cancelled: { cards: number; amount: number }
  adjustments: { increments: number; decrements: number; net: number }
  /** Lo que se debe HOY (no al cierre del periodo: para eso, la antigüedad a una fecha). */
  liveBalance: { cards: number; amount: number; expiredAmount: number; asOf: string }
}

export type AgingBucket = '0-30' | '31-90' | '91-180' | '181-365' | '366+'
export interface GiftCardAging {
  at: string
  timezone: string
  /** Sin `expiredAmount` (auditoría r1 C-4): la vigencia de hoy no reconstruye la de un corte pasado. */
  buckets: Array<{ bucket: AgingBucket; cards: number; amount: number }>
  total: { cards: number; amount: number }
}

export type PendingAccountingKind = 'VENTA_DE_TARJETAS' | 'CANCELACION_DE_VENTA' | 'COBRO_CON_SALDO' | 'REVERSO_DE_SALDO'
export interface ListPendingQuery {
  from: string
  to: string
  page?: number
  pageSize?: number
}
export interface PendingAccountingRow {
  paymentId: string
  createdAt: string
  kind: PendingAccountingKind
  /** Pesos; un reembolso o reverso es negativo. */
  amount: number
  tipAmount: number
  method: string
  tenderLabel: string | null
  order: { id: string; orderNumber: string }
}
export interface PendingAccountingPage extends Paginated<PendingAccountingRow> {
  from: string
  to: string
  totals: Record<PendingAccountingKind, { count: number; amount: number; tipAmount: number }>
  /** Para el contador: qué falta registrar a mano y qué ya está en libros (el costo de la mercancía del canje, B4). */
  notice: string
}

// ── Utilidades ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Un `pageSize` hostil (10000, -3, 'abc') cae al tope o al default. Nunca revienta. */
export function clampTamanoDePagina(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n) || n < 1) return PAGINA_DEFAULT
  return Math.min(Math.trunc(n), PAGINA_MAXIMA)
}

const pesos = (d: Prisma.Decimal | string | number | null | undefined): number =>
  d === null || d === undefined ? 0 : Number(new Prisma.Decimal(d).toFixed(2))
const suma = (a: number, b: number): number => Number(new Prisma.Decimal(a).plus(b).toFixed(2))
const resta = (a: number, b: number): number => Number(new Prisma.Decimal(a).minus(b).toFixed(2))
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null)
const nombreDe = (p: { firstName: string | null; lastName: string | null }): string =>
  `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() || '(sin nombre)'

function rangoDelNegocio(desde: string, hasta: string, timezone: string): { from: Date; to: Date } {
  const { from, to } = parseDbDateRange(desde, hasta, timezone)
  if (from.getTime() > to.getTime()) throw new BadRequestError('La fecha inicial va después de la final.', 'GIFT_CARD_RANGE_INVALID')
  return { from, to }
}

const FILA_SELECT = Prisma.validator<Prisma.GiftCardSelect>()({
  id: true,
  codeLast4: true,
  status: true,
  initialAmount: true,
  balance: true,
  createdAt: true,
  activatedAt: true,
  expiresAt: true,
  deliveryChannel: true,
  deliveryStatus: true,
  recipientName: true,
  purchaserName: true,
  source: true,
  customerId: true,
  orderItem: { select: { orderId: true, order: { select: { orderNumber: true } } } },
})
type FilaDb = Prisma.GiftCardGetPayload<{ select: typeof FILA_SELECT }>

function aFila(t: FilaDb, clientes: Map<string, string>): GiftCardRow {
  return {
    id: t.id,
    last4: t.codeLast4,
    status: t.status,
    initialAmount: pesos(t.initialAmount),
    balance: pesos(t.balance),
    createdAt: t.createdAt.toISOString(),
    activatedAt: iso(t.activatedAt),
    expiresAt: iso(t.expiresAt),
    deliveryChannel: t.deliveryChannel,
    deliveryStatus: t.deliveryStatus,
    recipientName: t.recipientName,
    purchaserName: t.purchaserName,
    source: t.source,
    customer: t.customerId ? { id: t.customerId, name: clientes.get(t.customerId) ?? '(sin nombre)' } : null,
    order: t.orderItem ? { id: t.orderItem.orderId, orderNumber: t.orderItem.order.orderNumber } : null,
  }
}

async function nombresDeClientes(venueId: string, ids: Array<string | null>): Promise<Map<string, string>> {
  const unicos = [...new Set(ids.filter((id): id is string => !!id))]
  if (!unicos.length) return new Map()
  const filas = await prisma.customer.findMany({
    where: { venueId, id: { in: unicos } },
    select: { id: true, firstName: true, lastName: true },
    take: unicos.length,
  })
  return new Map(filas.map(c => [c.id, nombreDe(c)]))
}

/**
 * La búsqueda entera vive en el WHERE relacional de GiftCard, ANTES de paginar (auditoría r1 C-3): el cliente guardado se
 * filtra con `customer: { is: … }` dentro del mismo `OR`, nunca con una lista intermedia de ids topada (se perdían las
 * tarjetas del cliente 51 de la página Y del total). `total` y `totalBalance` usan este mismo WHERE.
 */
function busquedaWhere(termino: string): Prisma.GiftCardWhereInput {
  const palabras = termino.split(/\s+/).filter(Boolean)
  const or: Prisma.GiftCardWhereInput[] = [
    { recipientName: { contains: termino, mode: 'insensitive' } },
    { purchaserName: { contains: termino, mode: 'insensitive' } },
    { recipientEmail: { contains: termino, mode: 'insensitive' } },
    { recipientPhone: { contains: termino } },
    { purchaserContact: { contains: termino, mode: 'insensitive' } },
    {
      customer: {
        is: {
          OR: [
            {
              AND: palabras.map(p => ({
                OR: [
                  { firstName: { contains: p, mode: 'insensitive' as const } },
                  { lastName: { contains: p, mode: 'insensitive' as const } },
                ],
              })),
            },
            { email: { contains: termino, mode: 'insensitive' } },
            { phone: { contains: termino } },
          ],
        },
      },
    },
  ]
  if (/^[0-9A-Za-z]{4}$/.test(termino)) or.push({ codeLast4: termino.toUpperCase() })
  return { OR: or }
}

// ── Lista ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * El filtro de estado. `EXPIRED` (decisión 1) = ACTIVE con `expiresAt <= ahora` en UTC: la misma frontera que el resumen, la
 * consulta del saldo y la libreta (vencida ⇔ ya no se puede usar). ⭐ (D3 menor 6): `ACTIVE` es su complemento —ACTIVE que se puede
 * usar HOY, `expiresAt` nulo o posterior—, así «Activa» nunca trae (ni suma al saldo) una tarjeta que el panel pinta «Vencida».
 * Cualquier mezcla, o `ACTIVE`, va dentro de un `AND` para no chocar con el `OR` de la búsqueda.
 */
function filtroDeEstados(estados: EstadoDeListaDeTarjetas[], ahora: Date): Prisma.GiftCardWhereInput {
  const otros = estados.filter((e): e is GiftCardStatus => e !== 'EXPIRED' && e !== GiftCardStatus.ACTIVE)
  const clausulas: Prisma.GiftCardWhereInput[] = []
  if (otros.length > 0) clausulas.push({ status: { in: otros } })
  if (estados.includes(GiftCardStatus.ACTIVE)) {
    clausulas.push({ status: GiftCardStatus.ACTIVE, OR: [{ expiresAt: null }, { expiresAt: { gt: ahora } }] })
  }
  if (estados.includes('EXPIRED')) clausulas.push({ status: GiftCardStatus.ACTIVE, expiresAt: { lte: ahora } })
  if (clausulas.length === 1 && !clausulas[0].OR) return clausulas[0]
  return { AND: [{ OR: clausulas }] }
}

export async function listGiftCards(venueId: string, q: ListGiftCardsQuery, ahora: Date = new Date()): Promise<GiftCardListPage> {
  const page = clampPage(q.page)
  const pageSize = clampTamanoDePagina(q.pageSize)
  const termino = q.search?.trim() || undefined
  const folio = q.folio?.trim() || undefined
  const where: Prisma.GiftCardWhereInput = {
    venueId,
    ...(q.status?.length ? filtroDeEstados(q.status, ahora) : {}),
    ...(q.last4 ? { codeLast4: q.last4.toUpperCase() } : {}),
    ...(folio ? { orderItem: { is: { order: { orderNumber: { equals: folio, mode: 'insensitive' as const } } } } } : {}),
    ...(termino ? busquedaWhere(termino) : {}),
  }
  // Total y saldo del filtro en UN agregado con el MISMO where (decisión 1): nunca la suma de la página.
  const [agregado, filas] = await Promise.all([
    prisma.giftCard.aggregate({ where, _count: { _all: true }, _sum: { balance: true } }),
    prisma.giftCard.findMany({
      where,
      select: FILA_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])
  const nombres = await nombresDeClientes(
    venueId,
    filas.map(f => f.customerId),
  )
  return {
    items: filas.map(f => aFila(f, nombres)),
    page,
    pageSize,
    total: agregado._count._all,
    totalBalance: pesos(agregado._sum.balance),
  }
}

// ── Detalle con su libreta (cursor) ─────────────────────────────────────────────────────────────────────────────────

function escribirCursor(a: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ c: a.createdAt.toISOString(), i: a.id })).toString('base64url')
}

function leerCursor(raw: string): { createdAt: Date; id: string } {
  try {
    const { c, i } = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { c?: unknown; i?: unknown }
    const createdAt = new Date(String(c))
    if (typeof i !== 'string' || !i || Number.isNaN(createdAt.getTime())) throw new Error('cursor')
    return { createdAt, id: i }
  } catch {
    throw new BadRequestError('El cursor de la libreta no es válido. Vuelve a abrir la tarjeta.', 'GIFT_CARD_CURSOR_INVALID')
  }
}

const ACTIVIDAD_SELECT = Prisma.validator<Prisma.GiftCardActivitySelect>()({
  id: true,
  type: true,
  amount: true,
  balanceAfter: true,
  reason: true,
  note: true,
  createdAt: true,
  staffId: true,
  paymentId: true,
  refundPaymentId: true,
  orderId: true,
})

export async function getGiftCardDetail(
  venueId: string,
  giftCardId: string,
  q: { cursor?: string; limit?: number },
): Promise<GiftCardDetail> {
  const tarjeta = await prisma.giftCard.findFirst({
    where: { id: giftCardId, venueId },
    select: {
      ...FILA_SELECT,
      validityMonths: true,
      termsVersion: true,
      message: true,
      recipientPhone: true,
      recipientEmail: true,
      purchaserContact: true,
      deliveredAt: true,
      deactivatedAt: true,
    },
  })
  if (!tarjeta) throw new GiftCardError('GIFT_CARD_NOT_FOUND', 'No encontramos esa tarjeta de regalo en este negocio.', 404)

  const limit = clampTamanoDePagina(q.limit)
  const cursor = q.cursor ? leerCursor(q.cursor) : null
  const base = { giftCardId, venueId }
  const [total, usos, filas] = await Promise.all([
    prisma.giftCardActivity.count({ where: base }),
    prisma.giftCardActivity.count({ where: { ...base, type: 'REDEEM' } }),
    prisma.giftCardActivity.findMany({
      where: cursor
        ? { ...base, OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }
        : base,
      select: ACTIVIDAD_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    }),
  ])
  const hayMas = filas.length > limit
  const pagina = hayMas ? filas.slice(0, limit) : filas
  const idsStaff = [...new Set(pagina.map(a => a.staffId).filter((id): id is string => !!id))]
  const staff = idsStaff.length
    ? await prisma.staff.findMany({
        where: { id: { in: idsStaff } },
        select: { id: true, firstName: true, lastName: true },
        take: idsStaff.length,
      })
    : []
  const nombresStaff = new Map(staff.map(s => [s.id, nombreDe(s)]))
  const clientes = await nombresDeClientes(venueId, [tarjeta.customerId])
  const vivo = tarjeta.status === GiftCardStatus.ACTIVE || tarjeta.status === GiftCardStatus.BLOCKED
  // Decisión 1 del coordinador: la misma regla que `iniciarCancelacionDeVenta` (B2), leída sin candados.
  const cancel: CancelacionDeVenta = tarjeta.orderItem ? await estadoDeCancelacionDeVenta(venueId, tarjeta.orderItem.orderId) : SIN_VENTA
  const venta = tarjeta.orderItem
    ? await prisma.giftCard.aggregate({
        where: { venueId, orderItem: { is: { orderId: tarjeta.orderItem.orderId } } },
        _count: { _all: true },
        _sum: { initialAmount: true },
      })
    : null
  const sale = venta ? { cards: venta._count._all, amount: pesos(venta._sum.initialAmount) } : null
  // Auditoría r1 D-2: el bloqueo VIGENTE sale de su propia lectura (último BLOCK/UNBLOCK, una consulta por el índice
  // `[giftCardId, createdAt]`, la misma lógica de B2), nunca de la página de la libreta: tras muchos ajustes con la tarjeta
  // bloqueada, el BLOCK ya no está en la primera página. Sólo se consulta si la tarjeta está BLOCKED.
  const bloqueo = tarjeta.status === GiftCardStatus.BLOCKED ? (await bloqueosVigentes(prisma, [giftCardId])).get(giftCardId) : undefined
  const currentBlock: GiftCardDetail['currentBlock'] = bloqueo
    ? { reason: bloqueo.reason, note: bloqueo.note, at: bloqueo.at.toISOString() }
    : null

  return {
    ...aFila(tarjeta, clientes),
    validityMonths: tarjeta.validityMonths,
    termsVersion: tarjeta.termsVersion,
    message: tarjeta.message,
    recipientPhone: tarjeta.recipientPhone,
    recipientEmail: tarjeta.recipientEmail,
    purchaserContact: tarjeta.purchaserContact,
    deliveredAt: iso(tarjeta.deliveredAt),
    deactivatedAt: iso(tarjeta.deactivatedAt),
    hasRedeem: usos > 0,
    canReplaceCode: tarjeta.customerId === null && usos === 0 && vivo,
    cancel,
    sale,
    currentBlock,
    activities: {
      items: pagina.map(a => ({
        id: a.id,
        type: a.type,
        amount: pesos(a.amount),
        balanceAfter: pesos(a.balanceAfter),
        reason: a.reason,
        note: a.note,
        createdAt: a.createdAt.toISOString(),
        staff: a.staffId ? { id: a.staffId, name: nombresStaff.get(a.staffId) ?? '(sin nombre)' } : null,
        paymentId: a.paymentId,
        refundPaymentId: a.refundPaymentId,
        orderId: a.orderId,
      })),
      nextCursor: hayMas ? escribirCursor(pagina[pagina.length - 1]) : null,
      total,
    },
  }
}

// ── Resumen del periodo ─────────────────────────────────────────────────────────────────────────────────────────────

const WHERE_DESACTIVACION_DE_SOBRE_NUNCA_COBRADO = {
  type: 'DEACTIVATE',
  amount: { lte: 0 },
  giftCard: { activities: { none: { type: 'ACTIVATE' } } },
} satisfies Prisma.GiftCardActivityWhereInput

export async function getGiftCardSummary(venueId: string, r: { from: string; to: string }): Promise<GiftCardSummary> {
  const timezone = await getVenueTimezone(venueId)
  const { from, to } = rangoDelNegocio(r.from, r.to, timezone)
  const ahora = new Date()
  const vivos: Prisma.GiftCardWhereInput = { venueId, status: { in: VIVOS }, balance: { gt: 0 } }
  const [porTipo, vivo, vencido] = await Promise.all([
    prisma.giftCardActivity.groupBy({
      by: ['type'],
      // M4 (cierre): la desactivación de $0 de un sobre que nunca se activó (la cuenta se canceló sin pagar) no es una tarjeta
      // «cancelada»: nunca se vendió. Las de $0 de una tarjeta que sí se activó (se gastó completa) siguen contando.
      where: { venueId, createdAt: { gte: from, lte: to }, NOT: WHERE_DESACTIVACION_DE_SOBRE_NUNCA_COBRADO },
      _sum: { amount: true },
      _count: { _all: true },
      orderBy: { type: 'asc' },
    }),
    prisma.giftCard.aggregate({ where: vivos, _sum: { balance: true }, _count: { _all: true } }),
    prisma.giftCard.aggregate({ where: { ...vivos, expiresAt: { lte: ahora } }, _sum: { balance: true } }),
  ])
  const de = (tipo: GiftCardActivityType) => {
    const g = porTipo.find(x => x.type === tipo)
    return { n: g?._count?._all ?? 0, monto: pesos(g?._sum?.amount ?? null) }
  }
  const activadas = de('ACTIVATE')
  const usadas = de('REDEEM')
  const revertidas = de('REDEEM_REVERSAL')
  const canceladas = de('DEACTIVATE')
  const suben = de('ADJUST_INCREMENT')
  const bajan = de('ADJUST_DECREMENT')
  return {
    from: r.from,
    to: r.to,
    timezone,
    sold: { cards: activadas.n, amount: activadas.monto },
    redeemed: { movements: usadas.n, amount: usadas.monto, reversed: revertidas.monto, net: resta(usadas.monto, revertidas.monto) },
    cancelled: { cards: canceladas.n, amount: canceladas.monto },
    adjustments: { increments: suben.monto, decrements: bajan.monto, net: resta(suben.monto, bajan.monto) },
    liveBalance: {
      cards: vivo._count._all,
      amount: pesos(vivo._sum.balance),
      expiredAmount: pesos(vencido._sum.balance),
      asOf: ahora.toISOString(),
    },
  }
}

// ── Saldo vivo a una fecha, por antigüedad ──────────────────────────────────────────────────────────────────────────

const ORDEN_DE_CUBOS: AgingBucket[] = ['0-30', '31-90', '91-180', '181-365', '366+']

/**
 * El saldo de cada sobre AL CIERRE del día `at` del negocio es el `balanceAfter` de su último renglón hasta ese instante
 * (la libreta sólo inserta: es la historia exacta). Un `LATERAL … LIMIT 1` por sobre usa el índice `[giftCardId, createdAt]`.
 * Los sobres se agrupan por días desde su activación. Sin desglose de «vencido al corte» (auditoría r1 C-4): la vigencia de
 * HOY (`GiftCard.expiresAt`, que un reverso puede extender) no reconstruye la de un corte pasado.
 */
export async function getGiftCardLiabilityAging(venueId: string, at: string): Promise<GiftCardAging> {
  const timezone = await getVenueTimezone(venueId)
  const { to: fin } = parseDbDateRange(at, at, timezone)
  const filas = await prisma.$queryRaw<Array<{ bucket: AgingBucket; cards: number; amount: string }>>(Prisma.sql`
    WITH saldo AS (
      SELECT g."activatedAt", ult."balanceAfter" AS saldo
      FROM "GiftCard" g
      CROSS JOIN LATERAL (
        SELECT a."balanceAfter"
        FROM "GiftCardActivity" a
        WHERE a."giftCardId" = g.id AND a."createdAt" <= ${utcTs(fin)}
        ORDER BY a."createdAt" DESC, a.id DESC
        LIMIT 1
      ) ult
      WHERE g."venueId" = ${venueId} AND g."activatedAt" IS NOT NULL AND g."activatedAt" <= ${utcTs(fin)}
    )
    SELECT
      CASE
        WHEN s."activatedAt" > ${utcTs(fin)} - INTERVAL '30 days' THEN '0-30'
        WHEN s."activatedAt" > ${utcTs(fin)} - INTERVAL '90 days' THEN '31-90'
        WHEN s."activatedAt" > ${utcTs(fin)} - INTERVAL '180 days' THEN '91-180'
        WHEN s."activatedAt" > ${utcTs(fin)} - INTERVAL '365 days' THEN '181-365'
        ELSE '366+'
      END AS bucket,
      count(*)::int AS cards,
      COALESCE(sum(s.saldo), 0)::text AS amount
    FROM saldo s
    WHERE s.saldo > 0
    GROUP BY 1`)
  const buckets = ORDEN_DE_CUBOS.map(bucket => {
    const f = filas.find(x => x.bucket === bucket)
    return { bucket, cards: f?.cards ?? 0, amount: pesos(f?.amount ?? null) }
  })
  const total = buckets.reduce((t, b) => ({ cards: t.cards + b.cards, amount: suma(t.amount, b.amount) }), { cards: 0, amount: 0 })
  return { at, timezone, buckets, total }
}

// ── Pendientes de revisión contable ─────────────────────────────────────────────────────────────────────────────────

const PENDIENTE_SELECT = Prisma.validator<Prisma.PaymentSelect>()({
  id: true,
  createdAt: true,
  amount: true,
  tipAmount: true,
  method: true,
  type: true,
  tenderLabel: true,
  tenderType: { select: { systemKind: true } },
  order: { select: { id: true, orderNumber: true } },
})

function claseDe(p: { type: PaymentType | null; tenderType: { systemKind: string | null } | null }): PendingAccountingKind {
  const conSaldo = isGiftCardTenderKind(p.tenderType?.systemKind)
  const devolucion = p.type === 'REFUND'
  if (conSaldo) return devolucion ? 'REVERSO_DE_SALDO' : 'COBRO_CON_SALDO'
  return devolucion ? 'CANCELACION_DE_VENTA' : 'VENTA_DE_TARJETAS'
}

/** B4: el canje no lleva póliza de ingreso, pero el costo de su mercancía sí entra a la póliza de costo de ventas (`generateCogsPolicyForVenue`). */
export const AVISO_PENDIENTES_CONTABLES =
  'Estos cobros no generan póliza automática: regístralos a mano en la contabilidad. El costo de la mercancía que se pagó con saldo ya está en la póliza de costo de ventas; falta el ingreso del canje y, en la venta de tarjetas, el saldo que se le debe al cliente.'

/**
 * Los pagos que la contabilidad automática NO postea en la fase 1 (B4): la venta de tarjetas (y su cancelación) y el cobro
 * con saldo (y su reverso). El contador los registra a mano; la póliza de pasivo de tarjetas es la fase 2 (spec §7).
 * Las marcas son las de B1 (`giftCardMarks.ts`), las mismas que usa el autoposteo: una sola definición. Nota 1 del coordinador:
 * con `WHERE_PAGO_CONTABILIZABLE_SIN_ESTADO_DE_ORDEN` (lo que el motor admite menos «orden no cancelada»): una venta de tarjetas
 * devuelta entera deja su orden CANCELLED, y su venta y su cancelación siguen en el listado de su periodo. Los totales salen
 * de dos `groupBy` por `type` con el MISMO día y el mismo fragmento que la lista (cobros con el tender del saldo, y cobros de
 * una cuenta de tarjetas que NO son con ese tender: nunca se paga una tarjeta con otra, así que no hay doble conteo).
 * `WHERE_COBRO_NO_ES_SALDO_DE_REGALO` no usa `NOT`: con NULL excluiría en silencio los pagos sin tender.
 */
export async function listPendingAccountingReview(venueId: string, q: ListPendingQuery): Promise<PendingAccountingPage> {
  const timezone = await getVenueTimezone(venueId)
  const { from, to } = rangoDelNegocio(q.from, q.to, timezone)
  const page = clampPage(q.page)
  const pageSize = clampTamanoDePagina(q.pageSize)
  const delPeriodo = (...marcas: Prisma.PaymentWhereInput[]): Prisma.PaymentWhereInput => ({
    venueId,
    createdAt: { gte: from, lte: to },
    AND: [WHERE_PAGO_CONTABILIZABLE_SIN_ESTADO_DE_ORDEN, ...marcas],
  })
  const where = delPeriodo(WHERE_PAGO_PENDIENTE_DE_REVISION_CONTABLE)
  const conSaldo = delPeriodo(WHERE_COBRO_ES_SALDO_DE_REGALO)
  const ventaDeTarjetas = delPeriodo({ order: WHERE_ORDEN_DE_TARJETAS }, WHERE_COBRO_NO_ES_SALDO_DE_REGALO)
  const [total, filas, gruposSaldo, gruposVenta] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      select: PENDIENTE_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.payment.groupBy({
      by: ['type'],
      where: conSaldo,
      _sum: { amount: true, tipAmount: true },
      _count: { _all: true },
      orderBy: { type: 'asc' },
    }),
    prisma.payment.groupBy({
      by: ['type'],
      where: ventaDeTarjetas,
      _sum: { amount: true, tipAmount: true },
      _count: { _all: true },
      orderBy: { type: 'asc' },
    }),
  ])
  const vacio = () => ({ count: 0, amount: 0, tipAmount: 0 })
  const totals: PendingAccountingPage['totals'] = {
    VENTA_DE_TARJETAS: vacio(),
    CANCELACION_DE_VENTA: vacio(),
    COBRO_CON_SALDO: vacio(),
    REVERSO_DE_SALDO: vacio(),
  }
  const acumular = (
    clase: PendingAccountingKind,
    g: { _count: { _all: number }; _sum: { amount: Prisma.Decimal | null; tipAmount: Prisma.Decimal | null } },
  ) => {
    const t = totals[clase]
    t.count += g._count._all
    t.amount = suma(t.amount, pesos(g._sum.amount))
    t.tipAmount = suma(t.tipAmount, pesos(g._sum.tipAmount))
  }
  for (const g of gruposSaldo) acumular(g.type === 'REFUND' ? 'REVERSO_DE_SALDO' : 'COBRO_CON_SALDO', g)
  for (const g of gruposVenta) acumular(g.type === 'REFUND' ? 'CANCELACION_DE_VENTA' : 'VENTA_DE_TARJETAS', g)

  return {
    from: q.from,
    to: q.to,
    page,
    pageSize,
    total,
    totals,
    notice: AVISO_PENDIENTES_CONTABLES,
    items: filas.map(p => ({
      paymentId: p.id,
      createdAt: p.createdAt.toISOString(),
      kind: claseDe(p),
      amount: pesos(p.amount),
      tipAmount: pesos(p.tipAmount),
      method: p.method,
      tenderLabel: p.tenderLabel,
      order: { id: p.order.id, orderNumber: p.order.orderNumber },
    })),
  }
}

// ── Exportar saldos vivos (CSV) ─────────────────────────────────────────────────────────────────────────────────────

const ESTADO_ES: Record<GiftCardStatus, string> = {
  PENDING: 'Sin cobrar',
  ACTIVE: 'Activa',
  BLOCKED: 'Bloqueada',
  DEACTIVATED: 'Desactivada',
}
const ENCABEZADO = ['Últimos 4', 'Estado', 'Monto inicial', 'Saldo', 'Activada', 'Vence', 'Cliente', 'Destinatario', 'Comprador', 'Cuenta']

/** Celda CSV a prueba de fórmulas: Excel ejecuta lo que empieza con = + - @ (o tab/CR); un nombre de cliente no debe poder. */
export function celdaCsv(valor: string | number | null | undefined): string {
  if (valor === null || valor === undefined) return ''
  if (typeof valor === 'number') return csvField(valor.toFixed(2))
  return csvField(/^[=+\-@\t\r]/.test(valor) ? `'${valor}` : valor)
}

const CSV_SELECT = Prisma.validator<Prisma.GiftCardSelect>()({
  id: true,
  codeLast4: true,
  status: true,
  initialAmount: true,
  balance: true,
  activatedAt: true,
  expiresAt: true,
  customerId: true,
  recipientName: true,
  purchaserName: true,
  orderItem: { select: { order: { select: { orderNumber: true } } } },
})

/**
 * Saldos vivos de hoy, para el contador y para un negocio que se va de Avoqado (spec §7). Recorre páginas de `LOTE_CSV` por
 * `id` y las escribe al vuelo: memoria constante aunque el negocio tenga 100× las tarjetas de hoy. Sólo corre tras el clic.
 * Auditoría r1 C-5: si el receptor va lento (`write` devuelve `false`), espera `'drain'` antes de seguir —así el búfer de
 * salida nunca acumula páginas—, y si el cliente se desconecta (`'close'`) deja de consultar. Sin jobs: CSV directo.
 * C4 r1 #1: una respuesta ya destruida (el cliente se fue antes de colgar el `'close'`, p. ej. durante la lectura de la zona)
 * cuenta como cerrada: su `write` devuelve `false` y nunca emite `'drain'` ni `'close'`, así que esperarlos la colgaba para siempre.
 */
export async function streamGiftCardBalancesCsv(venueId: string, res: Response): Promise<void> {
  const timezone = await getVenueTimezone(venueId)
  const dia = (d: Date | null): string | null => (d ? formatInVenueTimezone(d, timezone, 'yyyy-MM-dd') : null)
  let cerrada = false
  /** ¿El cliente ya se fue? El `'close'` lo avisa; `destroyed`, aunque se haya ido antes de que lo escucháramos. */
  const seFue = (): boolean => (cerrada ||= res.destroyed)
  if (seFue()) return // antes de cualquier lectura de la base: no hay a quién mandarle nada
  const alCerrar = () => {
    cerrada = true
  }
  res.once('close', alCerrar)
  /** Escribe una línea; si el búfer se llenó, espera a que se vacíe o a que el cliente se vaya (nunca se cuelga). */
  const escribir = async (linea: string): Promise<void> => {
    if (seFue() || res.write(linea) || seFue()) return
    await new Promise<void>(resolve => {
      const listo = () => {
        res.off('drain', listo)
        res.off('close', listo)
        resolve()
      }
      res.once('drain', listo)
      res.once('close', listo)
    })
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="saldos-tarjetas-de-regalo-${dia(new Date())}.csv"`)
  res.setHeader('Cache-Control', 'no-store')
  try {
    await escribir(`\uFEFF${ENCABEZADO.map(c => celdaCsv(c)).join(',')}\r\n`)
    let despues: string | undefined
    while (!seFue()) {
      const lote = await prisma.giftCard.findMany({
        where: { venueId, status: { in: VIVOS }, balance: { gt: 0 }, ...(despues ? { id: { gt: despues } } : {}) },
        select: CSV_SELECT,
        orderBy: { id: 'asc' },
        take: LOTE_CSV,
      })
      const clientes = await nombresDeClientes(
        venueId,
        lote.map(t => t.customerId),
      )
      for (const t of lote) {
        if (seFue()) break
        const celdas = [
          t.codeLast4,
          ESTADO_ES[t.status],
          pesos(t.initialAmount),
          pesos(t.balance),
          dia(t.activatedAt),
          dia(t.expiresAt),
          t.customerId ? (clientes.get(t.customerId) ?? '(sin nombre)') : null,
          t.recipientName,
          t.purchaserName,
          t.orderItem?.order.orderNumber ?? null,
        ]
        await escribir(`${celdas.map(c => celdaCsv(c)).join(',')}\r\n`)
      }
      if (seFue() || lote.length < LOTE_CSV) break
      despues = lote[lote.length - 1].id
    }
  } finally {
    res.off('close', alCerrar)
  }
  if (!seFue()) res.end() // un cliente que ya se fue no tiene a quién terminarle la respuesta
}
