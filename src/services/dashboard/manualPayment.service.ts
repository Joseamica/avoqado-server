import { Prisma, TransactionStatus } from '@prisma/client'

import prisma from '@/utils/prismaClient'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'

import type { CreateManualPaymentInput } from '@/schemas/dashboard/manualPayment.schema'

/**
 * Record a manual payment (admin-only). Two modes:
 *
 *   1. `input.orderId` provided → attach payment to existing order, update
 *      paidAmount/remainingBalance/paymentStatus. Cannot exceed order total.
 *
 *   2. `input.orderId` omitted → bookkeeping entry for money that never passed
 *      through Avoqado. A shadow Order of type=MANUAL_ENTRY is created with
 *      subtotal=amount, paymentStatus=PAID, no items. Revenue reports keep it,
 *      operational reports (kitchen, KDS) can filter by type.
 *
 * Side effects NOT handled here (by design — out of V1 scope):
 *   - Inventory FIFO deduction on final payment
 *   - Socket.io broadcast
 *   - Receipt email
 */
export async function createManualPayment(venueId: string, staffId: string, input: CreateManualPaymentInput) {
  const amount = new Prisma.Decimal(input.amount)
  const tipAmount = new Prisma.Decimal(input.tipAmount ?? '0')
  const taxAmount = new Prisma.Decimal(input.taxAmount ?? '0')
  const discountAmount = new Prisma.Decimal(input.discountAmount ?? '0')

  // Validate waiter exists and belongs to this venue (don't let a client
  // forge an arbitrary staff ID and attribute a commission to someone
  // who isn't part of the venue).
  if (input.waiterId) {
    const staffVenue = await prisma.staffVenue.findFirst({
      where: { staffId: input.waiterId, venueId, active: true },
      select: { staffId: true },
    })
    if (!staffVenue) {
      throw new BadRequestError('El mesero seleccionado no pertenece a este venue')
    }
  }

  // Serializable isolation prevents the "lost update" race where two concurrent
  // payments both read paidAmount=X and each pass the "does not exceed total"
  // check, ending with sum(payments) > total. Under Serializable one of them
  // fails with a serialization error instead of silently overpaying.
  return prisma.$transaction(
    async tx => {
      let anchorOrderId: string
      let anchorOrderTotal: Prisma.Decimal
      let paidSoFar: Prisma.Decimal
      let isShadow = false

      if (input.orderId) {
        // Mode 1 — attach to existing order
        const order = await tx.order.findFirst({
          where: { id: input.orderId, venueId },
          include: { payments: { where: { status: TransactionStatus.COMPLETED } } },
        })

        if (!order) {
          throw new NotFoundError('Orden no encontrada')
        }

        anchorOrderId = order.id
        anchorOrderTotal = new Prisma.Decimal(order.total)
        paidSoFar = order.payments.reduce(
          (acc: Prisma.Decimal, p: { amount: Prisma.Decimal | null }) => acc.plus(p.amount ?? 0),
          new Prisma.Decimal(0),
        )

        const newTotalPaid = paidSoFar.plus(amount)
        if (newTotalPaid.greaterThan(anchorOrderTotal)) {
          throw new BadRequestError(`El pago excede el saldo pendiente. Pendiente: ${anchorOrderTotal.minus(paidSoFar).toFixed(2)}`)
        }
      } else {
        // Mode 2 — create shadow order to anchor this standalone payment.
        // Amounts follow the usual invoice structure:
        //   subtotal = amount (the line value the admin claims)
        //   + taxAmount  (IVA the admin declares, 0 default)
        //   - discountAmount (promo the admin applied, 0 default)
        //   + tipAmount
        //   = total (what the client actually paid).
        isShadow = true
        const shadowTotal = amount.plus(taxAmount).minus(discountAmount).plus(tipAmount)
        const orderNumber = `ORD-MANUAL-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
        const shadow = await tx.order.create({
          data: {
            venueId,
            orderNumber,
            type: 'MANUAL_ENTRY',
            source: 'DASHBOARD_MANUAL',
            status: 'COMPLETED',
            paymentStatus: 'PAID',
            subtotal: amount,
            taxAmount,
            discountAmount,
            total: shadowTotal,
            paidAmount: shadowTotal,
            remainingBalance: new Prisma.Decimal(0),
            tipAmount,
            completedAt: new Date(),
            // createdBy = the admin who recorded it (audit trail).
            // servedBy = the waiter who gets tip / commission credit.
            createdById: staffId,
            servedById: input.waiterId ?? staffId,
            // Attribution + audit trail inside posRawData JSON so any future
            // report can tell "this came from the admin dashboard, not a
            // real order".
            posRawData: {
              manualEntry: true,
              recordedByStaffId: staffId,
              ...(input.waiterId ? { waiterId: input.waiterId } : {}),
              ...(input.reason ? { reason: input.reason } : {}),
            },
          },
        })
        anchorOrderId = shadow.id
        anchorOrderTotal = shadowTotal
        paidSoFar = new Prisma.Decimal(0)
      }

      const payment = await tx.payment.create({
        data: {
          venueId,
          orderId: anchorOrderId,
          amount,
          tipAmount,
          method: input.method,
          source: input.source,
          externalSource: input.externalSource ?? null,
          status: TransactionStatus.COMPLETED,
          processedById: staffId,
          // Fee fields are required on Payment model — manual payments have no processor fees.
          feePercentage: new Prisma.Decimal(0),
          feeAmount: new Prisma.Decimal(0),
          netAmount: amount,
          // Payment has no dedicated notes column. Preserve the admin's reason
          // (and tag the provenance) inside processorData so it's auditable.
          processorData: {
            manualEntry: true,
            shadowOrder: isShadow,
            recordedByStaffId: staffId,
            ...(input.reason ? { reason: input.reason } : {}),
          },
        },
      })

      // Only update existing-order totals in Mode 1; shadow orders were
      // already created with final values and don't need a second update.
      if (!isShadow) {
        const newTotalPaid = paidSoFar.plus(amount)
        const fullyPaid = newTotalPaid.equals(anchorOrderTotal)
        await tx.order.update({
          where: { id: anchorOrderId },
          data: {
            paymentStatus: fullyPaid ? 'PAID' : 'PARTIAL',
            paidAmount: newTotalPaid,
            remainingBalance: anchorOrderTotal.minus(newTotalPaid),
            ...(fullyPaid ? { completedAt: new Date() } : {}),
          },
        })
      }

      logger.info('Manual payment created', {
        paymentId: payment.id,
        orderId: anchorOrderId,
        venueId,
        staffId,
        amount: amount.toFixed(2),
        source: input.source,
        externalSource: input.externalSource,
        shadowOrder: isShadow,
        waiterId: input.waiterId ?? null,
      })

      // Audit trail — outside the transaction would be cleaner, but in-tx is
      // acceptable here because logAction is fire-and-forget and never throws.
      logAction({
        staffId,
        venueId,
        action: 'payment.manual.create',
        entity: 'Payment',
        entityId: payment.id,
        data: {
          orderId: anchorOrderId,
          shadowOrder: isShadow,
          amount: amount.toFixed(2),
          tipAmount: tipAmount.toFixed(2),
          taxAmount: taxAmount.toFixed(2),
          discountAmount: discountAmount.toFixed(2),
          method: input.method,
          source: input.source,
          externalSource: input.externalSource ?? null,
          waiterId: input.waiterId ?? null,
          reason: input.reason ?? null,
        },
      })

      return payment
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  )
}

/**
 * List active staff of a venue that can be attributed as the waiter for a
 * manual payment. Returns a flat, display-ready shape so the frontend can
 * populate a Select without further shaping.
 */
export async function getEligibleWaiters(venueId: string) {
  const rows = await prisma.staffVenue.findMany({
    where: { venueId, active: true },
    select: {
      role: true,
      staff: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    },
    orderBy: { staff: { firstName: 'asc' } },
  })

  return rows.map(r => ({
    id: r.staff.id,
    firstName: r.staff.firstName,
    lastName: r.staff.lastName,
    email: r.staff.email,
    role: r.role,
  }))
}

/**
 * Returns up to `limit` distinct externalSource values used on this venue,
 * ordered by frequency. Powers the combobox autocomplete so admins pick
 * existing entries instead of retyping and risking typos.
 */
export async function getExternalSources(venueId: string, limit = 10): Promise<string[]> {
  const rows = await prisma.payment.groupBy({
    by: ['externalSource'],
    where: {
      venueId,
      externalSource: { not: null },
    },
    _count: { _all: true },
    orderBy: { _count: { externalSource: 'desc' } },
    take: limit,
  })

  return rows.map(r => r.externalSource).filter((s): s is string => Boolean(s))
}
