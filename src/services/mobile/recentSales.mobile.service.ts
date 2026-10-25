import { startOfDay, subDays } from 'date-fns'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'
import { Prisma, type OrderStatus, type PaymentMethod, type PaymentStatus, type PrismaClient } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import { utcTs } from '@/utils/sqlDates'
import {
  decodeSalesCursor,
  encodeSalesCursor,
  encodeSalesSince,
  RECENT_SALES_COPY_VERSION,
  RECENT_SALES_PAGE_MAX,
} from '@/schemas/mobile/recentSales.mobile.schema'
import { loadSalesForExchange, type LoadedSaleForExchange } from '../exchanges/exchangeSale'
import {
  loadExchangeLinksForOrders,
  paymentExchangeFields,
  saleExchangeFields,
  type ExchangeItemExtras,
  type PaymentExchangeFields,
  type SaleExchangeFields,
} from '../exchanges/exchangeDetail'

export const RECENT_SALES_DAYS = 30
export const RECENT_SALE_MAX_LINES = 200
export const RECENT_SALES_OVERLAP_MS = 120_000
export const RECENT_SALES_MAX_DELTA_AGE_MS = 7 * 86_400_000
export const RECENT_SALES_FUTURE_SKEW_MS = 300_000

export function recentSalesWindowStart(now: Date, timezone: string): Date {
  return fromZonedTime(startOfDay(subDays(toZonedTime(now, timezone), RECENT_SALES_DAYS - 1)), timezone)
}

export interface RecentSaleLine extends ExchangeItemExtras {
  id: string
  productName: string
  quantity: number
  trackInventory: boolean
  isGiftCardSale: boolean
}

export interface RecentSalePayment extends PaymentExchangeFields {
  id: string
  createdAt: string
  method: PaymentMethod
  tenderLabel: string | null
  amountCents: number
  tipCents: number
  remainingRefundableSaleCents: number
}

export interface RecentSale extends SaleExchangeFields {
  orderId: string
  orderNumber: string
  createdAt: string
  status: OrderStatus
  paymentStatus: PaymentStatus
  totalCents: number
  customer: { id: string; name: string | null } | null
  sellerName: string | null
  payments: RecentSalePayment[]
  lines: RecentSaleLine[]
}

export interface RecentSalesMeta {
  mode: 'FULL' | 'DELTA'
  reset: boolean
  total: number
  limit: number
  hasMore: boolean
  nextCursor: string | null
  nextSince: string
  windowStart: string
}

export interface RecentSalesPage {
  sales: RecentSale[]
  removed: string[]
  meta: RecentSalesMeta
}

export const SQL_IS_COPY_SALE = Prisma.sql`o."paymentStatus" IN ('PAID', 'REFUNDED') AND o.status <> 'DELETED'`
export const WHERE_IS_COPY_SALE: Prisma.OrderWhereInput = {
  paymentStatus: { in: ['PAID', 'REFUNDED'] },
  status: { not: 'DELETED' },
}

export function fullPageSql(p: {
  venueId: string
  windowStart: Date
  after: { at: Date; id: string } | null
  take: number | null
}): Prisma.Sql {
  return Prisma.sql`
    SELECT ${p.take === null ? Prisma.sql`count(*)::int AS total` : Prisma.sql`o.id, o."createdAt" AS at`}
    FROM "Order" o
    WHERE o."venueId" = ${p.venueId} AND o."createdAt" >= ${utcTs(p.windowStart)} AND ${SQL_IS_COPY_SALE}
    ${
      p.after
        ? Prisma.sql`AND o."createdAt" <= ${utcTs(p.after.at)}
      AND (o."createdAt" < ${utcTs(p.after.at)} OR o.id < ${p.after.id})`
        : Prisma.empty
    }
    ${p.take === null ? Prisma.empty : Prisma.sql`ORDER BY o."createdAt" DESC, o.id DESC LIMIT ${p.take}`}
  `
}

const personSelect = { firstName: true, lastName: true } as const
const headerSelect = {
  id: true,
  orderNumber: true,
  createdAt: true,
  status: true,
  paymentStatus: true,
  total: true,
  _count: { select: { items: true } },
  customer: { select: { id: true, ...personSelect } },
  orderCustomers: {
    where: { isPrimary: true },
    take: 1,
    orderBy: { id: 'asc' },
    select: { customer: { select: { id: true, ...personSelect } } },
  },
  servedBy: { select: personSelect },
  createdBy: { select: personSelect },
} as const satisfies Prisma.OrderSelect

const fullName = (person: { firstName: string | null; lastName: string | null } | null) =>
  person ? [person.firstName, person.lastName].filter(Boolean).join(' ').trim() || null : null

