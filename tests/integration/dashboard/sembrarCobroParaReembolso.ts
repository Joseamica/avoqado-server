/**
 * Siembra mínima para las pruebas del núcleo de reembolso (`writeRefundInTx`) y de la
 * caracterización de `issueRefund`: un tipo de pago con comisión, un cobro ya ocurrido
 * con ese tipo (como lo deja la ingesta de reparto o el POS) y un turno vivo.
 */
import prisma from '@/utils/prismaClient'
import { Prisma } from '@prisma/client'

const pesos = (centavos: number) => new Prisma.Decimal(centavos).div(100)

export async function crearTender(venueId: string, commissionPercent: number | null) {
  const sufijo = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const tender = await prisma.venueTenderType.create({
    data: {
      venueId,
      name: 'Uber Eats',
      normalizedName: `uber-eats-${sufijo}`,
      baseMethod: 'OTHER',
      isSystem: false,
      countsAsPhysicalCash: false,
      captureTip: true,
      showOnPos: true,
      posSection: 'MORE',
      displayOrder: 60,
      satFormaPago: '99',
      revision: 1,
    },
  })
  await prisma.venueTenderTypeRevision.create({
    data: {
      venueId,
      tenderTypeId: tender.id,
      revision: 1,
      name: 'Uber Eats',
      countsAsPhysicalCash: false,
      captureTip: true,
      commissionPercent: commissionPercent === null ? null : new Prisma.Decimal(commissionPercent),
      satFormaPago: '99',
      createdBy: null,
    },
  })
  return tender
}

export async function abrirTurno(venueId: string, staffId: string) {
  return prisma.shift.create({ data: { venueId, staffId, startTime: new Date(), status: 'OPEN', startingCash: 0 } })
}

interface CobroInput {
  venueId: string
  staffId: string
  saleCents: number
  tipCents?: number
  /** `null` = cobro sin tipo de pago del catálogo (efectivo clásico). */
  commissionPercent?: number | null
  shiftId?: string | null
  items?: Array<{ productId: string; productName: string; quantity: number; totalCents: number }>
}

/** Un cobro COMPLETED ya ocurrido, con la comisión CONGELADA como la estampa el cobro real. */
export async function sembrarCobro(input: CobroInput) {
  const tip = input.tipCents ?? 0
  const tender =
    input.commissionPercent === undefined || input.commissionPercent === null
      ? null
      : await crearTender(input.venueId, input.commissionPercent)
  const order = await prisma.order.create({
    data: {
      venueId: input.venueId,
      orderNumber: `RFD-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'TAKEOUT',
      source: 'TPV',
      status: 'COMPLETED',
      completedAt: new Date(),
      subtotal: pesos(input.saleCents),
      taxAmount: new Prisma.Decimal(0),
      tipAmount: pesos(tip),
      total: pesos(input.saleCents),
      paidAmount: pesos(input.saleCents),
      remainingBalance: new Prisma.Decimal(0),
      paymentStatus: 'PAID',
      createdById: input.staffId,
    },
  })
  const items = []
  for (const it of input.items ?? []) {
    items.push(
      await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: it.productId,
          productName: it.productName,
          quantity: it.quantity,
          unitPrice: pesos(Math.round(it.totalCents / it.quantity)),
          taxAmount: new Prisma.Decimal(0),
          total: pesos(it.totalCents),
        },
      }),
    )
  }
  const percent = tender ? new Prisma.Decimal(input.commissionPercent as number) : null
  const pago = await prisma.payment.create({
    data: {
      venueId: input.venueId,
      orderId: order.id,
      shiftId: input.shiftId ?? undefined,
      amount: pesos(input.saleCents),
      tipAmount: pesos(tip),
      method: tender ? 'OTHER' : 'CASH',
      status: 'COMPLETED',
      type: 'FAST',
      splitType: 'FULLPAYMENT',
      source: 'TPV',
      processedById: input.staffId,
      feePercentage: 0,
      feeAmount: new Prisma.Decimal(0),
      netAmount: pesos(input.saleCents + tip),
      ...(tender
        ? {
            tenderTypeId: tender.id,
            tenderRevision: 1,
            tenderLabel: 'Uber Eats',
            tenderCountsAsCash: false,
            tenderCaptureTip: true,
            tenderSatFormaPago: '99',
            tenderCommissionPercent: percent!,
            tenderCommissionAmount: pesos(input.saleCents).mul(percent!).div(100).toDecimalPlaces(2),
            fundsFlow: 'EXTERNAL_RECORDED' as const,
          }
        : {}),
    },
  })
  return { pago, order, tender, items }
}

/** Borra lo que la siembra y los reembolsos dejan colgando del venue, antes del teardown compartido. */
export async function limpiarVenue(venueId: string) {
  await prisma.activityLog.deleteMany({ where: { venueId } }).catch(() => undefined)
  await prisma.paymentEffect.deleteMany({ where: { payment: { venueId } } }).catch(() => undefined)
  await prisma.payment.deleteMany({ where: { venueId } }).catch(() => undefined)
  await prisma.shift.deleteMany({ where: { venueId } }).catch(() => undefined)
  await prisma.orderItem.deleteMany({ where: { order: { venueId } } }).catch(() => undefined)
  await prisma.order.deleteMany({ where: { venueId } }).catch(() => undefined)
  await prisma.venueTenderTypeRevision.deleteMany({ where: { venueId } }).catch(() => undefined)
  await prisma.venueTenderType.deleteMany({ where: { venueId } }).catch(() => undefined)
}
