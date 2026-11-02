/**
 * Task4: datos históricos SINTÉTICOS propios; no copia ni acredita Testarudo/QA.
 * Prisma/Postgres, revisión, comp/recalc/beneficios, payCashOrder e inventario REALES.
 * Sólo se aíslan Socket.IO y el aviso externo de wallet; no se mockean importes ni posting de caja.
 * ROOT ejecuta UN archivo con el runner desechable local existente (DATABASE_CONNECTION_LIMIT=4).
 */
import cuid = require('cuid')
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { revisarCortesiaPendiente, type CortesiaPendienteInput } from '@/services/mobile/cortesia-pendiente.mobile.service'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { comoJson, nuevoRepartoDirigido } from '@/services/shared/repartoDescuento'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(database.hostname) || !/^\/avoqado_[a-z0-9]+_test_/.test(database.pathname)) {
  throw new Error('Esta suite exige una base desechable local nueva; nunca av-db-25 ni una base QA existente.')
}
const suffix = cuid()
let venueId: string, actorId: string, originalStaffId: string, categoryId: string

beforeAll(async () => {
  const organization = await prisma.organization.create({
    data: { name: `Courtesy ${suffix}`, email: `${suffix}@org.test`, phone: '5555555555' },
  })
  venueId = (
    await prisma.venue.create({ data: { organizationId: organization.id, name: `Courtesy ${suffix}`, slug: suffix, seatCapExempt: true } })
  ).id
  actorId = (
    await prisma.staff.create({ data: { email: `${suffix}@manager.test`, firstName: 'Gerente', lastName: 'Sintético', active: true } })
  ).id
  originalStaffId = (
    await prisma.staff.create({ data: { email: `${suffix}@original.test`, firstName: 'Captura', lastName: 'Original', active: true } })
  ).id
  await prisma.staffVenue.create({ data: { venueId, staffId: actorId, role: 'MANAGER', active: true } })
  await prisma.staffVenue.create({ data: { venueId, staffId: originalStaffId, role: 'CASHIER', active: true } })
  categoryId = (await prisma.menuCategory.create({ data: { venueId, name: 'Sintéticos', slug: suffix } })).id
  for (const id of [organization.id, venueId, actorId, originalStaffId, categoryId]) expect(id).toMatch(/^c[a-z0-9]{24}$/)
})

// La base completa pertenece al runner y se borra en su finally; no deleteMany ni teardown de fixtures ajenas.
afterEach(() => jest.restoreAllMocks())