function toRecentSale(
  header: Prisma.OrderGetPayload<{ select: typeof headerSelect }>,
  sale: LoadedSaleForExchange,
  exchange: SaleExchangeFields['exchange'],
): RecentSale {
  const { fields, itemExtras } = saleExchangeFields(sale, exchange)
  const customer = header.orderCustomers[0]?.customer ?? header.customer
  return {
    ...fields,
    orderId: header.id,
    orderNumber: header.orderNumber,
    createdAt: header.createdAt.toISOString(),
    status: header.status,
    paymentStatus: header.paymentStatus,
    totalCents: Math.round(Number(header.total) * 100),
    customer: customer ? { id: customer.id, name: fullName(customer) } : null,
    sellerName: fullName(header.servedBy ?? header.createdBy),
    payments: sale.payments.map(payment => ({
      ...paymentExchangeFields(sale, payment.id),
      id: payment.id,
      createdAt: payment.createdAt.toISOString(),
      method: payment.money.method as PaymentMethod,
      tenderLabel: payment.tenderLabel,
      amountCents: payment.amountCents,
      tipCents: payment.tipCents,
      remainingRefundableSaleCents: payment.saleRemainingCents,
    })),
    lines: sale.lines.flatMap(line => {
      const extras = itemExtras.get(line.id)
      // A omits line amounts when attribution is unavailable; keep its sale-level refusal.
      return extras
        ? [
            {
              ...extras,
              id: line.id,
              productName: line.productName,
              quantity: line.quantity,
              trackInventory: line.product?.trackInventory ?? false,
              isGiftCardSale: line.giftCardId !== null,
            },
          ]
        : []
    }),
  }
}

export async function buildSalesPage(
  db: PrismaClient,
  venueId: string,
  windowStart: Date,
  candidates: string[],
  exits: string[] = [],
): Promise<Pick<RecentSalesPage, 'sales' | 'removed'>> {
  if (!candidates.length) return { sales: [], removed: [...new Set(exits)] }
  // shortcut: no read snapshot; use REPEATABLE READ per page if clients observe mixed balances.
  const headers = await db.order.findMany({
    take: candidates.length,
    where: { venueId, id: { in: candidates }, createdAt: { gte: windowStart }, ...WHERE_IS_COPY_SALE },
    select: headerSelect,
  })
  const fitting = headers.filter(header => header._count.items <= RECENT_SALE_MAX_LINES)
  const ids = fitting.map(header => header.id)
  const loaded = await loadSalesForExchange(db, venueId, ids)
  const links = await loadExchangeLinksForOrders(db, venueId, ids)
  const headerById = new Map(fitting.map(header => [header.id, header]))
  const sales: RecentSale[] = []
  const removed = new Set(exits)
  for (const id of candidates) {
    const sale = loaded.get(id)
    const header = headerById.get(id)
    if (sale && header) {
      sales.push(toRecentSale(header, sale, links.get(id) ?? { asOriginal: [], asOriginalTotal: 0, asNew: null }))
      removed.delete(id)
    } else removed.add(id)
  }
  return { sales, removed: [...removed] }
}

export async function listRecentSales(
  input: { venueId: string; since?: string; cursor?: string; limit: number; now?: Date },
  db: PrismaClient = prisma,
): Promise<RecentSalesPage> {
  const venue = await db.venue.findUnique({ where: { id: input.venueId }, select: { timezone: true } })
  if (!venue) throw new NotFoundError('No se encontró la sucursal.')
  const cursor = input.cursor === undefined ? null : decodeSalesCursor(input.cursor)
  if (input.cursor !== undefined && (!cursor || cursor.m !== 'F')) throw new BadRequestError('El cursor no es válido.')
  const t0 = cursor ? new Date(cursor.t0) : (input.now ?? new Date())
  const windowStart = cursor ? new Date(cursor.ws) : recentSalesWindowStart(t0, venue.timezone)
  const after = cursor ? { at: new Date(cursor.at), id: cursor.id } : null
  if (![t0, windowStart, ...(after ? [after.at] : [])].every(date => Number.isFinite(date.getTime())))
    throw new BadRequestError('El cursor no es válido.')
  const limit = Math.min(RECENT_SALES_PAGE_MAX, Math.max(1, Math.floor(input.limit) || RECENT_SALES_PAGE_MAX))
  const total = cursor
    ? cursor.total
    : (
        await db.$queryRaw<Array<{ total: number }>>(
          fullPageSql({
            venueId: input.venueId,
            windowStart,
            after: null,
            take: null,
          }),
        )
      )[0].total
  const rows = await db.$queryRaw<Array<{ id: string; at: Date }>>(
    fullPageSql({ venueId: input.venueId, windowStart, after, take: limit + 1 }),
  )
  const hasMore = rows.length > limit
  const consumed = rows.slice(0, limit)
  const result = await buildSalesPage(
    db,
    input.venueId,
    windowStart,
    consumed.map(row => row.id),
  )
  const last = consumed[consumed.length - 1]
  return {
    ...result,
    meta: {
      mode: 'FULL',
      reset: input.since !== undefined,
      total,
      limit,
      hasMore,
      nextCursor: hasMore
        ? encodeSalesCursor({
            v: RECENT_SALES_COPY_VERSION,
            m: 'F',
            t0: t0.getTime(),
            ws: windowStart.getTime(),
            w: null,
            ws0: null,
            total,
            at: last.at.getTime(),
            id: last.id,
          })
        : null,
      nextSince: encodeSalesSince({ v: RECENT_SALES_COPY_VERSION, w: t0.getTime() - RECENT_SALES_OVERLAP_MS, ws: windowStart.getTime() }),
      windowStart: windowStart.toISOString(),
    },
  }
}
