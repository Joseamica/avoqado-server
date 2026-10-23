import { Prisma, type Product, type Payment } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { previewGroupExisting, applyGroupExisting } from '@/services/product-variants/groupExisting.service'
import { crearNegocioDePrueba, limpiarNegocioDePrueba } from '../giftCards/sembrarTarjetasDeRegalo'
import type { CreateExchangeBody } from '@/services/exchanges/exchange.service'
import { keptMarkdownDiscountRow } from '@/services/shared/discount.service'
import { sincronizarRepartos } from '@/services/shared/repartoDescuentoTx'

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
