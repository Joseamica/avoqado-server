/**
 * Rappi 2b, P3 (decisión del founder «A», 23-oct): la lista «Rappi · por cobrar» que las apps muestran arriba en «Pedidos en línea».
 * Pedidos de plataforma que el negocio cobra en efectivo con su repartidor (`thirdPartyCashDue` no nulo: lo escribe SÓLO la ingesta),
 * vivos y sin saldar, con lo que falta por partes (`saldoDeCobroDeReparto`). Al cobrarlos (el «Cobrar» de Pedidos 1c) salen solos.
 *
 * 🔴 Acotada por el servidor (regla de capacidad): ventana de 2 días, tope de 50 y el total exacto visible.
 */
import { OrderStatus, PaymentStatus, Prisma } from '@prisma/client'
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

export async function listDeliveryCashPending(p: {
  venueId: string
  now?: Date
}): Promise<{ orders: DeliveryCashPendingOrder[]; total: number; truncated: boolean }> {
  const desde = new Date((p.now ?? new Date()).getTime() - VENTANA_MS)
  const where = {
    venueId: p.venueId,
    thirdPartyCashDue: { not: null },
    paymentStatus: { in: [PaymentStatus.PENDING, PaymentStatus.PARTIAL] },
    status: { notIn: [OrderStatus.CANCELLED, OrderStatus.DELETED] },
    createdAt: { gte: desde },
  }
  const [filas, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: DELIVERY_CASH_PENDING_LIMIT,
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
        payments: {
          where: { status: 'COMPLETED' },
          select: { amount: true, tipAmount: true, type: true, thirdPartyCashAmount: true },
          take: 20,
        },
      },
    }),
    prisma.order.count({ where }),
  ])

  const orders = filas.flatMap(o => {
    const saldo = saldoDeCobroDeReparto(o, o.payments)
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
  return { orders, total, truncated: total > filas.length }
}