async function fixture(count = 2, quantity = 1, compactModifierQuantity = 1) {
  const key = cuid()
  const product = await prisma.product.create({
    data: {
      venueId,
      categoryId,
      sku: cuid(),
      name: 'Artículo sintético',
      price: 90,
      trackInventory: true,
      inventoryMethod: 'QUANTITY',
    },
  })
  const inventory = await prisma.inventory.create({ data: { venueId, productId: product.id, currentStock: 20 } })
  const group = await prisma.modifierGroup.create({ data: { venueId, name: 'Extras sintéticos', allowMultiple: true } })
  const a = await prisma.modifier.create({ data: { groupId: group.id, name: 'Extra A', price: 10 } })
  const b = await prisma.modifier.create({ data: { groupId: group.id, name: 'Extra B', price: 10 } })
  await prisma.productModifierGroup.create({ data: { productId: product.id, groupId: group.id } })
  // La fuente original se define ANTES del writer canónico: nunca se deriva por índice/producto desde filas leídas.
  const original: CortesiaPendienteInput = {
    originalPaymentKey: key,
    externalId: key,
    expectedAmountCents: 0,
    expectedTipCents: 0,
    lines: Array.from({ length: count }, (_, n) => ({
      externalId: cuid(),
      productId: product.id,
      quantity,
      modifierIds: compactModifierQuantity === 1 ? [a.id, b.id] : Array.from({ length: compactModifierQuantity }, () => a.id),
      isCortesia: true as const,
      cortesiaReason: n % 2 === 0 ? 'Especial del administrador' : 'Amigos y familia',
    })),
  }
  const lineTotal = (90 + 10 * (compactModifierQuantity === 1 ? 2 : compactModifierQuantity)) * quantity
  const order = await prisma.order.create({
    data: {
      venueId,
      externalId: key,
      orderNumber: `SYN-${key}`,
      source: 'AVOQADO_ANDROID',
      type: 'TAKEOUT',
      originSystem: 'AVOQADO',
      contratoDePrecio: 'IVA_INCLUIDO',
      createdById: originalStaffId,
      status: 'CONFIRMED',
      paymentStatus: 'PENDING',
      subtotal: lineTotal * count,
      total: lineTotal * count,
      taxAmount: 0,
      paidAmount: 0,
      remainingBalance: lineTotal * count,
      items: {
        create: original.lines.map(line => ({
          externalId: line.externalId,
          productId: line.productId,
          productName: product.name,
          quantity: line.quantity,
          unitPrice: 90,
          total: lineTotal,
          taxAmount: 0,
          isCortesia: false,
          modifiers: {
            create:
              compactModifierQuantity === 1
                ? [
                    { modifierId: a.id, name: a.name, quantity: 1, price: 10 },
                    { modifierId: b.id, name: b.name, quantity: 1, price: 10 },
                  ]
                : [{ modifierId: a.id, name: a.name, quantity: compactModifierQuantity, price: 10 }],
          },
        })),
      },
    },
  })
  await prisma.activityLog.create({
    data: {
      venueId,
      staffId: originalStaffId,
      action: 'SYNTHETIC_EXISTING_HISTORY',
      entity: 'Order',
      entityId: order.id,
      data: { preserved: true },
    },
  })
  for (const id of [product.id, inventory.id, group.id, a.id, b.id, order.id]) expect(id).toMatch(/^c[a-z0-9]{24}$/)
  return { orderId: order.id, original, inventoryId: inventory.id, key, modifierId: a.id, quantity: count * quantity }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
type Review = Awaited<ReturnType<typeof revisarCortesiaPendiente>>
const review = (f: Fixture, body: CortesiaPendienteInput = f.original) => revisarCortesiaPendiente(venueId, { actorId }, body)
const confirmation = (f: Fixture, p: Review): CortesiaPendienteInput => ({ ...f.original, confirm: true, expected: p.snapshot })
const pay = (f: Fixture) =>
  payCashOrder(venueId, f.orderId, {
    amount: 0,
    tip: 0,
    staffId: actorId,
    idempotencyKey: f.key,
    isOfflineReplay: true,
  })

async function state(f: Fixture, db: Prisma.TransactionClient = prisma) {
  const items = await db.orderItem.findMany({
    where: { orderId: f.orderId },
    include: { modifiers: { orderBy: { id: 'asc' } } },
    orderBy: { id: 'asc' },
    take: 101,
  })
  return {
    order: await db.order.findUniqueOrThrow({ where: { id: f.orderId } }),
    items,
    discounts: await db.orderDiscount.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' }, take: 101 }),
    audits: await db.activityLog.findMany({
      where: {
        venueId,
        OR: [
          { entity: 'Order', entityId: f.orderId },
          { entity: 'OrderItem', entityId: { in: items.map(i => i.id) } },
        ],
      },
      orderBy: { id: 'asc' },
      take: 105,
    }),
    payments: await db.payment.findMany({ where: { venueId, orderId: f.orderId }, orderBy: { id: 'asc' }, take: 5 }),
    postings: await db.inventoryPosting.findMany({ where: { venueId, sourceId: f.orderId }, orderBy: { id: 'asc' }, take: 5 }),
    inventory: await db.inventory.findUniqueOrThrow({ where: { id: f.inventoryId } }),
    movements: await db.inventoryMovement.findMany({ where: { inventoryId: f.inventoryId }, orderBy: { id: 'asc' }, take: 10 }),
  }
}
const lineAudits = (s: Awaited<ReturnType<typeof state>>) => s.audits.filter(a => a.action === 'ORDER_ITEM_COMPED')

function expectCanonical(p: Review, before: Awaited<ReturnType<typeof state>>) {
  const o = before.order
  expect(p.snapshot).toMatchObject({
    orderId: o.id,
    externalId: o.externalId,
    orderNumber: o.orderNumber,
    version: o.version,
    status: o.status,
    paymentStatus: o.paymentStatus,
    originSystem: o.originSystem,
    contratoDePrecio: o.contratoDePrecio,
    tableId: o.tableId,
    servedById: o.servedById,
    deliveryFeeCents: Number(o.deliveryFeeAmount) * 100,
    subtotalCents: Number(o.subtotal) * 100,
    discountCents: Number(o.discountAmount) * 100,
    taxCents: Number(o.taxAmount) * 100,
    serviceChargeCents: Number(o.serviceChargeAmount) * 100,
    tipCents: Number(o.tipAmount) * 100,
    totalCents: Number(o.total) * 100,
    paidAmountCents: Number(o.paidAmount) * 100,
    remainingBalanceCents: Number(o.remainingBalance) * 100,
  })
  expect(p.snapshot.lines).toHaveLength(before.items.length)
  for (const item of before.items) {
    expect(p.snapshot.lines).toContainEqual(
      expect.objectContaining({
        id: item.id,
        externalId: item.externalId,
        productId: item.productId,
        quantity: item.quantity,
        unitPriceCents: Number(item.unitPrice) * 100,
        totalCents: Number(item.total) * 100,
        discountCents: Number(item.discountAmount) * 100,
        taxCents: Number(item.taxAmount) * 100,
        isCortesia: item.isCortesia,
        cortesiaReason: item.cortesiaReason,
        appliedDiscountId: item.appliedDiscountId,
        modifierIds: item.modifiers.flatMap(m => Array.from({ length: m.quantity }, () => m.modifierId)).sort(),
        modifiers: item.modifiers.map(m => ({
          id: m.id,
          modifierId: m.modifierId,
          quantity: m.quantity,
          priceCents: Number(m.price) * 100,
        })),
      }),
    )
  }
}

describe('Task4 cortesía pendiente: revisión→pago original con Postgres real', () => {
  it.each([
    [1, 1],
    [1, 2],
    [2, 1],
    [2, 2],
  ])(
    'original completo %i líneas, cantidad %i: preview sin efectos, confirm/replay, payK/replay e inventario una vez',
    async (count, quantity) => {
      const f = await fixture(count, quantity)
      const sourceBytes = JSON.stringify(f.original)
      const before = await state(f)
      const p = await review(f)
      expect(p.outcome).toBe('PREVIEW')
      expectCanonical(p, before)
      expect(await state(f)).toEqual(before)
      const body = confirmation(f, p)
      // Orden de lista y de extras no es identidad; las razones siguen ligadas al externalId original.
      body.lines = [...body.lines].reverse().map(line => ({ ...line, modifierIds: [...line.modifierIds].reverse() }))
      const applied = await review(f, body)
      expect(applied).toMatchObject({
        outcome: 'APPLIED',
        originalPaymentKey: f.key,
        snapshot: { orderId: f.orderId, totalCents: 0, paymentStatus: 'PENDING' },
      })
      const committed = await state(f)
      expect(committed.payments).toHaveLength(0)
      expect(committed.postings).toHaveLength(0)
      expect(committed.movements).toHaveLength(0)
      expect(Number(committed.inventory.currentStock)).toBe(20)
      expect(lineAudits(committed)).toHaveLength(count)
      expect(committed.audits).toContainEqual(before.audits[0])
      for (const source of f.original.lines) {
        const line = committed.items.find(i => i.externalId === source.externalId)!
        expect(line).toMatchObject({ isCortesia: true, cortesiaReason: source.cortesiaReason })
        expect(Number(line.total)).toBe(0)
        expect(lineAudits(committed)).toContainEqual(
          expect.objectContaining({
            staffId: actorId,
            entityId: line.id,
            data: expect.objectContaining({
              orderId: f.orderId,
              orderNumber: before.order.orderNumber,
              originalPaymentKey: f.key,
              reason: source.cortesiaReason,
            }),
          }),
        )
      }
      // Se pierde la respuesta de confirmación: mismo cuerpo, sin cambiar la versión ni duplicar auditorías.
      expect(await review(f, body)).toMatchObject({ outcome: 'ALREADY_APPLIED', snapshot: applied.snapshot })
      expect(await state(f)).toEqual(committed)
      const firstPayment = await pay(f)
      const paid = await state(f)
      expect(firstPayment).toMatchObject({ amount: 0, orderPaymentStatus: 'PAID' })
      expect(paid.payments).toHaveLength(1)
      expect(paid.payments[0]).toMatchObject({ id: firstPayment.paymentId, idempotencyKey: f.key })
      expect(paid.postings).toHaveLength(1)
      expect(paid.postings[0]).toMatchObject({ effectKind: 'SALE', status: 'APPLIED' })
      expect(Number(paid.inventory.currentStock)).toBe(20 - f.quantity)
      expect(paid.movements.reduce((sum, m) => sum + Number(m.quantity), 0)).toBe(-f.quantity)
      expect(paid.movements.every(m => m.type === 'SALE' && m.reference === f.orderId)).toBe(true)
      expect(lineAudits(paid)).toEqual(lineAudits(committed))
      // Se pierde también la respuesta de pago: se recupera el MISMO pagoK, aun después de cerrar la cuenta.
      expect((await pay(f)).paymentId).toBe(firstPayment.paymentId)
      expect(await state(f)).toEqual(paid)
      expect(await prisma.order.count({ where: { venueId, externalId: f.key } })).toBe(1)
      expect(JSON.stringify(f.original)).toBe(sourceBytes)
    },
  )

  it('RED familia: original un extra vs canónico DOS del MISMO modifierId ya antes del preview debe rechazar sin mutar', async () => {
    const f = await fixture(1, 1, 2)
    f.original.lines[0].modifierIds = [f.modifierId]
    const before = await state(f)
    expect(before.items[0].modifiers).toHaveLength(1)
    expect(before.items[0].modifiers[0]).toMatchObject({ modifierId: f.modifierId, quantity: 2 })
    // No se modifica la cuenta entre preview y confirm: comparar sólo la foto consigo misma no basta.
    let caught: unknown
    try {
      const p = await review(f)
      await review(f, confirmation(f, p))
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ statusCode: 409 })
    expect(await state(f)).toEqual(before)
  })

  it('RED vecino legítimo: original DOS extras con ID repetido acepta la fila canónica compactada quantity2, sin adivinar IDs', async () => {
    const f = await fixture(1, 2, 2)
    const before = await state(f)
    expect(f.original.lines[0].modifierIds).toEqual([f.modifierId, f.modifierId])
    expect(before.items[0].modifiers).toHaveLength(1)
    expect(before.items[0].modifiers[0].quantity).toBe(2)
    const p = await review(f)
    expectCanonical(p, before)
    expect(p.snapshot.lines[0].modifierIds).toEqual([f.modifierId, f.modifierId])
    expect(await review(f, confirmation(f, p))).toMatchObject({ outcome: 'APPLIED', snapshot: { totalCents: 0 } })
    await pay(f)
    expect(Number((await state(f)).inventory.currentStock)).toBe(18)
  })

  it('una obligación UNKNOWN persistida bloquea la confirmación real sin Payment, inventario ni cortesías', async () => {
    const f = await fixture()
    const p = await review(f)
    const blocker = await prisma.terminalPaymentRequest.create({
      data: {
        venueId,
        orderId: f.orderId,
        terminalId: cuid(),
        requestId: cuid(),
        amountCents: 22000,
        status: 'UNKNOWN',
        expiresAt: new Date('2000-01-01T00:00:00Z'),
        requestedById: actorId,
      },
    })
    const before = await state(f)
    await expect(review(f, confirmation(f, p))).rejects.toMatchObject({
      statusCode: 409,
      code: 'ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE',
      details: { requestId: blocker.requestId },
    })
    expect(await state(f)).toEqual(before)
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: blocker.id } })).status).toBe('UNKNOWN')
  })
})

