import { Prisma, TransactionStatus } from '@prisma/client'

import prisma from '@/utils/prismaClient'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { earnPoints } from '@/services/dashboard/loyalty.dashboard.service'

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

  // Validate customer belongs to this venue (cross-tenant isolation).
  if (input.customerId) {
    const customer = await prisma.customer.findFirst({
      where: { id: input.customerId, venueId },
      select: { id: true },
    })
    if (!customer) {
      throw new BadRequestError('El cliente seleccionado no pertenece a este venue')
    }
  }

  // Validate table belongs to this venue (only meaningful for shadow orders).
  if (input.tableId) {
    const table = await prisma.table.findFirst({
      where: { id: input.tableId, venueId },
      select: { id: true },
    })
    if (!table) {
      throw new BadRequestError('La mesa seleccionada no pertenece a este venue')
    }
  }

  // Serializable isolation prevents the "lost update" race where two concurrent
  // payments both read paidAmount=X and each pass the "does not exceed total"
  // check, ending with sum(payments) > total. Under Serializable one of them
  // fails with a serialization error instead of silently overpaying.
  // Capture loyalty side-effect inputs from inside the tx so we can fire
  // earnPoints AFTER the tx commits — keeps loyalty failures from rolling
  // back the payment (matches the TPV pattern).
  let loyaltyCustomerId: string | null = null
  let loyaltyOrderTotal: Prisma.Decimal = new Prisma.Decimal(0)
  let loyaltyOrderId: string = ''
  let loyaltyShouldEarn = false

  const result = await prisma.$transaction(
    async tx => {
      let anchorOrderId: string
      let anchorOrderTotal: Prisma.Decimal
      let paidSoFar: Prisma.Decimal
      let aggregatedTipAmount: Prisma.Decimal = tipAmount
      let isShadow = false

      // Link payment to the cashier's currently open shift (if any). Other
      // payment paths (TPV, POS sync) do this — without it, manual payments
      // are orphaned from the shift summary and the cash drawer reconciliation
      // descuadres at shift close.
      const openShift = await tx.shift.findFirst({
        where: { venueId, endTime: null },
        select: { id: true },
        orderBy: { startTime: 'desc' },
      })
      const shiftId = openShift?.id ?? null

      if (input.orderId) {
        // Mode 1 — attach to existing order
        const order = await tx.order.findFirst({
          where: { id: input.orderId, venueId },
          include: {
            payments: { where: { status: TransactionStatus.COMPLETED } },
            orderCustomers: { where: { isPrimary: true }, select: { customerId: true } },
          },
        })

        if (!order) {
          throw new NotFoundError('Orden no encontrada')
        }

        // Reject payments on terminated orders. Without this guard, an admin
        // could attach cash to a CANCELLED/DELETED order and revenue reports
        // would credit a sale that the customer never confirmed.
        if (order.status === 'CANCELLED' || order.status === 'DELETED') {
          throw new BadRequestError('No se puede registrar un pago en una orden cancelada o eliminada')
        }

        anchorOrderId = order.id
        anchorOrderTotal = new Prisma.Decimal(order.total)
        paidSoFar = order.payments.reduce(
          (acc: Prisma.Decimal, p: { amount: Prisma.Decimal | null }) => acc.plus(p.amount ?? 0),
          new Prisma.Decimal(0),
        )
        // Tips on the Order row aggregate ALL payment tips. Without this the
        // order's tipAmount stays at 0 and per-order tip reports undercount.
        const priorTips = order.payments.reduce(
          (acc: Prisma.Decimal, p: { tipAmount: Prisma.Decimal | null }) => acc.plus(p.tipAmount ?? 0),
          new Prisma.Decimal(0),
        )
        aggregatedTipAmount = priorTips.plus(tipAmount)

        const newTotalPaid = paidSoFar.plus(amount)
        if (newTotalPaid.greaterThan(anchorOrderTotal)) {
          throw new BadRequestError(`El pago excede el saldo pendiente. Pendiente: ${anchorOrderTotal.minus(paidSoFar).toFixed(2)}`)
        }

        // Loyalty: when this manual payment is the one that fully pays the order,
        // resolve the customer (input override > primary OrderCustomer > legacy
        // Order.customerId) and queue earnPoints for after-commit. Partial
        // payments do NOT earn — points fire only when the order is settled.
        if (newTotalPaid.equals(anchorOrderTotal)) {
          const resolvedCustomerId = input.customerId ?? order.orderCustomers[0]?.customerId ?? order.customerId ?? null
          if (resolvedCustomerId) {
            loyaltyCustomerId = resolvedCustomerId
            loyaltyOrderId = order.id
            loyaltyOrderTotal = anchorOrderTotal
            loyaltyShouldEarn = true
          }
        }

        // If admin attached a customer and the order didn't have one, create
        // the OrderCustomer link so future reports/loyalty know who paid.
        if (input.customerId && !order.customerId && order.orderCustomers.length === 0) {
          await tx.orderCustomer.create({
            data: { orderId: order.id, customerId: input.customerId, isPrimary: true },
          })
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
        if (shadowTotal.lessThan(0)) {
          throw new BadRequestError('El descuento no puede exceder el subtotal más impuestos y propina')
        }
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
            // Optional attributions — set when admin provides them so reports
            // by table / customer pick these manual entries up too.
            ...(input.tableId ? { tableId: input.tableId } : {}),
            ...(input.customerId ? { customerId: input.customerId } : {}),
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
              ...(input.customerId ? { customerId: input.customerId } : {}),
              ...(input.tableId ? { tableId: input.tableId } : {}),
              ...(input.reason ? { reason: input.reason } : {}),
            },
          },
        })
        anchorOrderId = shadow.id
        anchorOrderTotal = shadowTotal
        paidSoFar = new Prisma.Decimal(0)

        // If a customer was attached, also create the OrderCustomer link as
        // primary so loyalty / per-customer reports surface this entry.
        if (input.customerId) {
          await tx.orderCustomer.create({
            data: { orderId: shadow.id, customerId: input.customerId, isPrimary: true },
          })
          loyaltyCustomerId = input.customerId
          loyaltyOrderId = shadow.id
          loyaltyOrderTotal = shadowTotal
          loyaltyShouldEarn = true
        }
      }

      // Gross/net amounts include tip — same convention as TPV recordFastPayment.
      // VenueTransaction.grossAmount and Payment.netAmount must include tip so
      // settlement reports total the actual cash collected, not just the sale price.
      const grossWithTip = amount.plus(tipAmount)

      const payment = await tx.payment.create({
        data: {
          venueId,
          orderId: anchorOrderId,
          shiftId,
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
          netAmount: grossWithTip,
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

      // Mirror the TPV recordFastPayment side effects so financial reports stay
      // aligned. These three writes used to be skipped for manual payments,
      // causing settlement / shift / payment-allocation reports to under-count
      // by the manual sales total.

      // 1. VenueTransaction — drives settlement / payout reports.
      await tx.venueTransaction.create({
        data: {
          venueId,
          paymentId: payment.id,
          type: 'PAYMENT',
          grossAmount: grossWithTip,
          feeAmount: new Prisma.Decimal(0),
          netAmount: grossWithTip,
          status: 'PENDING',
        },
      })

      // 2. PaymentAllocation — joins payment ↔ order amount allocation.
      // For manual payments we always allocate the full payment to its anchor
      // order (no split). Mode 1 partial payments still create one allocation
      // per call; the order accumulates them via PaymentAllocation rows.
      await tx.paymentAllocation.create({
        data: {
          paymentId: payment.id,
          orderId: anchorOrderId,
          amount,
        },
      })

      // 3. Shift totals — keep `totalSales`, `totalTips`, `totalOrders` in sync.
      // totalOrders++ only for shadow orders; Mode 1 attaches to an existing
      // order that already counted in shift totals when first created.
      if (shiftId) {
        await tx.shift.update({
          where: { id: shiftId },
          data: {
            totalSales: { increment: amount },
            totalTips: { increment: tipAmount },
            ...(isShadow ? { totalOrders: { increment: 1 } } : {}),
          },
        })
      }

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
            tipAmount: aggregatedTipAmount,
            // Flip status to COMPLETED only when the order is fully settled —
            // matches the TPV path. Without this, "orders by status" reports
            // count fully-paid orders as still pending.
            ...(fullyPaid ? { status: 'COMPLETED', completedAt: new Date() } : {}),
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

  // Loyalty side-effect runs OUTSIDE the tx so a loyalty failure (config
  // missing, downstream service down) does NOT roll back the payment that
  // was just persisted. Same pattern as `payment.tpv.service.ts`. earnPoints
  // is internally idempotent on (customerId, orderId) so retries are safe.
  if (loyaltyShouldEarn && loyaltyCustomerId) {
    try {
      const totalAsNumber = Number(loyaltyOrderTotal.toString())
      const loyaltyResult = await earnPoints(venueId, loyaltyCustomerId, totalAsNumber, loyaltyOrderId, staffId)
      logger.info('🎁 Loyalty points earned (manual payment)', {
        orderId: loyaltyOrderId,
        customerId: loyaltyCustomerId,
        orderTotal: totalAsNumber,
        pointsEarned: loyaltyResult.pointsEarned,
        newBalance: loyaltyResult.newBalance,
      })
    } catch (loyaltyError: any) {
      logger.error('⚠️ Failed to earn loyalty points on manual payment (payment still succeeded)', {
        orderId: loyaltyOrderId,
        customerId: loyaltyCustomerId,
        venueId,
        error: loyaltyError?.message,
      })
    }
  }

  return result
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
