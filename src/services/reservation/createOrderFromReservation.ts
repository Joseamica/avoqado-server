import { Prisma, OrderType, OrderSource } from '@prisma/client'
import { assertVenueSalesEnabled } from '@/services/venueSalesGuard'

interface CreateOrderFromReservationInput {
  reservationId: string
  venueId: string
  createdByStaffId?: string | null
}

interface CreateOrderResult {
  /** Created order id, OR existing order id if this reservation already
   *  produced an order. Callers can render a TPV deep-link from this. */
  orderId: string
  /** True only when the order was newly created in this call. */
  created: boolean
}

/**
 * Convert a checked-in reservation into a TPV-ready Order (DRAFT/PENDING).
 *
 * Idempotent: if an Order already references this reservationId, returns it.
 * Skips silently when the reservation has no products (class flow without
 * a bookable product attached).
 *
 * Mirrors the booked product + picked modifier breakdown so the cashier sees
 * "Manicura tradicional + Esmalte de color +$150" pre-populated when the
 * customer arrives. The order stays PENDING + paymentStatus=PENDING — the
 * cashier still drives the actual charge via the existing TPV flow.
 */
export async function createOrderFromReservation(
  tx: Prisma.TransactionClient,
  input: CreateOrderFromReservationInput,
): Promise<CreateOrderResult | null> {
  const { reservationId, venueId } = input

  // 1. Idempotency check
  const existing = await tx.order.findFirst({
    where: { reservationId, venueId },
    select: { id: true },
  })
  if (existing) return { orderId: existing.id, created: false }

  await assertVenueSalesEnabled(venueId, tx)

  // 2. Load reservation + modifiers + the products it references
  const reservation = await tx.reservation.findFirst({
    where: { id: reservationId, venueId },
    select: {
      id: true,
      productId: true,
      productIds: true,
      partySize: true,
      tableId: true,
      customerId: true,
      guestName: true,
      guestPhone: true,
      guestEmail: true,
      specialRequests: true,
      assignedStaffId: true,
      modifiers: {
        select: { productId: true, modifierId: true, name: true, quantity: true, price: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  })
  if (!reservation) return null

  // partySize drives line quantity so a family of 3 paying 1 charge sees the
  // correct total automatically. Defaults to 1 for legacy bookings — math is
  // unchanged for any reservation that didn't opt into multi-seat pricing.
  const seatCount = reservation.partySize ?? 1

  // Resolve productId list: multi-service array if present, else single id.
  const productIds =
    reservation.productIds && reservation.productIds.length > 0
      ? reservation.productIds
      : reservation.productId
        ? [reservation.productId]
        : []
  if (productIds.length === 0) return null // class-only or product-less booking

  const products = await tx.product.findMany({
    where: { id: { in: productIds }, venueId },
    select: {
      id: true,
      name: true,
      sku: true,
      price: true,
      taxRate: true,
      category: { select: { name: true } },
    },
  })
  if (products.length === 0) return null
  const productById = new Map(products.map(p => [p.id, p]))

  // 3. Group modifiers by their tagged productId for line-level attachment.
  const modifiersByProduct = new Map<string, typeof reservation.modifiers>()
  for (const m of reservation.modifiers) {
    if (!modifiersByProduct.has(m.productId)) modifiersByProduct.set(m.productId, [])
    modifiersByProduct.get(m.productId)!.push(m)
  }

  // 4. Compute monetary totals.
  let subtotal = new Prisma.Decimal(0)
  let totalTax = new Prisma.Decimal(0)
  type LineDraft = {
    productId: string
    productName: string
    productSku: string
    categoryName: string | null
    unitPrice: Prisma.Decimal
    taxAmount: Prisma.Decimal
    total: Prisma.Decimal
    modifiers: Array<{ name: string; quantity: number; price: Prisma.Decimal; modifierId: string | null }>
  }
  const lines: LineDraft[] = []

  for (const pid of productIds) {
    const product = productById.get(pid)
    if (!product) continue
    const unitPrice = new Prisma.Decimal(product.price)
    const taxRate = new Prisma.Decimal(product.taxRate)
    // Line subtotal scales with seatCount so a partySize=3 walk-in charges
    // 3× the class price in one transaction. seatCount=1 (the historical
    // default) leaves the math identical to the previous behavior.
    const lineSubtotal = unitPrice.mul(seatCount)
    const lineTax = lineSubtotal.mul(taxRate)
    const lineTotal = lineSubtotal.add(lineTax)
    subtotal = subtotal.add(lineSubtotal)
    totalTax = totalTax.add(lineTax)

    const modRows = modifiersByProduct.get(pid) ?? []
    const modLines: LineDraft['modifiers'] = []
    for (const m of modRows) {
      // Modifiers are per-seat add-ons: 1 "Esmalte de color" picked at
      // booking time times a family of 3 means 3 esmaltes on the bill.
      const lineTotalMod = new Prisma.Decimal(m.price).mul(m.quantity).mul(seatCount)
      subtotal = subtotal.add(lineTotalMod)
      const modTax = lineTotalMod.mul(taxRate)
      totalTax = totalTax.add(modTax)
      modLines.push({
        name: m.name ?? '',
        // OrderItemModifier.quantity stays per-unit; the OrderItem.quantity
        // below (= seatCount) is what multiplies it across the bill.
        quantity: m.quantity,
        price: new Prisma.Decimal(m.price),
        modifierId: m.modifierId,
      })
    }

    lines.push({
      productId: product.id,
      productName: product.name,
      productSku: product.sku,
      categoryName: product.category?.name ?? null,
      unitPrice,
      taxAmount: lineTax,
      total: lineTotal,
      modifiers: modLines,
    })
  }

  const total = subtotal.add(totalTax)
  // Reservation-originated orders default to DINE_IN — they're seat-anchored
  // at the booked table (when present). The cashier can change in TPV.
  const orderNumber = `RES-${Date.now().toString().slice(-8)}`

  const created = await tx.order.create({
    data: {
      venueId,
      orderNumber,
      type: OrderType.DINE_IN,
      source: OrderSource.TPV,
      reservationId,
      tableId: reservation.tableId,
      customerId: reservation.customerId,
      customerName: reservation.guestName ?? undefined,
      customerPhone: reservation.guestPhone ?? undefined,
      customerEmail: reservation.guestEmail ?? undefined,
      specialRequests: reservation.specialRequests ?? undefined,
      createdById: input.createdByStaffId ?? undefined,
      ...(reservation.assignedStaffId !== null && { servedById: reservation.assignedStaffId }),
      subtotal,
      taxAmount: totalTax,
      total,
      remainingBalance: total,
      // PENDING / kitchen PENDING / paymentStatus PENDING — cashier picks up
      // from here and either modifies items or drives "Cobrar" flow.
    },
    select: { id: true },
  })

  // OrderItems + OrderItemModifiers
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const item = await tx.orderItem.create({
      data: {
        orderId: created.id,
        productId: line.productId,
        productName: line.productName,
        productSku: line.productSku,
        categoryName: line.categoryName,
        // OrderItem.quantity = number of seats sold for this product.
        // Subtotal/tax above already include the seat multiplier.
        quantity: seatCount,
        unitPrice: line.unitPrice,
        taxAmount: line.taxAmount,
        total: line.total,
        sequence: i,
      },
      select: { id: true },
    })
    if (line.modifiers.length > 0) {
      await tx.orderItemModifier.createMany({
        data: line.modifiers.map(m => ({
          orderItemId: item.id,
          modifierId: m.modifierId,
          name: m.name,
          quantity: m.quantity,
          price: m.price,
        })),
      })
    }
  }

  return { orderId: created.id, created: true }
}
