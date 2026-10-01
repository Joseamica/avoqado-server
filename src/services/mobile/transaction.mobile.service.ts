/**
 * Mobile Transaction Service
 *
 * Provides transaction (payment) data for the iOS/Android app.
 * Reuses query patterns from payment.dashboard.service.ts but
 * returns a lighter payload suitable for mobile clients.
 */

import { PaymentMethod, TransactionStatus } from '@prisma/client'
import { NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { listRefundsForPayment } from '../dashboard/refund.dashboard.service'
import { centavosDevueltosPorComponente, centavosYaDevueltos } from '../shared/devueltoDeUnCobro'
import { seDevuelveEnTerminal, sePuedeEscogerComoDevolver } from '../tpv/terminalRefundTarget'

export interface MobileTransactionFilters {
  search?: string
  method?: PaymentMethod
  dateFrom?: string // ISO date string
  dateTo?: string // ISO date string
}

/**
 * Get paginated transactions for a venue (mobile-optimized).
 */
export async function getTransactions(venueId: string, page: number, pageSize: number, filters?: MobileTransactionFilters) {
  if (!venueId) {
    throw new NotFoundError('Venue ID es requerido')
  }

  const skip = (page - 1) * pageSize
  const take = pageSize

  const whereClause: any = {
    venueId,
    status: {
      not: 'PENDING' as TransactionStatus,
    },
  }

  if (filters) {
    if (filters.method) {
      whereClause.method = filters.method
    }

    if (filters.dateFrom || filters.dateTo) {
      whereClause.createdAt = {}
      if (filters.dateFrom) {
        whereClause.createdAt.gte = new Date(filters.dateFrom)
      }
      if (filters.dateTo) {
        whereClause.createdAt.lte = new Date(filters.dateTo)
      }
    }

    if (filters.search) {
      const searchTerm = filters.search.trim()
      const searchNumber = parseFloat(searchTerm)

      whereClause.OR = [
        ...(isNaN(searchNumber) ? [] : [{ amount: { gte: searchNumber, lt: searchNumber + 1 } }]),
        { maskedPan: { contains: searchTerm, mode: 'insensitive' } },
        { referenceNumber: { contains: searchTerm, mode: 'insensitive' } },
        { authorizationNumber: { contains: searchTerm, mode: 'insensitive' } },
        {
          order: {
            orderNumber: { contains: searchTerm, mode: 'insensitive' },
          },
        },
        {
          processedBy: {
            OR: [{ firstName: { contains: searchTerm, mode: 'insensitive' } }, { lastName: { contains: searchTerm, mode: 'insensitive' } }],
          },
        },
      ]
    }
  }

  const [payments, total] = await prisma.$transaction([
    prisma.payment.findMany({
      where: whereClause,
      select: {
        id: true,
        amount: true,
        tipAmount: true,
        method: true,
        status: true,
        cardBrand: true,
        maskedPan: true,
        referenceNumber: true,
        createdAt: true,
        order: {
          select: {
            orderNumber: true,
          },
        },
        processedBy: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      skip,
      take,
    }),
    prisma.payment.count({
      where: whereClause,
    }),
  ])

  return {
    data: payments.map(p => ({
      id: p.id,
      amount: Number(p.amount),
      tipAmount: Number(p.tipAmount),
      method: p.method,
      status: p.status,
      cardBrand: p.cardBrand,
      maskedPan: p.maskedPan,
      referenceNumber: p.referenceNumber,
      createdAt: p.createdAt.toISOString(),
      orderNumber: p.order?.orderNumber ?? null,
      staffName: p.processedBy ? `${p.processedBy.firstName ?? ''} ${p.processedBy.lastName ?? ''}`.trim() : null,
    })),
    meta: {
      total,
      page,
      pageSize,
      pageCount: Math.ceil(total / pageSize),
    },
  }
}

/** Pesos → centavos enteros (la convención del carril de reembolso). */
const toCents = (pesos: unknown): number => Math.round(Number(pesos ?? 0) * 100)

/**
 * Get full transaction detail with order items.
 */
export async function getTransactionDetail(venueId: string, paymentId: string) {
  const payment = await prisma.payment.findFirst({
    where: {
      id: paymentId,
      venueId,
    },
    select: {
      id: true,
      amount: true,
      tipAmount: true,
      method: true,
      source: true,
      externalSource: true,
      tenderSatFormaPago: true,
      fundsFlow: true,
      tenderTypeId: true,
      tenderCountsAsCash: true,
      tenderLabel: true,
      status: true,
      cardBrand: true,
      maskedPan: true,
      referenceNumber: true,
      authorizationNumber: true,
      createdAt: true,
      processorData: true,
      processedBy: {
        select: {
          firstName: true,
          lastName: true,
        },
      },
      order: {
        select: {
          orderNumber: true,
          items: {
            select: {
              id: true,
              productName: true,
              quantity: true,
              unitPrice: true,
              total: true,
              product: {
                select: {
                  name: true,
                  imageUrl: true,
                  trackInventory: true,
                },
              },
              modifiers: {
                select: {
                  name: true,
                  price: true,
                },
              },
            },
          },
        },
      },
    },
  })

  if (!payment) {
    throw new NotFoundError(`Payment con ID ${paymentId} no encontrado`)
  }

  const refunds = payment.status !== 'PENDING' && payment.status !== 'REFUNDED' ? await listRefundsForPayment(venueId, payment.id) : []

  // Los topes cuentan EXACTAMENTE como `issueRefund` (Codex, 29-sep): sólo los reembolsos COMPLETED movieron dinero, y lo ya
  // devuelto es el MÁXIMO entre esas filas y el acumulado histórico `processorData.refundedAmountCents`. Todo en centavos
  // enteros — sumar pesos con `+` deriva (`1 − 0.67 = 0.32999999999999996`). La suma vive en `shared/devueltoDeUnCobro.ts`:
  // aquí no se reimplementa.
  // 🔴 `listRefundsForPayment` devuelve `amount` = TOTAL negativo; a esos helpers se les pasa la VENTA (`saleAmount`) y la
  // propina por separado, o la propina se contaría dos veces.
  // Un fallo de FILAS ilegibles (o de un acumulado corrupto) lanza en vez de inventar un saldo: `issueRefund` se negaría igual.
  const filas = refunds.map(refund => ({ amount: refund.saleAmount, tipAmount: refund.tipAmount, status: refund.status }))
  const originalSaleCents = toCents(payment.amount)
  const originalTipCents = toCents(payment.tipAmount)
  const yaDevueltoCents = centavosYaDevueltos({ processorData: payment.processorData, filas })
  const { salesCents: ventaDevueltaCents, tipCents: propinaDevueltaCents } = centavosDevueltosPorComponente(filas)
  const remainingRefundableCents = Math.max(0, originalSaleCents + originalTipCents - yaDevueltoCents)
  // Saldo POR COMPONENTE (aditivo): con «Incluir propina» apagada el POS sólo puede ofrecer la VENTA restante — el tope total
  // dejaba mandar $220 con `tipRefundCents: 0` sobre una venta de $200 y el servidor lo rechazaba (Testarudo, 17-sep-2026).
  // Un reembolso histórico sin reparto viene con todo en `saleAmount`: se descuenta de la venta, la app ofrece de menos.
  // Cada componente se topa además con el total restante: un acumulado histórico sin filas baja el total, no el reparto.
  const remainingRefundable = remainingRefundableCents / 100
  const remainingRefundableSale = Math.min(remainingRefundableCents, Math.max(0, originalSaleCents - ventaDevueltaCents)) / 100
  const remainingRefundableTip = Math.min(remainingRefundableCents, Math.max(0, originalTipCents - propinaDevueltaCents)) / 100

  // Aggregate per-orderItemId refund totals across all refunds for this payment.
  // Used by the mobile UI to mark lines as "Reembolsado" / "N de X ya reembolsado"
  // and to clamp the stepper max to the remaining refundable quantity per line.
  type PerItemRefund = { quantity: number; amount: number }
  const refundedByOrderItemId = new Map<string, PerItemRefund>()
  for (const refund of refunds) {
    const pd = (refund.processorData as Record<string, unknown> | null) ?? {}
    const refundedItems = Array.isArray(pd.refundedItems) ? (pd.refundedItems as Array<Record<string, unknown>>) : []
    for (const ri of refundedItems) {
      const orderItemId = typeof ri.orderItemId === 'string' ? ri.orderItemId : null
      if (!orderItemId) continue
      const qty = Number(ri.quantity) || 0
      const amountCents =
        typeof ri.amountCents === 'number' ? ri.amountCents : typeof ri.amount === 'number' ? Math.round(ri.amount * 100) : 0
      const current = refundedByOrderItemId.get(orderItemId) ?? { quantity: 0, amount: 0 }
      current.quantity += qty
      current.amount += amountCents / 100
      refundedByOrderItemId.set(orderItemId, current)
    }
  }

  return {
    id: payment.id,
    amount: Number(payment.amount),
    tipAmount: Number(payment.tipAmount),
    method: payment.method,
    status: payment.status,
    cardBrand: payment.cardBrand,
    maskedPan: payment.maskedPan,
    referenceNumber: payment.referenceNumber,
    authorizationNumber: payment.authorizationNumber,
    createdAt: payment.createdAt.toISOString(),
    orderNumber: payment.order?.orderNumber ?? null,
    staffName: payment.processedBy ? `${payment.processedBy.firstName ?? ''} ${payment.processedBy.lastName ?? ''}`.trim() : null,
    remainingRefundable,
    remainingRefundableSale,
    remainingRefundableTip,
    // Aditivo (30-sep-2026): ¿la devolución se abre en la terminal? Sólo la tarjeta que cobró NUESTRA terminal;
    // todo lo demás se reembolsa como el efectivo. Misma regla que acepta `refund-request` (`seDevuelveEnTerminal`).
    refundOnTerminal: seDevuelveEnTerminal(payment),
    // Aditivo (30-sep-2026): ¿el cajero puede escoger con qué devolver? Misma regla que valida el reembolso.
    canChooseRefundMethod: sePuedeEscogerComoDevolver(payment),
    tenderLabel: payment.tenderLabel ?? null,
    refunds: refunds.map(refund => {
      const processorData = (refund.processorData as Record<string, unknown>) || {}
      return {
        id: refund.id,
        amount: Math.abs(Number(refund.amount) || 0),
        saleAmount: Math.abs(Number(refund.saleAmount) || 0),
        tipAmount: Math.abs(Number(refund.tipAmount) || 0),
        reason: typeof processorData.refundReason === 'string' ? processorData.refundReason : null,
        createdAt: refund.createdAt.toISOString(),
        status: refund.status,
      }
    }),
    items: (payment.order?.items ?? []).map(item => {
      const prior = refundedByOrderItemId.get(item.id) ?? { quantity: 0, amount: 0 }
      const refundedQty = Math.min(prior.quantity, item.quantity)
      const remainingQty = Math.max(0, item.quantity - refundedQty)
      return {
        id: item.id,
        productName: item.productName ?? item.product?.name ?? 'Producto',
        quantity: item.quantity,
        unitPrice: Number(item.unitPrice),
        total: Number(item.total),
        productImageUrl: item.product?.imageUrl ?? null,
        trackInventory: item.product?.trackInventory ?? false,
        refundedQty,
        refundedAmount: Math.round(prior.amount * 100) / 100,
        remainingQty,
        modifiers: item.modifiers.map(m => ({
          name: m.name,
          price: Number(m.price),
        })),
      }
    }),
  }
}
