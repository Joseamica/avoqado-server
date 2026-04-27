import { Prisma, TransactionStatus } from '@prisma/client'

import prisma from '@/utils/prismaClient'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { earnPoints } from '@/services/dashboard/loyalty.dashboard.service'
import { updateCustomerMetrics } from '@/services/dashboard/customer.dashboard.service'

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
  // Capture loyalty + customer-metrics side-effect inputs from inside the tx so
  // we can fire them AFTER the tx commits — keeps downstream failures from
  // rolling back the payment (matches the TPV pattern).
  //
  // - `loyaltyCustomerId` is the SINGLE customer who earns loyalty points
  //   (resolution: input.customerId override > primary OrderCustomer > legacy
  //   Order.customerId). TPV semantics: only ONE customer earns per order.
  // - `metricsCustomerIds` is the FULL set of customers whose visit metrics
  //   (totalVisits, totalSpent, lastVisitAt) must increment. TPV iterates ALL
  //   OrderCustomer rows for this. Without including secondaries, multi-customer
  //   orders silently undercount visits in customer dashboards.
  let loyaltyCustomerId: string | null = null
  let loyaltyOrderTotal: Prisma.Decimal = new Prisma.Decimal(0)
  let loyaltyOrderId: string = ''
  let loyaltyShouldEarn = false
  const metricsCustomerIds = new Set<string>()
  // Independent of loyalty resolution: metrics fire for every queued customer
  // even when no primary customer can earn loyalty points (orderCustomers all
  // isPrimary=false, no input.customerId, no legacy order.customerId).
  // Stored in a holder object so TypeScript doesn't narrow the closure
  // assignment to `never` after the async transaction callback.
  const metricsState: { orderTotal: Prisma.Decimal | null } = { orderTotal: null }

  const result = await prisma.$transaction(
    async tx => {
      let anchorOrderId: string
      let anchorOrderTotal: Prisma.Decimal
      let paidSoFar: Prisma.Decimal
      let aggregatedTipAmount: Prisma.Decimal = tipAmount
      let isShadow = false
      // Captured from the existing order in Mode 1 so the post-payment update
      // can recompute Order.total = subtotal - discount + cumulative tips.
      let orderSubtotal: Prisma.Decimal = new Prisma.Decimal(0)
      let orderDiscount: Prisma.Decimal = new Prisma.Decimal(0)

      // Link payment to the cashier's currently open shift (if any). Match the
      // TPV pattern exactly: filter by staffId + status='OPEN' + endTime=null so
      // multi-cashier venues attribute the payment to the RIGHT shift, not just
      // any open one. Without staffId filter, manual payments could land on
      // another staff member's shift in busy venues.
      const openShift = await tx.shift.findFirst({
        where: { venueId, staffId, status: 'OPEN', endTime: null },
        select: { id: true },
        orderBy: { startTime: 'desc' },
      })
      const shiftId = openShift?.id ?? null

      if (input.orderId) {
        // Mode 1 — attach to existing order
        // Fetch ALL OrderCustomer rows (not filtered by isPrimary) so we can
        // increment customer metrics for every customer associated with the
        // order, while loyalty points still go only to the primary. Mirrors
        // TPV's payment.tpv.service.ts handling.
        const order = await tx.order.findFirst({
          where: { id: input.orderId, venueId },
          include: {
            payments: { where: { status: TransactionStatus.COMPLETED } },
            orderCustomers: { select: { customerId: true, isPrimary: true } },
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

        // Capture subtotal/discount for the post-payment Order.total recomputation
        // below (TPV alignment). Stored on closure so the order.update branch can
        // reuse them without re-fetching.
        orderSubtotal = new Prisma.Decimal(order.subtotal)
        orderDiscount = new Prisma.Decimal(order.discountAmount ?? 0)

        // ✅ TPV ALIGNMENT: paidSoFar sums (amount + tip) for prior COMPLETED payments,
        // matching how TPV's totalPaid is computed. Without including tips, partial
        // tip payments leave paidAmount and Order.total inconsistent.
        paidSoFar = order.payments.reduce(
          (acc: Prisma.Decimal, p: { amount: Prisma.Decimal | null; tipAmount: Prisma.Decimal | null }) =>
            acc.plus(p.amount ?? 0).plus(p.tipAmount ?? 0),
          new Prisma.Decimal(0),
        )
        // Tips on the Order row aggregate ALL payment tips. Without this the
        // order's tipAmount stays at 0 and per-order tip reports undercount.
        const priorTips = order.payments.reduce(
          (acc: Prisma.Decimal, p: { tipAmount: Prisma.Decimal | null }) => acc.plus(p.tipAmount ?? 0),
          new Prisma.Decimal(0),
        )
        aggregatedTipAmount = priorTips.plus(tipAmount)

        // Order total recomputed to include cumulative tips (TPV pattern).
        // Tax is left as-is; manual payments don't recompute tax.
        const orderTax = new Prisma.Decimal(order.taxAmount ?? 0)
        anchorOrderTotal = orderSubtotal.plus(orderTax).minus(orderDiscount).plus(aggregatedTipAmount)

        const grossThisPayment = amount.plus(tipAmount)
        const newTotalPaid = paidSoFar.plus(grossThisPayment)
        if (newTotalPaid.greaterThan(anchorOrderTotal)) {
          throw new BadRequestError(`El pago excede el saldo pendiente. Pendiente: ${anchorOrderTotal.minus(paidSoFar).toFixed(2)}`)
        }

        // Customer metrics + loyalty are only queued on FULL SETTLEMENT, matching
        // TPV's `if (isFullyPaid)` guard. Per-payment metric increments would
        // inflate totalVisits (4 partials of a $100 order = 4 visits instead of 1)
        // and disconnect from TPV semantics. Both metrics and loyalty fire ONCE
        // per order, with the FINAL order total — not per-payment amounts.
        if (newTotalPaid.equals(anchorOrderTotal)) {
          // Final order total drives BOTH loyalty (when there's a customer to
          // earn) and metrics (for every customer on the order, regardless of
          // primary). Set unconditionally on full settlement so metrics never
          // run with 0.
          metricsState.orderTotal = anchorOrderTotal
          loyaltyOrderId = order.id
          // Resolution: explicit input override > primary OrderCustomer > legacy column
          const primaryCustomer = order.orderCustomers.find(oc => oc.isPrimary)
          const resolvedCustomerId = input.customerId ?? primaryCustomer?.customerId ?? order.customerId ?? null
          if (resolvedCustomerId) {
            loyaltyCustomerId = resolvedCustomerId
            loyaltyOrderTotal = anchorOrderTotal
            loyaltyShouldEarn = true
          }
          // Customer metrics: queue updates for ALL customers on the order
          // (primary + secondaries + override + legacy column). Visits/spend
          // increments ONCE per customer at settlement, using the final order
          // total — not per-payment amounts.
          for (const oc of order.orderCustomers) {
            metricsCustomerIds.add(oc.customerId)
          }
          if (input.customerId) metricsCustomerIds.add(input.customerId)
          if (order.customerId) metricsCustomerIds.add(order.customerId)
        }

        // If admin attached a customer and the order didn't have one (no
        // primary OrderCustomer AND no legacy customerId), create the link as
        // primary so future reports / loyalty know who paid.
        const hasPrimary = order.orderCustomers.some(oc => oc.isPrimary)
        if (input.customerId && !order.customerId && !hasPrimary) {
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
        // primary so loyalty / per-customer reports surface this entry. Queue
        // both metrics + loyalty for the attached customer (no secondaries on
        // shadow orders — they're single-customer by definition).
        if (input.customerId) {
          await tx.orderCustomer.create({
            data: { orderId: shadow.id, customerId: input.customerId, isPrimary: true },
          })
          metricsCustomerIds.add(input.customerId)
          metricsState.orderTotal = shadowTotal
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
        // ✅ TPV ALIGNMENT: paidAmount and Order.total must include cumulative tips.
        // TPV's recordOrderPayment treats paidAmount as "cash collected (amount + tip)"
        // and recomputes Order.total = subtotal + tax - discount + cumulative tips.
        // Without this, reports that join Order.total vs Payment.netAmount see
        // different sums (e.g. order.total=100, payment.netAmount=110, paidAmount=100).
        const grossThisPayment = amount.plus(tipAmount)
        const newTotalPaid = paidSoFar.plus(grossThisPayment)
        const fullyPaid = newTotalPaid.greaterThanOrEqualTo(anchorOrderTotal)

        await tx.order.update({
          where: { id: anchorOrderId },
          data: {
            paymentStatus: fullyPaid ? 'PAID' : 'PARTIAL',
            paidAmount: newTotalPaid,
            remainingBalance: Prisma.Decimal.max(new Prisma.Decimal(0), anchorOrderTotal.minus(newTotalPaid)),
            tipAmount: aggregatedTipAmount,
            total: anchorOrderTotal,
            // Flip status to COMPLETED only when the order is fully settled —
            // matches the TPV path. Without this, "orders by status" reports
            // count fully-paid orders as still pending.
            ...(fullyPaid ? { status: 'COMPLETED', completedAt: new Date() } : {}),
          },
        })
      }
      // Reference unused vars so TS doesn't complain — they're captured for
      // possible future expansion (per-payment breakdown, audit detail).
      void orderSubtotal
      void orderDiscount

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

  // Customer metrics + loyalty side-effects run OUTSIDE the tx so any failure
  // (config missing, downstream service down) does NOT roll back the payment
  // that was just persisted. Same pattern as `payment.tpv.service.ts`.
  // updateCustomerMetrics is idempotent enough (totalVisits++, totalSpent+=,
  // lastVisitAt=now) and earnPoints dedupes by (customerId, orderId).
  //
  // Two-step contract:
  //   1. Increment metrics for ALL customers attached to the order (primary +
  //      secondaries + input override + legacy column). Multi-customer orders
  //      mean every customer at the table gets credit for the visit.
  //   2. Award loyalty points to the SINGLE primary customer only (matches TPV).
  //
  // Both steps are independent: a metrics failure for one customer does NOT
  // skip metrics for the others, and does NOT skip loyalty.

  // Step 1 — metrics for every queued customer. metricsCustomerIds is only
  // populated when the order is fully settled (Mode 1 fully-paid OR Mode 2
  // shadow with attached customer). metricsOrderTotal is set in lockstep so
  // the amount is always the FINAL order total — independent of whether
  // loyalty resolved a primary customer (orderCustomers all isPrimary=false +
  // no input.customerId + no legacy order.customerId would otherwise leave
  // loyaltyOrderTotal at 0 while metrics still fire).
  if (metricsCustomerIds.size > 0 && metricsState.orderTotal) {
    const metricsAmount = Number(metricsState.orderTotal.toString())
    for (const customerId of metricsCustomerIds) {
      try {
        await updateCustomerMetrics(customerId, metricsAmount)
        logger.info('📊 Customer metrics updated (manual payment)', {
          orderId: loyaltyOrderId,
          customerId,
          amount: metricsAmount,
        })
      } catch (metricsError: any) {
        logger.error('⚠️ Failed to update customer metrics on manual payment (payment still succeeded)', {
          orderId: loyaltyOrderId,
          customerId,
          venueId,
          error: metricsError?.message,
        })
      }
    }
  }

  // Step 2 — loyalty for the resolved primary customer only.
  if (loyaltyShouldEarn && loyaltyCustomerId) {
    const totalAsNumber = Number(loyaltyOrderTotal.toString())

    // Resolve StaffVenue.id for proper FK on LoyaltyTransaction.createdById.
    // earnPoints internally writes a LoyaltyTransaction whose createdById
    // references StaffVenue.id (NOT Staff.id). Passing the raw staffId silently
    // fails the FK and the loyalty transaction is dropped (caught below). TPV
    // resolves StaffVenue first — we mirror that.
    let staffVenueId: string | undefined = undefined
    try {
      const staffVenue = await prisma.staffVenue.findFirst({
        where: { staffId, venueId },
        select: { id: true },
      })
      staffVenueId = staffVenue?.id
    } catch (sfErr: any) {
      logger.warn('Could not resolve StaffVenue for loyalty FK; loyalty will use undefined createdBy', {
        staffId,
        venueId,
        error: sfErr?.message,
      })
    }

    try {
      const loyaltyResult = await earnPoints(venueId, loyaltyCustomerId, totalAsNumber, loyaltyOrderId, staffVenueId)
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
