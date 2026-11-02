/**
 * Rappi 2b, P3 (decisión del founder «A», 23-oct): la lista «Rappi · por cobrar» que las apps muestran arriba en «Pedidos en línea».
 * Pedidos de plataforma que el negocio cobra en efectivo con su repartidor (`thirdPartyCashDue` no nulo: lo escribe SÓLO la ingesta),
 * vivos y sin saldar, con lo que falta por partes (`saldoDeCobroDeReparto`). Al cobrarlos (el «Cobrar» de Pedidos 1c) salen solos.
 *
 * 🔴 Acotada por el servidor (regla de capacidad): ventana de 2 días, tope de 50 por página con cursor estable (`createdAt`, `id`)
 * y el total exacto visible. El saldo sale de los pagos AGREGADOS en la base (nunca una muestra), como la precuenta y el cobro.
 */
import { OrderStatus, PaymentStatus, Prisma } from '@prisma/client'
import { BadRequestError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { saldoDeCobroDeReparto } from '@/services/shared/orderBalance'

export const DELIVERY_CASH_PENDING_LIMIT = 50
const VENTANA_MS = 2 * 24 * 60 * 60 * 1000
/** Pesos (Decimal) → centavos enteros, sin pasar por float. */
const aCentavos = (d: Prisma.Decimal): number => d.mul(100).toDecimalPlaces(0).toNumber()

/** La etiqueta que ve el cajero para lo que se cobra por cuenta de la plataforma. */
const ETIQUETA_DE_TERCEROS: Record<string, string> = { RAPPI: 'Rappi' }

export interface DeliveryCashPendingOrder {
  orderId: string
  orderNumber: string
  provider: string
  status: OrderStatus
  kitchenStatus: string
  customerName: string | null
  createdAt: string
  /** Lo que la caja tiene que cobrar: venta + propina + lo de la plataforma. */
  remainingBalanceCents: number
  saleCents: number
  tipCents: number
  thirdPartyCents: number
  thirdPartyLabel: string
}

/** Cursor opaco y estable: la última fila de la página (`createdAt` ISO + `id`). */
const aCursor = (o: { createdAt: Date; id: string }) => Buffer.from(`${o.createdAt.toISOString()}|${o.id}`).toString('base64url')
const FORMA_DEL_CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|(c[a-z0-9]{24})$/
/**
 * Codex código r4: estricto, exactamente lo que `aCursor` produce. Uno alterado es un 400 (REST y MCP pasan por aquí): nunca llega a
 * Postgres (un byte nulo era un 500) ni reinicia en silencio la primera página.
 */
function deCursor(cursor: string): { createdAt: Date; id: string } {
  const m = FORMA_DEL_CURSOR.exec(Buffer.from(cursor, 'base64url').toString('utf8'))
  const createdAt = m ? new Date(m[1]) : null
  if (!m || !createdAt || Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== m[1]) {
    throw new BadRequestError('Cursor inválido')
  }
  return { createdAt, id: m[2] }
}

export async function listDeliveryCashPending(p: {
  venueId: string
  now?: Date
  /** `nextCursor` de la página anterior. */
  cursor?: string
  /** Tamaño de página; el servidor nunca entrega más de `DELIVERY_CASH_PENDING_LIMIT`. */
  limit?: number
}): Promise<{ orders: DeliveryCashPendingOrder[]; total: number; truncated: boolean; nextCursor: string | null }> {
  const desde = new Date((p.now ?? new Date()).getTime() - VENTANA_MS)
  const tope = Math.max(1, Math.min(p.limit ?? DELIVERY_CASH_PENDING_LIMIT, DELIVERY_CASH_PENDING_LIMIT))
  const where = {
    venueId: p.venueId,
    thirdPartyCashDue: { not: null },
    paymentStatus: { in: [PaymentStatus.PENDING, PaymentStatus.PARTIAL] },
    status: { notIn: [OrderStatus.CANCELLED, OrderStatus.DELETED] },
    createdAt: { gte: desde },
  }
  // Codex r5: un cursor VACÍO también es inválido (nunca reinicia la lista en silencio); sólo su ausencia da la primera página.
  const despues = p.cursor !== undefined ? deCursor(p.cursor) : null
  const [filas, total] = await Promise.all([
    prisma.order.findMany({
      where: despues
        ? { ...where, OR: [{ createdAt: { lt: despues.createdAt } }, { createdAt: despues.createdAt, id: { lt: despues.id } }] }
        : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: tope + 1,
      select: {
        id: true,
        orderNumber: true,
        source: true,
        status: true,
        kitchenStatus: true,
        customerName: true,
        createdAt: true,
        subtotal: true,
        discountAmount: true,
        serviceChargeAmount: true,
        contratoDePrecio: true,
        taxAmount: true,
        thirdPartyCashDue: true,
        cashTipDue: true,
      },
    }),
    prisma.order.count({ where }),
  ])
  const pagina = filas.slice(0, tope)
  // Codex código r3 #1: los cobros se SUMAN en la base por orden y tipo (un REFUND sigue separado), sin muestra ni tope: el saldo es
  // el mismo que el de la precuenta y el cobro, tenga los abonos que tenga.
  const sumas = pagina.length
    ? await prisma.payment.groupBy({
        by: ['orderId', 'type'],
        where: { orderId: { in: pagina.map(o => o.id) }, status: 'COMPLETED' },
        _sum: { amount: true, tipAmount: true, thirdPartyCashAmount: true },
      })
    : []
  const cobrosDe = (orderId: string) =>
    sumas
      .filter(g => g.orderId === orderId)
      .map(g => ({ amount: g._sum.amount, tipAmount: g._sum.tipAmount, thirdPartyCashAmount: g._sum.thirdPartyCashAmount, type: g.type }))

  const orders = pagina.flatMap(o => {
    const saldo = saldoDeCobroDeReparto(o, cobrosDe(o.id))
    if (!saldo) return []
    return [
      {
        orderId: o.id,
        orderNumber: o.orderNumber,
        provider: o.source,
        status: o.status,
        kitchenStatus: o.kitchenStatus,
        customerName: o.customerName,
        createdAt: o.createdAt.toISOString(),
        remainingBalanceCents: aCentavos(saldo.totalACobrar),
        saleCents: aCentavos(saldo.ventaPendiente),
        tipCents: aCentavos(saldo.propinaPendiente),
        thirdPartyCents: aCentavos(saldo.tercerosPendiente),
        thirdPartyLabel: ETIQUETA_DE_TERCEROS[o.source] ?? 'la plataforma',
      },
    ]
  })
  const hayMas = filas.length > tope
  return {
    orders,
    total,
    /** Hay más pedidos después de esta página: pídelos con `nextCursor`. */
    truncated: hayMas,
    nextCursor: hayMas ? aCursor(pagina[pagina.length - 1]) : null,
  }
}
