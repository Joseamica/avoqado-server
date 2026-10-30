import { Prisma, type Product, type Payment } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { previewGroupExisting, applyGroupExisting } from '@/services/product-variants/groupExisting.service'
import { crearNegocioDePrueba, limpiarNegocioDePrueba } from '../giftCards/sembrarTarjetasDeRegalo'
import type { CreateExchangeBody } from '@/services/exchanges/exchange.service'
import { keptMarkdownDiscountRow } from '@/services/shared/discount.service'
import { sincronizarRepartos } from '@/services/shared/repartoDescuentoTx'
import cuid from 'cuid'
import { terminalIdentityKey } from '@/utils/terminalSerial'

export async function seedClothingSale(
  opts: { paid?: number; list?: number; payments?: number[]; card?: boolean; quantity?: number } = {},
) {
  const { venueId, staffId, organizationId } = await crearNegocioDePrueba('cambio-parejo')
  await prisma.venue.update({ where: { id: venueId }, data: { type: 'CLOTHING' } })
  const category = await prisma.menuCategory.create({ data: { venueId, name: 'Ropa', slug: 'ropa' } })
  const seller = await prisma.staff.create({ data: { email: `${venueId}@seller.test`, firstName: 'Venta', lastName: 'Original' } })
  await prisma.staffVenue.create({ data: { venueId, staffId: seller.id, role: 'CASHIER' } })
  const customer = await prisma.customer.create({
    data: { venueId, firstName: 'Clienta', totalVisits: 3, totalSpent: 500, loyaltyPoints: 20 },
  })
  await prisma.loyaltyConfig.create({
    data: { venueId, active: true, pointsPerDollar: 1, stampsEnabled: true, stampsRequired: 7, maxStampsPerDay: 0 },
  })
  await prisma.commissionConfig.create({
    data: { venueId, orgId: organizationId, name: 'Comisión de prueba', defaultRate: new Prisma.Decimal('0.05'), createdById: staffId },
  })
  const merchantId = opts.card
    ? (
        await prisma.merchantAccount.create({
          data: {
            provider: {
              connectOrCreate: {
                where: { code: 'ANGELPAY' },
                create: { code: 'ANGELPAY', name: 'AngelPay', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
              },
            },
            externalMerchantId: `${venueId}-tarjeta`,
            alias: 'Tarjeta de prueba',
            credentialsEncrypted: {},
          },
        })
      ).id
    : null
  const list = opts.list ?? 500
  const paid = opts.paid ?? list
  const quantity = opts.quantity ?? 1
  const products: Product[] = []
  for (const size of ['M', 'L', 'XL', 'Blusa', 'Top']) {
    products.push(
      await prisma.product.create({
        data: {
          venueId,
          categoryId: category.id,
          sku: `${venueId}-${size}`,
          name: `Falda ${size}`,
          price: new Prisma.Decimal(list),
          trackInventory: true,
          inventoryMethod: 'QUANTITY',
          inventory: { create: { venueId, currentStock: new Prisma.Decimal(10) } },
        },
      }),
    )
  }
  const group = {
    name: 'Falda',
    options: [{ name: 'Talla', values: ['M', 'L', 'XL'] }],
    members: products.slice(0, 3).map((p, i) => ({ productId: p.id, values: [['M', 'L', 'XL'][i]] })),
  }
  const preview = await previewGroupExisting(venueId, group)
  await applyGroupExisting(
    venueId,
    { ...group, expectedFingerprint: preview.fingerprint },
    { type: 'HUMAN', staffId, impersonating: false },
  )
  const shift = await prisma.shift.create({
    data: { venueId, staffId, startTime: new Date(), status: 'OPEN', startingCash: 100, totalSales: paid * quantity },
  })
  const drawer = await prisma.cashDrawerSession.create({
    data: { venueId, openedByStaffId: staffId, openedByName: 'Caja', startingAmount: 100, shiftId: shift.id },
  })
  const order = await prisma.order.create({
    data: {
      venueId,
      shiftId: shift.id,
      orderNumber: `ORIGINAL-${venueId}`,
      type: 'TAKEOUT',
      source: 'AVOQADO_IOS',
      servedById: seller.id,
      createdById: seller.id,
      customerId: customer.id,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      kitchenStatus: 'SERVED',
      contratoDePrecio: 'IVA_INCLUIDO',
      subtotal: list * quantity,
      discountAmount: (list - paid) * quantity,
      taxAmount: 0,
      total: paid * quantity,
      paidAmount: paid * quantity,
      remainingBalance: 0,
      orderCustomers: { create: { customerId: customer.id, isPrimary: true } },
      items: {
        create: {
          productId: products[0].id,
          productName: 'Falda M',
          quantity,
          unitPrice: list,
          discountAmount: (list - paid) * quantity,
          taxAmount: 0,
          total: list * quantity,
        },
      },
    },
    include: { items: true },
  })
  const payments: Payment[] = []
  if (list > paid) {
    await prisma.$transaction(async tx => {
      await tx.orderDiscount.create({
        data: keptMarkdownDiscountRow({
          orderId: order.id,
          itemId: order.items[0].id,
          discountAmountPesos: (list - paid) * quantity,
          appliedById: null,
        }),
      })
      await sincronizarRepartos(tx, order.id)
    })
  }
  for (const amount of opts.payments ?? [paid * quantity]) {
    payments.push(
      await prisma.payment.create({
        data: {
          venueId,
          orderId: order.id,
          shiftId: shift.id,
          amount,
          tipAmount: 0,
          netAmount: amount,
          feeAmount: 0,
          feePercentage: 0,
          method: opts.card ? 'CREDIT_CARD' : 'CASH',
          source: opts.card ? 'TPV' : 'POS',
          fundsFlow: opts.card ? 'AVOQADO_PROCESSED' : 'CASH_DRAWER',
          merchantAccountId: merchantId,
          status: 'COMPLETED',
          type: 'REGULAR',
          splitType: 'FULLPAYMENT',
          processedById: seller.id,
        },
      }),
    )
  }
  if (opts.card)
    for (const payment of payments)
      await prisma.paymentEffect.create({
        data: {
          venueId,
          paymentId: payment.id,
          orderId: order.id,
          kind: 'TRANSACTION_COST',
          dedupeKey: `transaction-cost:${payment.id}:v1`,
          payload: {},
          status: 'DONE',
          completedAt: new Date(),
        },
      })
  let seq = 0
  const body = (extra: Partial<CreateExchangeBody> = {}): CreateExchangeBody => ({
    idempotencyKey: `${venueId}-${++seq}`,
    originalPaymentId: payments[0].id,
    returned: [{ orderItemId: order.items[0].id, quantity: 1, restock: true, reason: 'SIZE' }],
    taken: [{ productId: products[1].id, quantity: 1, inheritsFromOrderItemId: order.items[0].id }],
    settlement: { kind: 'EVEN', method: null, expectedDifferenceCents: 0 },
    staffId,
    deviceId: 'caja-prueba',
    createdAtLocal: new Date().toISOString(),
    ...extra,
  })
  return {
    venueId,
    staffId,
    organizationId,
    seller,
    customer,
    products,
    shift,
    drawer,
    order,
    payments,
    body,
    input: (b = body()) => ({ venueId, actorStaffId: staffId, body: b }),
    async cleanup() {
      if (!venueId) return
      await prisma.exchangeCreditLink.deleteMany({ where: { venueId } })
      await prisma.exchange.deleteMany({ where: { venueId } })
      await prisma.inventoryPosting.deleteMany({ where: { venueId } })
      await limpiarNegocioDePrueba(venueId)
      await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId } } })
      await prisma.product.deleteMany({ where: { venueId } })
      await prisma.productGroup.deleteMany({ where: { venueId } })
      if (merchantId) await prisma.merchantAccount.deleteMany({ where: { id: merchantId } })
    },
  }
}