/** Molde mínimo de mobileWriters.atomic y httpOperationOutcome: ambos beneficios asociados a una fila dirigida real. */
async function withBenefits(f: Fixture) {
  const customer = await prisma.customer.create({ data: { venueId, firstName: 'Beneficios sintéticos', loyaltyPoints: 900 } })
  const firstLine = await prisma.orderItem.findUniqueOrThrow({
    where: { orderId_externalId: { orderId: f.orderId, externalId: f.original.lines[0].externalId } },
  })
  const redemption = await prisma.loyaltyTransaction.create({
    data: { customerId: customer.id, type: 'REDEEM', points: -1000, orderId: f.orderId },
  })
  const discount = await prisma.orderDiscount.create({
    data: {
      orderId: f.orderId,
      type: 'FIXED_AMOUNT',
      name: 'Beneficio dirigido sintético',
      value: 10,
      amount: 10,
      isManual: true,
      loyaltyTransactionId: redemption.id,
      appliedToItemIds: [firstLine.id],
      reparto: comoJson(nuevoRepartoDirigido(10, { [firstLine.id]: 110 }, { espejo: false })),
    },
  })
  const card = await prisma.stampCard.create({
    data: {
      customerId: customer.id,
      venueId,
      cycle: 1,
      stampsRequired: 5,
      stampsEarned: 5,
      completedAt: new Date(),
    },
  })
  const reward = await prisma.stampReward.create({
    data: {
      stampCardId: card.id,
      customerId: customer.id,
      venueId,
      rewardType: 'FIXED_AMOUNT',
      rewardValue: 10,
      rewardLabel: 'Premio sintético',
      status: 'REDEEMED',
      redeemedAt: new Date(),
      orderDiscountId: discount.id,
    },
  })
  await prisma.order.update({
    where: { id: f.orderId },
    data: { customerId: customer.id, discountAmount: 10, total: 210, remainingBalance: 210 },
  })
  return { customerId: customer.id, rewardId: reward.id, cardId: card.id, discountId: discount.id }
}
type Benefits = Awaited<ReturnType<typeof withBenefits>>
async function benefitState(f: Fixture, b: Benefits, db: Prisma.TransactionClient = prisma) {
  return {
    customer: await db.customer.findUniqueOrThrow({ where: { id: b.customerId } }),
    reward: await db.stampReward.findUniqueOrThrow({ where: { id: b.rewardId } }),
    card: await db.stampCard.findUniqueOrThrow({ where: { id: b.cardId } }),
    ledger: await db.loyaltyTransaction.findMany({
      where: { customerId: b.customerId, orderId: f.orderId },
      orderBy: { id: 'asc' },
      take: 5,
    }),
  }
}

it('Postgres revierte DOS cortesías, auditorías, puntos y premio si falla la segunda auditoría; retry devuelve beneficios una sola vez', async () => {
  const f = await fixture(),
    b = await withBenefits(f)
  const before = await state(f),
    beforeBenefits = await benefitState(f, b)
  const p = await review(f),
    body = confirmation(f, p)
  expect(await state(f)).toEqual(before)
  expect(await benefitState(f, b)).toEqual(beforeBenefits)
  expectCanonical(p, before)
  const fault = new Error('owned-second-courtesy-audit-after-real-insert')
  const realTransaction = prisma.$transaction.bind(prisma)
  let ownInserts = 0,
    verifiedInsideRollback = false
  // Sólo instrumenta el borde SQL del audit de ESTA cuenta. Pricing, refunds, escrituras y tx/rollback son reales.
  const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((operation: any, options: any) => {
    if (typeof operation !== 'function') return realTransaction(operation, options)
    return realTransaction(
      (tx: Prisma.TransactionClient) =>
        operation(
          new Proxy(tx, {
            get(target, field) {
              if (field !== 'activityLog') return Reflect.get(target, field)
              return new Proxy(target.activityLog, {
                get(delegate, method) {
                  if (method !== 'create') return Reflect.get(delegate, method)
                  return async (args: Prisma.ActivityLogCreateArgs) => {
                    const row = await delegate.create(args)
                    const data = args.data.data as Prisma.JsonObject | undefined
                    if (
                      args.data.venueId === venueId &&
                      args.data.action === 'ORDER_ITEM_COMPED' &&
                      data?.orderId === f.orderId &&
                      ++ownInserts === 2
                    ) {
                      const inside = await state(f, tx),
                        benefits = await benefitState(f, b, tx)
                      expect(inside.items.every(i => i.isCortesia)).toBe(true)
                      expect(lineAudits(inside)).toHaveLength(2)
                      expect(benefits.customer.loyaltyPoints).toBe(1900)
                      expect(benefits.ledger.filter(l => l.type === 'ADJUST')).toHaveLength(1)
                      expect(benefits.reward).toMatchObject({ status: 'PENDING', redeemedAt: null, orderDiscountId: null })
                      verifiedInsideRollback = true
                      throw fault
                    }
                    return row
                  }
                },
              })
            },
          }),
        ),
      options,
    )
  }) as any)
  try {
    await expect(review(f, body)).rejects.toBe(fault)
  } finally {
    spy.mockRestore()
  }
  expect(ownInserts).toBe(2)
  expect(verifiedInsideRollback).toBe(true)
  expect(await state(f)).toEqual(before)
  expect(await benefitState(f, b)).toEqual(beforeBenefits)

  expect(await review(f, body)).toMatchObject({ outcome: 'APPLIED', snapshot: { totalCents: 0 } })
  const committed = await state(f),
    benefits = await benefitState(f, b)
  expect(committed.discounts).toHaveLength(0)
  expect(lineAudits(committed)).toHaveLength(2)
  expect(benefits.customer.loyaltyPoints).toBe(1900)
  const adjustments = benefits.ledger.filter(l => l.type === 'ADJUST')
  expect(adjustments).toHaveLength(1)
  expect(adjustments[0].points).toBe(1000)
  expect(benefits.reward).toMatchObject({ status: 'PENDING', redeemedAt: null, orderDiscountId: null })
  expect(lineAudits(committed).flatMap(a => (a.data as Prisma.JsonObject).discountBenefits as Prisma.JsonArray)).toContainEqual({
    orderDiscountId: b.discountId,
    loyaltyRefund: { pointsRefunded: 1000, customerId: b.customerId, transactionId: adjustments[0].id },
    stampRefund: { rewardId: b.rewardId, customerId: b.customerId, rewardLabel: 'Premio sintético' },
  })
  expect(await review(f, body)).toMatchObject({ outcome: 'ALREADY_APPLIED' })
  expect(await state(f)).toEqual(committed)
  expect(await benefitState(f, b)).toEqual(benefits)
})