export async function seedCardSale(opts: { provider: 'BLUMON' | 'ANGELPAY' | null; amounts: number[] }) {
  const total = opts.amounts.reduce((sum, amount) => sum + amount, 0)
  const s = await seedClothingSale({ paid: total, list: total, payments: opts.amounts, card: opts.provider !== null })
  const merchantIds: string[] = []
  const terminals = []
  for (const [index, payment] of s.payments.entries()) {
    const provider = opts.provider
      ? await prisma.paymentProvider.upsert({
          where: { code: opts.provider },
          update: {},
          create: { code: opts.provider, name: opts.provider, type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
        })
      : null
    const merchant = provider
      ? await prisma.merchantAccount.create({
          data: { providerId: provider.id, externalMerchantId: cuid(), alias: 'Test card merchant', credentialsEncrypted: {} },
        })
      : null
    if (merchant) merchantIds.push(merchant.id)
    const serialNumber = `AVQD-${cuid()}`
    const terminal = await prisma.terminal.create({
      data: { venueId: s.venueId, serialNumber, name: `Test terminal ${index}`, type: 'TPV_ANDROID' },
    })
    terminals.push({ ...terminal, serialNumber })
    s.payments[index] = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        method: 'CREDIT_CARD',
        source: 'TPV',
        fundsFlow: 'AVOQADO_PROCESSED',
        merchantAccountId: merchant?.id ?? null,
        terminalId: terminal.id,
        processorData: { blumonOperationNumber: index + 1 },
      },
    })
  }
  const terminal = terminals[0]
  const newOrder = (amount = 100) =>
    prisma.order.create({
      data: {
        venueId: s.venueId,
        orderNumber: cuid(),
        source: 'AVOQADO_IOS',
        type: 'TAKEOUT',
        status: 'PENDING',
        paymentStatus: 'PENDING',
        subtotal: amount,
        total: amount,
        taxAmount: 0,
        remainingBalance: amount,
        customerId: s.customer.id,
        createdById: s.staffId,
        items: {
          create: { productId: s.products[3].id, productName: 'Replacement', quantity: 1, unitPrice: amount, total: amount, taxAmount: 0 },
        },
      },
    })
  // T4 owns reservation; seed only its durable boundary so T3 never enables an unfinished checkout.
  const pendingExchange = async (returnedAmount = 0, differenceAmount = 100) => {
    const order = await newOrder(returnedAmount + differenceAmount)
    const exchangeId = cuid()
    const exchange = await prisma.exchange.create({
      data: {
        id: exchangeId,
        venueId: s.venueId,
        idempotencyKey: cuid(),
        requestHash: 'test',
        status: 'PENDING_PAYMENT',
        originalOrderId: s.order.id,
        originalPaymentId: s.payments[0].id,
        newOrderId: order.id,
        returnedAmount,
        takenAmount: returnedAmount + differenceAmount,
        differenceAmount,
        settlementKind: 'COLLECT',
        settlementMethod: 'CARD_TERMINAL',
        lines: {},
        staffId: s.staffId,
        result: { id: exchangeId, status: 'PENDING_PAYMENT', newOrderId: order.id, paymentIds: [], chargePaymentId: null },
      },
    })
    return { order, exchange }
  }
  const seedRequest = (orderId: string, overrides: Partial<Prisma.TerminalPaymentRequestUncheckedCreateInput> = {}) =>
    prisma.terminalPaymentRequest.create({
      data: {
        venueId: s.venueId,
        requestId: cuid(),
        terminalId: terminalIdentityKey(terminal.serialNumber),
        orderId,
        amountCents: 10000,
        expiresAt: new Date(Date.now() + 300_000),
        status: 'SENT',
        ...overrides,
      },
    })
  const terminalCharge = async (orderId: string, cents: number, overrides: Record<string, unknown> = {}) => {
    const { recordOrderPayment } = await import('@/services/tpv/payment.tpv.service')
    const attempt = cuid()
    return recordOrderPayment(
      s.venueId,
      orderId,
      {
        venueId: s.venueId,
        amount: cents,
        tip: 0,
        status: 'COMPLETED',
        method: 'CREDIT_CARD',
        source: 'TPV',
        splitType: 'FULLPAYMENT',
        tpvId: terminal.id,
        staffId: s.staffId,
        paidProductsId: [],
        currency: 'MXN',
        isInternational: false,
        idempotencyKey: attempt,
        referenceNumber: attempt,
        authorizationNumber: attempt,
        merchantAccountId: merchantIds[0],
        deviceSerialNumber: terminal.serialNumber,
        authenticatedTerminalSerial: terminal.serialNumber,
        ...overrides,
      },
      s.staffId,
    )
  }
  return {
    ...s,
    terminal,
    newOrder,
    pendingExchange,
    seedRequest,
    terminalCharge,
    async cleanup() {
      if (!s.venueId) return
      await prisma.terminalPaymentRequest.deleteMany({ where: { venueId: s.venueId } })
      await s.cleanup()
      await prisma.terminal.deleteMany({ where: { venueId: s.venueId } })
      await prisma.merchantAccount.deleteMany({ where: { id: { in: merchantIds } } })
    },
  }
}
