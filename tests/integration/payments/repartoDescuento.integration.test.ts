/**
 * IVA por producto, bloque B2 (spec planes 6-7 §4.1, D7, R3-2; P1-P3), contra PostgreSQL real: cada escritor deja su reparto
 * canónico en la misma transacción y NINGÚN cobro cambia fuera de las excepciones declaradas. Mapas EXACTOS (Codex r1 #8).
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import {
  addItemsToOrder,
  applyDiscount as applyDiscountHeredado,
  compItems,
  createOrderWithItems as crearEnTerminal,
  removeOrderItem,
  voidItems,
} from '@/services/tpv/order.tpv.service'
import { applyCouponCode } from '@/services/tpv/discount.tpv.service'
import { applyAutomaticDiscounts, applyManualDiscount, removeDiscountFromOrder } from '@/services/dashboard/discountEngine.service'
import {
  applyOrderDiscount,
  createOrderWithItems as crearEnMovil,
  mergeOrders,
  payCashOrder,
  removeOrderDiscount,
  splitOrderItems,
} from '@/services/mobile/order.mobile.service'
import { compOrderItem, compWholeOrder } from '@/services/mobile/comp-item.mobile.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { syncAutomaticServiceCharges } from '@/services/mobile/service-charge.mobile.service'
import { computeOrderBalance } from '@/services/shared/orderBalance'
import { reconcileOrderFromPayments } from '@/services/tpv/payment.tpv.service'
import { loadDepositCandidates } from '@/services/dashboard/bankReconciliation.service'
import { getIncomeStatement } from '@/services/dashboard/accounting.dashboard.service'

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(database.hostname) || !/^\/avoqado_[a-z0-9]+_test_/.test(database.pathname)) {
  throw new Error('Esta suite exige una base local aislada (avoqado_<x>_test_…), nunca av-db-25.')
}

const venueId = `reparto-${randomUUID()}`
let staffId: string, staffVenueId: string, cafeId: string, panId: string, categoriaCafeId: string, llaveroId: string

const filas = (orderId: string) => prisma.orderDiscount.findMany({ where: { orderId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
const renglonDe = (orderId: string, productId: string) => prisma.orderItem.findFirstOrThrow({ where: { orderId, productId } })
const cabecera = async (orderId: string) => {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  return { subtotal: Number(o.subtotal), descuento: Number(o.discountAmount), total: Number(o.total), saldo: Number(o.remainingBalance) }
}

/** Café $100 con IVA $16 y pan $50 con IVA `ivaPan`, cabecera IVA_APARTE con `cabeceraIva` (por defecto, la suma de los dos). */
async function cafeYPanConIvaAparte(ivaPan = 8, cabeceraIva = 16 + ivaPan) {
  const o = await crearEnTerminal(venueId, {
    items: [
      { productId: cafeId, quantity: 1, unitPrice: 100 },
      { productId: panId, quantity: 1, unitPrice: 50 },
    ],
    staffId,
    taxAmount: 0,
    subtotal: 150,
    total: 150,
    tip: 0,
  } as any)
  await prisma.orderItem.updateMany({ where: { orderId: o.id, productId: cafeId }, data: { taxAmount: 16 } })
  await prisma.orderItem.updateMany({ where: { orderId: o.id, productId: panId }, data: { taxAmount: ivaPan } })
  await prisma.order.update({
    where: { id: o.id },
    data: { contratoDePrecio: 'IVA_APARTE', taxAmount: cabeceraIva, total: 150 + cabeceraIva, remainingBalance: 150 + cabeceraIva },
  })
  return { orderId: o.id, cafe: await renglonDe(o.id, cafeId), pan: await renglonDe(o.id, panId) }
}

/**
 * Una cuenta importada de SoftRestaurant con la forma REAL de sus renglones (`producer.ts:440-445`): precio CON IVA y
 * `taxAmount` POR PIEZA; cabecera con el subtotal SIN IVA (`total = subtotal + IVA`). La crea la base, como el puente.
 */
async function importadaDeSoftRestaurant(
  lineas: Array<{ productId: string; cantidad: number; precioConIva: number; ivaPorPieza: number }>,
) {
  const subtotal = lineas.reduce((s, l) => s + (l.precioConIva - l.ivaPorPieza) * l.cantidad, 0)
  const iva = lineas.reduce((s, l) => s + l.ivaPorPieza * l.cantidad, 0)
  const o = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `SR-${randomUUID().slice(0, 8)}`,
      externalId: `sr-${randomUUID()}`,
      source: 'POS',
      originSystem: 'POS_SOFTRESTAURANT',
      contratoDePrecio: 'IVA_APARTE',
      status: 'CONFIRMED',
      paymentStatus: 'PENDING',
      kitchenStatus: 'PENDING',
      type: 'DINE_IN',
      syncedAt: new Date(),
      subtotal,
      taxAmount: iva,
      discountAmount: 0,
      tipAmount: 0,
      total: subtotal + iva,
      remainingBalance: subtotal + iva,
      items: {
        create: lineas.map(l => ({
          productId: l.productId,
          externalId: `sr-${randomUUID()}`,
          originSystem: 'POS_SOFTRESTAURANT',
          quantity: l.cantidad,
          unitPrice: l.precioConIva,
          taxAmount: l.ivaPorPieza,
          discountAmount: 0,
          total: l.precioConIva * l.cantidad,
        })),
      },
    },
  })
  return o.id
}

/**
 * Lo que de verdad se cobra después del cambio: impuesto, total y saldo guardados, el saldo reconstruido con
 * `computeOrderBalance` (el cobro móvil reconstruye con él) y un cobro en efectivo por lo que pedía la v4 — lo que exceda el
 * saldo es cambio, nunca venta: `payCashOrder` registra a lo más lo que la cuenta debe.
 */
async function cobroTras(orderId: string, pideLaV4: number) {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  const reconstruido = Number(computeOrderBalance(o, []).remainingBalance)
  await payCashOrder(venueId, orderId, { amount: Math.round(pideLaV4 * 100), tip: 0, staffId, idempotencyKey: `cobro-${orderId}` }).catch(
    () => null,
  )
  const cobrado = (await prisma.payment.findMany({ where: { orderId }, select: { amount: true }, take: 10 })).reduce(
    (s, p) => s + Number(p.amount),
    0,
  )
  return { impuesto: Number(o.taxAmount), total: Number(o.total), saldo: Number(o.remainingBalance), reconstruido, cobrado }
}

/** Impuesto y total guardados antes del cambio (las cuentas de partida de un caso). */
const cobroAntes = async (orderId: string) => {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  return { impuesto: Number(o.taxAmount), total: Number(o.total) }
}

const version = async (orderId: string) =>
  (await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { version: true } })).version
/** Quita un renglón por la terminal: borrarlo (`removeOrderItem`) o anularlo (`voidItems`). */
const quitar = async (camino: 'borrar' | 'anular', orderId: string, itemId: string) =>
  camino === 'borrar'
    ? removeOrderItem(venueId, orderId, itemId, await version(orderId))
    : voidItems(venueId, orderId, { itemIds: [itemId], reason: 'Error de captura', staffId, expectedVersion: await version(orderId) })

beforeAll(async () => {
  await prisma.organization.create({ data: { id: venueId, name: venueId, email: `${venueId}@test.example`, phone: '5500000000' } })
  await prisma.venue.create({ data: { id: venueId, organizationId: venueId, name: venueId, slug: venueId } })
  staffId = (await prisma.staff.create({ data: { email: `${venueId}@staff.test`, firstName: 'Caja', lastName: 'Reparto' } })).id
  staffVenueId = (await prisma.staffVenue.create({ data: { venueId, staffId, role: 'MANAGER' } })).id
  const categoria = await prisma.menuCategory.create({ data: { venueId, name: 'Café', slug: `cafe-${venueId}` } })
  categoriaCafeId = categoria.id
  cafeId = (await prisma.product.create({ data: { venueId, categoryId: categoria.id, name: 'Café', sku: 'B2-CAFE', price: 100 } })).id
  panId = (await prisma.product.create({ data: { venueId, categoryId: categoria.id, name: 'Pan', sku: 'B2-PAN', price: 50 } })).id
  // Otra categoría: el artículo AJENO de las pruebas de P1 acotado (Codex r2 N1).
  const regalos = await prisma.menuCategory.create({ data: { venueId, name: 'Regalos', slug: `regalos-${venueId}` } })
  llaveroId = (await prisma.product.create({ data: { venueId, categoryId: regalos.id, name: 'Llavero', sku: 'B2-LLAVERO', price: 100 } }))
    .id
})

afterAll(async () => {
  const ordenes = (await prisma.order.findMany({ where: { venueId }, select: { id: true }, take: 200 })).map(o => o.id)
  await prisma.stampReward.updateMany({ where: { venueId }, data: { orderDiscountId: null } })
  await prisma.orderDiscount.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.loyaltyTransaction.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.orderAction.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.orderItem.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.payment.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.order.deleteMany({ where: { id: { in: ordenes } } })
  await prisma.activityLog.deleteMany({ where: { venueId } }) // las reaperturas de la Tarea 6a (sin FK al negocio)
  await prisma.stampReward.deleteMany({ where: { venueId } })
  await prisma.stampCard.deleteMany({ where: { venueId } })
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.loyaltyConfig.deleteMany({ where: { venueId } })
  await prisma.promotion.deleteMany({ where: { venueId } })
  await prisma.discount.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: venueId } })
})

async function cuentaDeCafe(extra: Record<string, unknown> = {}) {
  const o = await crearEnTerminal(venueId, {
    items: [{ productId: cafeId, quantity: 1, unitPrice: 100 }],
    staffId,
    taxAmount: 0,
    subtotal: 100,
    total: 100,
    tip: 0,
    ...extra,
  } as any)
  return o.id
}

describe('recálculos', () => {
  it('agregar un artículo tras un % de cuenta re-deriva el importe como hoy y reescribe el reparto en la misma transacción', async () => {
    const orderId = await cuentaDeCafe()
    await applyManualDiscount(orderId, 'PERCENTAGE', 10, '10 % cuenta', staffVenueId, undefined, undefined, venueId)
    const { version } = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { version: true } })

    await addItemsToOrder(venueId, orderId, [{ productId: panId, quantity: 1 }], version) // sincronizarRepartos

    const [pct] = await filas(orderId)
    const [cafe, pan] = [await renglonDe(orderId, cafeId), await renglonDe(orderId, panId)]
    expect(Number(pct.amount)).toBe(15)
    expect(pct.reparto).toEqual({
      v: 1,
      alcance: 'CUENTA',
      conPromociones: false,
      espejo: false,
      renglones: { [cafe.id]: 1000, [pan.id]: 500 },
    })
    expect(await cabecera(orderId)).toEqual({ subtotal: 150, descuento: 15, total: 135, saldo: 135 })
  })
})

describe('móvil', () => {
  it('descuento de artículo: fila ESPEJO dirigida al renglón y cobro de hoy', async () => {
    const diez = await prisma.discount.create({ data: { venueId, name: '10 % café', type: 'PERCENTAGE', value: 10, scope: 'ITEM' } })
    const creada = await crearEnMovil(venueId, {
      staffId,
      items: [{ productId: cafeId, quantity: 1, discountId: diez.id }],
      source: 'AVOQADO_ANDROID',
    } as any)
    const [fila] = await filas(creada.id)
    const renglon = await renglonDe(creada.id, cafeId)
    expect(fila.reparto).toEqual({ v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: true, renglones: { [renglon.id]: 1000 } })
    expect(await cabecera(creada.id)).toEqual({ subtotal: 100, descuento: 10, total: 90, saldo: 90 })
  })
  // Revisión de T3 (Review Focus #2), contra PostgreSQL: el camino de la reafirmación con promociones.
  it('venta de puras promociones con descuento de cuenta: la fila nace con el importe reafirmado y su reparto cae en el combo', async () => {
    const combo = await prisma.promotion.create({
      data: {
        venueId,
        name: `Combo ${randomUUID()}`,
        type: 'BUNDLE',
        pricingMode: 'FIXED_TOTAL',
        priceCents: 9000,
        status: 'PUBLISHED',
        daysOfWeek: [],
        groups: {
          create: [
            { name: 'Café', displayOrder: 0, options: { create: [{ productId: cafeId }] } },
            { name: 'Pan', displayOrder: 1, options: { create: [{ productId: panId }] } },
          ],
        },
      },
      include: { groups: { include: { options: true }, orderBy: { displayOrder: 'asc' } } },
    })
    const selections = combo.groups.map(g => ({ groupId: g.id, optionId: g.options[0].id }))
    const creada = await crearEnMovil(venueId, {
      staffId,
      items: [{ quantity: 1, promotionRef: { promotionId: combo.id, promotionInstanceId: randomUUID(), selections } }],
      discount: 1000,
      source: 'AVOQADO_ANDROID',
    } as any)
    const [cafe, pan] = [await renglonDe(creada.id, cafeId), await renglonDe(creada.id, panId)]
    // El combo de $90 reparte su precio 2:1 (café $60, pan $30); al crear la orden el subtotal era 0, la reafirmación
    // vuelve a dar los $10 contra el subtotal CON el combo.
    expect([Number(cafe.total), Number(pan.total)]).toEqual([60, 30])
    const [fila] = await filas(creada.id)
    expect(fila).toMatchObject({ type: 'FIXED_AMOUNT', name: 'Descuento de la cuenta' })
    expect(Number(fila.amount)).toBe(10)
    expect(fila.reparto).toEqual({
      v: 1,
      alcance: 'CUENTA',
      conPromociones: true,
      espejo: false,
      renglones: { [cafe.id]: 667, [pan.id]: 333 },
    })
    expect(await cabecera(creada.id)).toEqual({ subtotal: 90, descuento: 10, total: 80, saldo: 80 })
  })
  it('descuento de artículo (espejo) y descuento de cuenta, sin promociones: la cuenta reparte sobre lo que queda de cada renglón', async () => {
    const diez = await prisma.discount.create({ data: { venueId, name: '10 % café mixto', type: 'PERCENTAGE', value: 10, scope: 'ITEM' } })
    const creada = await crearEnMovil(venueId, {
      staffId,
      items: [
        { productId: cafeId, quantity: 1, discountId: diez.id },
        { productId: panId, quantity: 1 },
      ],
      discount: 1000,
      source: 'AVOQADO_ANDROID',
    } as any)
    const [cafe, pan] = [await renglonDe(creada.id, cafeId), await renglonDe(creada.id, panId)]
    const todas = await filas(creada.id)
    expect(todas.find(f => f.discountId === diez.id)?.reparto).toEqual({
      v: 1,
      alcance: 'DIRIGIDO',
      conPromociones: null,
      espejo: true,
      renglones: { [cafe.id]: 1000 },
    })
    // Lugar: café $100 − $10 de su descuento = $90; pan $50 ⇒ $10 en 90:50 = 642.86 / 357.14 centavos.
    expect(todas.find(f => f.discountId === null)?.reparto).toEqual({
      v: 1,
      alcance: 'CUENTA',
      conPromociones: true,
      espejo: false,
      renglones: { [cafe.id]: 643, [pan.id]: 357 },
    })
    expect(await cabecera(creada.id)).toEqual({ subtotal: 150, descuento: 20, total: 130, saldo: 130 })
  })
})

describe('terminal', () => {
  it('cortesía espejo y descuento de orden con su base; cobro de hoy', async () => {
    const veinte = await prisma.discount.create({ data: { venueId, name: '$20 cuenta', type: 'FIXED_AMOUNT', value: 20, scope: 'ORDER' } })
    const o = await crearEnTerminal(venueId, {
      items: [
        { productId: cafeId, quantity: 1, unitPrice: 100 },
        { productId: panId, quantity: 1, unitPrice: 50, isCortesia: true, cortesiaReason: 'Invitación' },
      ],
      orderDiscountId: veinte.id,
      discount: 20,
      staffId,
      taxAmount: 0,
      subtotal: 150,
      total: 80,
      tip: 0,
    } as any)
    const [cafe, pan] = [await renglonDe(o.id, cafeId), await renglonDe(o.id, panId)]
    const todas = await filas(o.id)
    expect(todas.find(f => f.type === 'COMP')?.reparto).toEqual({
      v: 1,
      alcance: 'DIRIGIDO',
      conPromociones: null,
      espejo: true,
      renglones: { [pan.id]: 5000 },
    })
    expect(todas.find(f => f.discountId === veinte.id)?.reparto).toEqual({
      v: 1,
      alcance: 'CUENTA',
      conPromociones: false,
      base: [cafe.id],
      espejo: false,
      renglones: { [cafe.id]: 2000 },
    })
    expect(await cabecera(o.id)).toEqual({ subtotal: 150, descuento: 70, total: 80, saldo: 80 })
  })
  it('🔴 P2 antes/después: el descuento libre sobrevive a agregar un artículo (hoy, con otra fila presente, se perdía)', async () => {
    const diez = await prisma.discount.create({ data: { venueId, name: '10 % café P2', type: 'PERCENTAGE', value: 10, scope: 'ITEM' } })
    const o = await crearEnTerminal(venueId, {
      items: [{ productId: cafeId, quantity: 1, unitPrice: 100, itemDiscountId: diez.id }],
      discount: 5,
      staffId,
      taxAmount: 0,
      subtotal: 100,
      total: 85,
      tip: 0,
    } as any)
    const { version } = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, select: { version: true } })
    await addItemsToOrder(venueId, o.id, [{ productId: panId, quantity: 1 }], version)
    // 150 − (10 del artículo + 5 libres) = 135. Hoy la cabecera quedaba en 10 (el libre se perdía) y el total en 140.
    expect(await cabecera(o.id)).toEqual({ subtotal: 150, descuento: 15, total: 135, saldo: 135 })
  })
  // Revisión de T4: el `applyDiscount` heredado, con OTRA fila presente y un recálculo después.
  it('🔴 P2 antes/después: el applyDiscount heredado conserva sus $5 al agregar un artículo con otra fila presente ($20; hoy $15)', async () => {
    const orderId = await cuentaDeCafe()
    const v1 = (await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { version: true } })).version
    await applyDiscountHeredado(venueId, orderId, { type: 'FIXED_AMOUNT', value: 5, reason: 'Heredado', staffId, expectedVersion: v1 })
    await applyManualDiscount(orderId, 'PERCENTAGE', 10, '10 % cuenta', staffVenueId, undefined, undefined, venueId) // 10 % de 95
    expect(await cabecera(orderId)).toEqual({ subtotal: 100, descuento: 14.5, total: 85.5, saldo: 85.5 }) // igual que hoy
    const v2 = (await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { version: true } })).version

    await addItemsToOrder(venueId, orderId, [{ productId: panId, quantity: 1 }], v2)

    // 5 heredados + 10 % de $150 = $20. Hoy el heredado sólo vivía en la cabecera y el recálculo con filas lo borraba:
    // descuento $15 y total $135.
    expect(await cabecera(orderId)).toEqual({ subtotal: 150, descuento: 20, total: 130, saldo: 130 })
    const cafe = await renglonDe(orderId, cafeId)
    const heredada = (await filas(orderId)).find(f => f.name === 'Heredado')
    expect(Number(heredada?.amount)).toBe(5) // congelado, como «Cobrar»
    expect(heredada?.reparto).toMatchObject({ alcance: 'CUENTA', base: [cafe.id], renglones: { [cafe.id]: 500 } })
  })
})

describe('motor', () => {
  it('2×1 del catálogo: fila DIRIGIDA al artículo regalado, importe de hoy', async () => {
    const dosPorUno = await prisma.discount.create({
      data: {
        venueId,
        name: '2×1 café',
        type: 'PERCENTAGE',
        value: 100,
        scope: 'QUANTITY',
        buyQuantity: 1,
        getQuantity: 1,
        getDiscountPercent: 100,
        buyItemIds: [cafeId],
        getItemIds: [cafeId],
        applyBeforeTax: false,
        // Revisión de T5: no automático, para que ninguna otra prueba lo encuentre si ésta falla a la mitad (se aplica a mano).
        isAutomatic: false,
      },
    })
    const o = await crearEnTerminal(venueId, {
      items: [{ productId: cafeId, quantity: 2, unitPrice: 100 }],
      staffId,
      taxAmount: 0,
      subtotal: 200,
      total: 200,
      tip: 0,
    } as any)
    const { applyDiscountToOrder } = await import('@/services/dashboard/discountEngine.service')
    expect(await applyDiscountToOrder(o.id, dosPorUno.id, staffVenueId, undefined, venueId)).toMatchObject({ success: true, amount: 100 })
    const renglon = await renglonDe(o.id, cafeId)
    expect((await filas(o.id))[0].reparto).toEqual({
      v: 1,
      alcance: 'DIRIGIDO',
      conPromociones: null,
      espejo: false,
      renglones: { [renglon.id]: 10000 },
    })
    expect(await cabecera(o.id)).toEqual({ subtotal: 200, descuento: 100, total: 100, saldo: 100 })
  })

  async function categoriaAplicada() {
    const cat = await prisma.discount.create({
      data: {
        venueId,
        name: `10 % categoría ${randomUUID()}`,
        type: 'PERCENTAGE',
        value: 10,
        scope: 'CATEGORY',
        targetCategoryIds: [categoriaCafeId],
      },
    })
    const orderId = await cuentaDeCafe()
    const { applyDiscountToOrder } = await import('@/services/dashboard/discountEngine.service')
    expect(await applyDiscountToOrder(orderId, cat.id, staffVenueId, undefined, venueId)).toMatchObject({ success: true, amount: 10 })
    const { version } = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { version: true } })
    return { orderId, version }
  }

  // Rojo hoy sólo por el `reparto` (el importe ya es el de hoy): el título conserva «control — venta sana» (B2b lo filtra así).
  it('control — venta sana (Codex r2 N1): % de categoría y luego otro artículo de la MISMA categoría ⇒ igual que hoy', async () => {
    const { orderId, version } = await categoriaAplicada()
    await addItemsToOrder(venueId, orderId, [{ productId: panId, quantity: 1 }], version)
    const [fila] = await filas(orderId)
    const [cafe, pan] = [await renglonDe(orderId, cafeId), await renglonDe(orderId, panId)]
    expect(Number(fila.amount)).toBe(15) // 10 % de $150, lo mismo que hoy
    expect(fila.reparto).toEqual({
      v: 1,
      alcance: 'DIRIGIDO',
      conPromociones: null,
      espejo: false,
      ambito: { productos: [], categorias: [categoriaCafeId] },
      renglones: { [cafe.id]: 1000, [pan.id]: 500 },
    })
    expect(await cabecera(orderId)).toEqual({ subtotal: 150, descuento: 15, total: 135, saldo: 135 })
  })

  async function cuentaConTope(tope: number) {
    const pct = await prisma.discount.create({
      data: { venueId, name: `10 % tope ${randomUUID()}`, type: 'PERCENTAGE', value: 10, scope: 'ORDER', maxDiscountAmount: tope },
    })
    const orderId = await cuentaDeCafe()
    const { applyDiscountToOrder } = await import('@/services/dashboard/discountEngine.service')
    expect(await applyDiscountToOrder(orderId, pct.id, staffVenueId, undefined, venueId)).toMatchObject({ success: true, amount: 10 })
    const { version } = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { version: true } })
    await addItemsToOrder(venueId, orderId, [{ productId: panId, quantity: 1 }], version)
    return orderId
  }
  it('🔴 R6 antes/después: un 10 % de cuenta con tope de $12 no lo pasa al agregar ($12; hoy $15)', async () => {
    const orderId = await cuentaConTope(12)
    const [fila] = await filas(orderId)
    expect(Number(fila.amount)).toBe(12)
    expect(fila.reparto).toMatchObject({ alcance: 'CUENTA', tope: 12 })
    expect(await cabecera(orderId)).toEqual({ subtotal: 150, descuento: 12, total: 138, saldo: 138 })
  })
  it('control — R6, venta sana: bajo el tope ($20) el recálculo da lo mismo que hoy ($15)', async () => {
    const orderId = await cuentaConTope(20)
    expect(await cabecera(orderId)).toEqual({ subtotal: 150, descuento: 15, total: 135, saldo: 135 })
  })

  it('🔴 P1 antes/después: un artículo de OTRA categoría ya no infla el % de categoría ($10; hoy, 10 % de toda la cuenta: $20)', async () => {
    const { orderId, version } = await categoriaAplicada()
    await addItemsToOrder(venueId, orderId, [{ productId: llaveroId, quantity: 1 }], version)
    const [fila] = await filas(orderId)
    expect(Number(fila.amount)).toBe(10)
    expect(await cabecera(orderId)).toEqual({ subtotal: 200, descuento: 10, total: 190, saldo: 190 })
  })

  // Ruling de T2: `removeOrderItem` de la terminal no tenía prueba de P1 con una fila con ámbito (su include trae la categoría).
  it('🔴 P1 antes/después al QUITAR: sin el pan, el % de categoría queda en el café ($10; hoy, 10 % de café + llavero: $20)', async () => {
    const cat = await prisma.discount.create({
      data: {
        venueId,
        name: `10 % categoría ${randomUUID()}`,
        type: 'PERCENTAGE',
        value: 10,
        scope: 'CATEGORY',
        targetCategoryIds: [categoriaCafeId],
      },
    })
    const o = await crearEnTerminal(venueId, {
      items: [
        { productId: cafeId, quantity: 1, unitPrice: 100 },
        { productId: panId, quantity: 1, unitPrice: 50 },
        { productId: llaveroId, quantity: 1, unitPrice: 100 },
      ],
      staffId,
      taxAmount: 0,
      subtotal: 250,
      total: 250,
      tip: 0,
    } as any)
    const { applyDiscountToOrder } = await import('@/services/dashboard/discountEngine.service')
    expect(await applyDiscountToOrder(o.id, cat.id, staffVenueId, undefined, venueId)).toMatchObject({ success: true, amount: 15 })
    const [cafe, pan] = [await renglonDe(o.id, cafeId), await renglonDe(o.id, panId)]
    const { version } = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, select: { version: true } })

    await removeOrderItem(venueId, o.id, pan.id, version)

    const [fila] = await filas(o.id)
    expect(Number(fila.amount)).toBe(10)
    expect(fila.reparto).toEqual({
      v: 1,
      alcance: 'DIRIGIDO',
      conPromociones: null,
      espejo: false,
      ambito: { productos: [], categorias: [categoriaCafeId] },
      renglones: { [cafe.id]: 1000 },
    })
    expect(await cabecera(o.id)).toEqual({ subtotal: 200, descuento: 10, total: 190, saldo: 190 })
  })
})

describe('cupón', () => {
  // Revisión de T6 (R6): el cupón real, con tope del catálogo, y un recálculo después.
  it('🔴 R6 antes/después: el cupón de 10 % con tope de $12 no lo pasa al agregar un artículo ($12; hoy $15)', async () => {
    const pct = await prisma.discount.create({
      data: { venueId, name: `Cupón 10 % ${randomUUID()}`, type: 'PERCENTAGE', value: 10, scope: 'ORDER', maxDiscountAmount: 12 },
    })
    const codigo = `B2T9-${randomUUID()}`.toUpperCase()
    await prisma.couponCode.create({ data: { discountId: pct.id, code: codigo } })
    const orderId = await cuentaDeCafe()
    expect(await applyCouponCode(venueId, orderId, codigo, staffVenueId)).toMatchObject({ success: true, amount: 10 })
    const { version } = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { version: true } })

    await addItemsToOrder(venueId, orderId, [{ productId: panId, quantity: 1 }], version)

    const [cafe, pan] = [await renglonDe(orderId, cafeId), await renglonDe(orderId, panId)]
    const [fila] = await filas(orderId)
    expect(Number(fila.amount)).toBe(12)
    expect(fila.reparto).toEqual({
      v: 1,
      alcance: 'CUENTA',
      conPromociones: false,
      espejo: false,
      tope: 12,
      renglones: { [cafe.id]: 800, [pan.id]: 400 },
    })
    expect(await cabecera(orderId)).toEqual({ subtotal: 150, descuento: 12, total: 138, saldo: 138 })
  })
})

describe('cartilla y cupón juntos', () => {
  it('🔴 premio FREE_PRODUCT sobre el café y cupón de $10: el café recibe exactamente su precio y el cupón cae en el pan', async () => {
    const cliente = await prisma.customer.create({ data: { venueId, firstName: 'Ana' } })
    const o = await crearEnTerminal(venueId, {
      items: [
        { productId: cafeId, quantity: 1, unitPrice: 100 },
        { productId: panId, quantity: 1, unitPrice: 50 },
      ],
      staffId,
      taxAmount: 0,
      subtotal: 150,
      total: 150,
      tip: 0,
      customerId: cliente.id,
    } as any)
    const cartilla = await prisma.stampCard.create({
      data: { customerId: cliente.id, venueId, cycle: 1, stampsRequired: 5, stampsEarned: 5, completedAt: new Date() },
    })
    const premio = await prisma.stampReward.create({
      data: { stampCardId: cartilla.id, customerId: cliente.id, venueId, rewardType: 'FREE_PRODUCT', rewardLabel: 'Café gratis' },
    })
    const { redeemStampReward } = await import('@/services/wallet/redeemStampReward.service')
    await redeemStampReward(venueId, o.id, premio.id, { staffId })
    await applyManualDiscount(o.id, 'FIXED_AMOUNT', 10, 'Diez', staffVenueId, undefined, undefined, venueId)
    const [cafe, pan] = [await renglonDe(o.id, cafeId), await renglonDe(o.id, panId)]
    const [filaPremio, filaDiez] = await filas(o.id)
    expect(filaPremio.reparto).toEqual({ v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: false, renglones: { [cafe.id]: 10000 } })
    expect(filaDiez.reparto).toEqual({ v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones: { [pan.id]: 1000 } })
    expect(await cabecera(o.id)).toMatchObject({ descuento: 110, total: 40 })
  })
})

describe('quitar un descuento (R3-2, P3)', () => {
  it('quitar un descuento de artículo deja el renglón sin descuento y la cuenta cobra completo (móvil)', async () => {
    const diez = await prisma.discount.create({ data: { venueId, name: '10 % quitar', type: 'PERCENTAGE', value: 10, scope: 'ITEM' } })
    const creada = await crearEnMovil(venueId, {
      staffId,
      items: [{ productId: cafeId, quantity: 1, discountId: diez.id }],
      source: 'AVOQADO_ANDROID',
    } as any)
    const [espejo] = await filas(creada.id)
    await removeOrderDiscount(venueId, creada.id, espejo.id, staffId) // revertirDescuentoDelRenglon
    const renglon = await renglonDe(creada.id, cafeId)
    expect(Number(renglon.discountAmount)).toBe(0)
    expect(renglon.appliedDiscountId).toBeNull()
    expect(await filas(creada.id)).toEqual([])
    expect(await cabecera(creada.id)).toMatchObject({ subtotal: 100, descuento: 0, total: 100 })
  })
  it('quitar desde la terminal el espejo de un artículo re-reparte el % de cuenta y sube el total exacto', async () => {
    const diez = await prisma.discount.create({ data: { venueId, name: '10 % café T', type: 'PERCENTAGE', value: 10, scope: 'ITEM' } })
    const o = await crearEnTerminal(venueId, {
      items: [
        { productId: cafeId, quantity: 1, unitPrice: 100, itemDiscountId: diez.id },
        { productId: panId, quantity: 1, unitPrice: 50 },
      ],
      staffId,
      taxAmount: 0,
      subtotal: 150,
      total: 140,
      tip: 0,
    } as any)
    await applyManualDiscount(o.id, 'PERCENTAGE', 10, '10 % cuenta', staffVenueId, undefined, undefined, venueId) // 10 % de 140 = 14
    const [cafe, pan] = [await renglonDe(o.id, cafeId), await renglonDe(o.id, panId)]
    const cuentaAntes = (await filas(o.id)).find(f => f.discountId === null)!
    expect(cuentaAntes.reparto).toMatchObject({ renglones: { [cafe.id]: 900, [pan.id]: 500 } })
    const espejo = (await filas(o.id)).find(f => f.discountId === diez.id)!
    await removeDiscountFromOrder(o.id, espejo.id, staffId, venueId) // sincronizarRepartos
    expect(Number((await renglonDe(o.id, cafeId)).discountAmount)).toBe(0)
    const [cuenta] = await filas(o.id)
    expect(Number(cuenta.amount)).toBe(14) // el motor no recalcula al quitar: importe de hoy
    expect(cuenta.reparto).toMatchObject({ renglones: { [cafe.id]: 933, [pan.id]: 467 } }) // Codex r1 #8: el mapa viejo también sumaba 14
    expect(await cabecera(o.id)).toMatchObject({ subtotal: 150, descuento: 14, total: 136 })
  })
  it('🔴 P3: quitar desde la terminal un canje de puntos devuelve los puntos', async () => {
    await prisma.loyaltyConfig.create({ data: { venueId, active: true, redemptionRate: 0.01, minPointsRedeem: 100 } })
    const cliente = await prisma.customer.create({ data: { venueId, firstName: 'Puntos', loyaltyPoints: 5000 } })
    const orderId = await cuentaDeCafe({ customerId: cliente.id })
    const { redeemPointsToOrder } = await import('@/services/mobile/loyalty.mobile.service')
    await redeemPointsToOrder(venueId, orderId, cliente.id, 1000, staffId)
    const [canje] = await filas(orderId)
    await removeDiscountFromOrder(orderId, canje.id, staffId, venueId)
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: cliente.id } })).loyaltyPoints).toBe(5000)
    expect(await filas(orderId)).toEqual([])
    expect(await cabecera(orderId)).toMatchObject({ descuento: 0, total: 100 })
  })
})

// Revisión final de B2 (Codex r1): la cabecera puede traer descuento que no está en ninguna fila (orden anterior a B2,
// `applyDiscount` sin renglones, delivery o POS). La primera fila nueva no puede borrarlo: `conservarDescuentoHistorico` lo
// congela en su propia fila, sin reparto (D8), antes de crearla.
describe('descuento histórico de cabecera (Codex r1 P1) y applyDiscount sin renglones (P2)', () => {
  it('🔴 P1 antes/después: $20 HISTÓRICOS de cabecera sobreviven al applyDiscount heredado y a agregar un artículo ($30/$120; B2 $10/$140)', async () => {
    const orderId = await cuentaDeCafe()
    // La orden de antes de B2: $20 sólo en la cabecera, sin fila.
    await prisma.order.update({ where: { id: orderId }, data: { discountAmount: 20, total: 80, remainingBalance: 80 } })

    await applyDiscountHeredado(venueId, orderId, {
      type: 'FIXED_AMOUNT',
      value: 10,
      reason: 'Heredado',
      staffId,
      expectedVersion: await version(orderId),
    })
    expect(await cabecera(orderId)).toEqual({ subtotal: 100, descuento: 30, total: 70, saldo: 70 })
    await addItemsToOrder(venueId, orderId, [{ productId: panId, quantity: 1 }], await version(orderId))

    // Hoy (develop) la cabecera sin filas se conservaba: $30 y $120. Con B2 la fila nueva apagaba ese respaldo: $10 y $140.
    expect(await cabecera(orderId)).toEqual({ subtotal: 150, descuento: 30, total: 120, saldo: 120 })
    const historica = (await filas(orderId)).find(f => f.name === 'Descuento anterior')
    expect(historica).toMatchObject({ type: 'FIXED_AMOUNT', isManual: true, reparto: null, discountId: null })
    expect(Number(historica?.amount)).toBe(20) // D8: congelado, nunca se re-deriva
  })

  it('🔴 P1 antes/después: con una fila y $20 de cabecera que no están en ella, el móvil conserva los $20 al aplicar otro descuento ($35; B2 $15)', async () => {
    const orderId = await cuentaDeCafe()
    await applyManualDiscount(orderId, 'FIXED_AMOUNT', 10, '$10 cuenta', staffVenueId, undefined, undefined, venueId)
    await prisma.order.update({ where: { id: orderId }, data: { discountAmount: 30, total: 70, remainingBalance: 70 } })
    const cinco = await prisma.discount.create({
      data: { venueId, name: `$5 ${randomUUID()}`, type: 'FIXED_AMOUNT', value: 5, scope: 'ORDER' },
    })

    await applyOrderDiscount(venueId, orderId, cinco.id, staffId) // recalcula: cabecera = Σ filas

    expect(await cabecera(orderId)).toEqual({ subtotal: 100, descuento: 35, total: 65, saldo: 65 })
    expect((await filas(orderId)).map(f => [f.name, Number(f.amount)])).toEqual([
      ['$10 cuenta', 10],
      ['Descuento anterior', 20],
      [cinco.name, 5],
    ])
  })

  it('control — una orden sana (cabecera = Σ filas) no gana fila de descuento anterior', async () => {
    const orderId = await cuentaDeCafe()
    await applyManualDiscount(orderId, 'FIXED_AMOUNT', 10, '$10 cuenta', staffVenueId, undefined, undefined, venueId)
    await applyDiscountHeredado(venueId, orderId, {
      type: 'FIXED_AMOUNT',
      value: 5,
      reason: 'Heredado',
      staffId,
      expectedVersion: await version(orderId),
    })
    expect((await filas(orderId)).map(f => f.name)).toEqual(['$10 cuenta', 'Heredado'])
    expect(await cabecera(orderId)).toEqual({ subtotal: 100, descuento: 15, total: 85, saldo: 85 })
  })

  it('🔴 P2 antes/después: applyDiscount sobre una cuenta SIN renglones conserva sus $10 al llegar el primero (total $40; B2 $45)', async () => {
    const orderId = await cuentaDeCafe()
    // Cuenta de $100 sin renglones (forma heredada): el applyDiscount no tiene destinos.
    await prisma.orderItem.deleteMany({ where: { orderId } })

    await applyDiscountHeredado(venueId, orderId, {
      type: 'PERCENTAGE',
      value: 10,
      reason: 'Sin renglones',
      staffId,
      expectedVersion: await version(orderId),
    })
    expect(await cabecera(orderId)).toEqual({ subtotal: 100, descuento: 10, total: 90, saldo: 90 })
    await addItemsToOrder(venueId, orderId, [{ productId: panId, quantity: 1 }], await version(orderId))

    // Hoy la cabecera sin filas se conserva ($10, total $40). B2 guardaba un % de cuenta sin destinos y lo re-derivaba: $5.
    expect(await cabecera(orderId)).toEqual({ subtotal: 50, descuento: 10, total: 40, saldo: 40 })
    expect(await filas(orderId)).toEqual([]) // sin destinos, sólo la cabecera (como hoy)
  })
})

describe('P12: anular TODO no revive el IVA como deuda (Codex r3 V5)', () => {
  async function ivaAparteSinDescuentos() {
    const o = await crearEnTerminal(venueId, {
      items: [{ productId: cafeId, quantity: 1, unitPrice: 100 }],
      staffId,
      taxAmount: 0,
      subtotal: 100,
      total: 100,
      tip: 0,
    } as any)
    await prisma.orderItem.updateMany({ where: { orderId: o.id }, data: { taxAmount: 16 } })
    await prisma.order.update({
      where: { id: o.id },
      data: { contratoDePrecio: 'IVA_APARTE', taxAmount: 16, total: 116, remainingBalance: 116 },
    })
    return o.id
  }
  const pagado = async (orderId: string) =>
    (await prisma.payment.findMany({ where: { orderId }, select: { amount: true }, take: 10 })).reduce((s, p) => s + Number(p.amount), 0)

  it('🔴 V5: anular todos los artículos deja impuesto cobrable 0 — saldo reconstruido 0 y un cobro de $16 no registra $16', async () => {
    const orderId = await ivaAparteSinDescuentos()
    const cafe = await renglonDe(orderId, cafeId)
    const { version } = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { version: true } })
    await voidItems(venueId, orderId, { itemIds: [cafe.id], reason: 'Error de captura', staffId, expectedVersion: version })

    const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(o.status).toBe('CANCELLED')
    expect([Number(o.subtotal), Number(o.total), Number(o.taxAmount), Number(o.remainingBalance)]).toEqual([0, 0, 0, 0])
    // Lo que de verdad se cobra se reconstruye con `computeOrderBalance` (con el estado CANCELADA, que no debe IVA): con P12 y
    // sin este arreglo daba $16 pendientes sobre una cuenta cancelada.
    expect(Number(computeOrderBalance(o, []).remainingBalance)).toBe(0)
    // El intento de cobro EN VIVO: desde la Tarea 6a el cobro móvil SÍ lee el estado, y un efectivo en vivo sobre una cancelada
    // se rechaza (founder 3-oct) antes de escribir nada. Sin el arreglo de V5 registraba un Payment de $16.
    await expect(payCashOrder(venueId, orderId, { amount: 1600, tip: 0, staffId, idempotencyKey: `v5-${orderId}` })).rejects.toMatchObject({
      code: 'ORDER_CANCELLED_NO_NEW_CHARGE',
    })
    expect(await pagado(orderId)).toBe(0)
  })

  it('🔴 control de V5 (y P12 en el cobro móvil): la venta ACTIVA $100 + $16 sigue debiendo $16 después de cobrar $100 (hoy quedaba PAGADA)', async () => {
    const orderId = await ivaAparteSinDescuentos()
    await payCashOrder(venueId, orderId, { amount: 10000, tip: 0, staffId, idempotencyKey: `v5c-${orderId}` })
    const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(o.paymentStatus).toBe('PARTIAL')
    expect(Number(o.remainingBalance)).toBe(16)
    expect(await pagado(orderId)).toBe(100)
  })

  it.each(['motor', 'móvil'] as const)(
    '🔴 Codex r5 — V5 con una reducción heredada: anular TODO la cierra; quitar después el descuento por el %s no revive IVA y un cobro de $1.60 registra $0 (la v5: $1.60)',
    async camino => {
      // Nativa DESCONOCIDO sin IVA propio, con un descuento de $10 del motor de ANTES de D16: restó 1.60 inventado (cabecera −1.60).
      const o = await crearEnTerminal(venueId, {
        items: [{ productId: cafeId, quantity: 1, unitPrice: 100 }],
        staffId,
        taxAmount: 0,
        subtotal: 100,
        total: 100,
        tip: 0,
      } as any)
      const vieja = await prisma.orderDiscount.create({
        data: { orderId: o.id, name: 'Viejo 16 %', type: 'FIXED_AMOUNT', value: 10, amount: 10, taxReduction: 1.6, isManual: true },
      }) // reparto nulo: anterior a B2
      await prisma.order.update({
        where: { id: o.id },
        data: { contratoDePrecio: 'DESCONOCIDO', taxAmount: -1.6, discountAmount: 10, total: 90, remainingBalance: 90 },
      })
      const cafe = await renglonDe(o.id, cafeId)
      const { version } = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, select: { version: true } })
      await voidItems(venueId, o.id, { itemIds: [cafe.id], reason: 'Error de captura', staffId, expectedVersion: version })
      expect(Number((await prisma.orderDiscount.findUniqueOrThrow({ where: { id: vieja.id } })).taxReduction)).toBe(0) // se cerró con la cuenta

      if (camino === 'motor') await removeDiscountFromOrder(o.id, vieja.id, staffId, venueId)
      else await removeOrderDiscount(venueId, o.id, vieja.id, staffId)
      const escrita = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
      expect([escrita.status, Number(escrita.taxAmount)]).toEqual(['CANCELLED', 0]) // la v5: 1.60 (lo devolvía la fila)
      expect(Number(computeOrderBalance(escrita, []).remainingBalance)).toBe(0)
      // R-5: el efectivo en vivo sobre la cancelada se rechaza (Tarea 6a); se afirma ESE rechazo, no cualquier error.
      await expect(
        payCashOrder(venueId, o.id, { amount: 160, tip: 0, staffId, idempotencyKey: `v5h-${camino}-${o.id}` }),
      ).rejects.toMatchObject({
        code: 'ORDER_CANCELLED_NO_NEW_CHARGE',
      })
      expect(await pagado(o.id)).toBe(0)
    },
  )

  // (La cancelada VIEJA y la cancelada con un cobro con tarjeta ya capturado viven desde la v10 en la Tarea 6a: cobrar una
  // cancelada es la regla del founder del 3-oct.)

  it('control — Codex r6 #3: sobre un origen fusionado VIEJO (CANCELLED, subtotal 0, IVA 16) un descuento móvil aplicado y quitado deja total, saldo guardado y saldo reconstruido en 0 (la v6 guardaba $16 y $16 contra $0)', async () => {
    const o = await crearEnTerminal(venueId, {
      items: [{ productId: cafeId, quantity: 1, unitPrice: 100 }],
      staffId,
      taxAmount: 0,
      subtotal: 100,
      total: 100,
      tip: 0,
    } as any)
    await prisma.orderItem.deleteMany({ where: { orderId: o.id } })
    await prisma.order.update({
      where: { id: o.id },
      data: {
        status: 'CANCELLED',
        contratoDePrecio: 'IVA_APARTE',
        subtotal: 0,
        discountAmount: 0,
        total: 0,
        remainingBalance: 0,
        taxAmount: 16,
      },
    })
    const diez = await prisma.discount.create({
      data: { venueId, name: `10 % fusión vieja ${o.id}`, type: 'PERCENTAGE', value: 10, scope: 'ORDER' },
    })
    const numeros = async () => {
      const x = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
      return {
        total: Number(x.total),
        saldo: Number(x.remainingBalance),
        reconstruido: Number(computeOrderBalance(x, []).remainingBalance),
      }
    }
    // `applyOrderDiscount` sólo rechaza PAID/PARTIAL (`order.mobile.service.ts:1454-1458`): topa el descuento a $0, crea la fila y recalcula.
    const { orderDiscountId } = await applyOrderDiscount(venueId, o.id, diez.id, staffId)
    expect(await numeros()).toEqual({ total: 0, saldo: 0, reconstruido: 0 })
    await removeOrderDiscount(venueId, o.id, orderDiscountId, staffId)
    expect(await numeros()).toEqual({ total: 0, saldo: 0, reconstruido: 0 })
  })
})

describe('P12: el descuento heredado de la terminal guarda su total con el IVA que movió la sincronización (Codex r4 R4-2)', () => {
  it('🔴 R4-2: café $100 + IVA $16, llavero $100 exento y $10 de cuenta (5/5, IVA 15.20); $100 heredados sobre el café mandan los $10 al llavero y devuelven 0.80 ⇒ total y saldo $106 = el saldo reconstruido (la v4: $105.20)', async () => {
    const o = await crearEnTerminal(venueId, {
      items: [
        { productId: cafeId, quantity: 1, unitPrice: 100 },
        { productId: llaveroId, quantity: 1, unitPrice: 100 },
      ],
      staffId,
      taxAmount: 0,
      subtotal: 200,
      total: 200,
      tip: 0,
    } as any)
    await prisma.orderItem.updateMany({ where: { orderId: o.id, productId: cafeId }, data: { taxAmount: 16 } })
    await prisma.order.update({
      where: { id: o.id },
      data: { contratoDePrecio: 'IVA_APARTE', taxAmount: 16, total: 216, remainingBalance: 216 },
    })
    const diez = await prisma.discount.create({
      data: { venueId, name: `$10 R4-2 ${o.id}`, type: 'FIXED_AMOUNT', value: 10, scope: 'ORDER', applyBeforeTax: true },
    })
    const { applyDiscountToOrder } = await import('@/services/dashboard/discountEngine.service')
    expect(await applyDiscountToOrder(o.id, diez.id, staffVenueId, undefined, venueId)).toMatchObject({ success: true, amount: 10 })
    const antes = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect([Number(antes.taxAmount), Number(antes.total)]).toEqual([15.2, 205.2]) // 10 repartidos 5/5: reducción 5 × 16/100

    const cafe = await renglonDe(o.id, cafeId)
    await applyDiscountHeredado(venueId, o.id, {
      type: 'FIXED_AMOUNT',
      value: 100,
      itemIds: [cafe.id],
      reason: 'Heredado R4-2',
      staffId,
      expectedVersion: antes.version,
    })
    // La dirigida de $100 toma toda la capacidad del café: la sincronización manda los $10 de cuenta al llavero y su reducción
    // 0.80 → 0 regresa a la cabecera en ESTA transacción.
    const cuenta = (await filas(o.id)).find(f => f.discountId === diez.id)!
    expect(Number(cuenta.taxReduction)).toBe(0)
    expect(cuenta.reparto).toMatchObject({ renglones: { [(await renglonDe(o.id, llaveroId)).id]: 1000 } })
    const despues = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(Number(despues.taxAmount)).toBe(16)
    expect([Number(despues.total), Number(despues.remainingBalance)]).toEqual([106, 106]) // 200 − 110 + 16; la v4 guardaba 105.20
    expect(Number(computeOrderBalance(despues, []).total)).toBe(Number(despues.total)) // lo que de verdad se cobra
  })
})

describe('Founder 3-oct: cobrar una cuenta CANCELADA — el efectivo en vivo se rechaza; lo ya capturado reabre una cuenta de Avoqado (Tarea 6a; Codex r9 #1-#3, r10 #2)', () => {
  /** Cancelada de $100 + IVA escrito: la forma de las 19 de producción (IVA ≠ 0, sin cobros). Cuenta de Avoqado (default de la columna). */
  async function cancelada(contratoDePrecio: 'IVA_APARTE' | 'DESCONOCIDO', iva = 16) {
    const o = await crearEnTerminal(venueId, {
      items: [{ productId: cafeId, quantity: 1, unitPrice: 100 }],
      staffId,
      taxAmount: 0,
      subtotal: 100,
      total: 100,
      tip: 0,
    } as any)
    await prisma.orderItem.updateMany({ where: { orderId: o.id }, data: { taxAmount: iva } })
    await prisma.order.update({
      where: { id: o.id },
      data: { status: 'CANCELLED', contratoDePrecio, taxAmount: iva, total: 100 + iva, remainingBalance: 100 + iva },
    })
    return o.id
  }
  const foto = async (orderId: string) => {
    const x = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    const pagos = await prisma.payment.findMany({
      where: { orderId, status: 'COMPLETED' },
      select: { amount: true, tipAmount: true },
      take: 10,
    })
    return {
      status: x.status,
      paymentStatus: x.paymentStatus,
      iva: Number(x.taxAmount),
      total: Number(x.total),
      saldo: Number(x.remainingBalance),
      reconstruido: Number(computeOrderBalance(x, pagos).remainingBalance),
      cobrado: pagos.reduce((s, p) => s + Number(p.amount), 0),
      reaperturas: await prisma.activityLog.count({ where: { entityId: orderId, action: 'ORDER_REOPENED_BY_CAPTURED_PAYMENT' } }),
      // El filtro que comparten los tres lectores (`bankReconciliation.service.ts:190`, `accounting.dashboard.service.ts:145`, `autoPosting.service.ts:237`).
      visible: await prisma.payment.count({ where: { orderId, status: 'COMPLETED', order: { status: { not: 'CANCELLED' } } } }),
    }
  }

  it('🔴 r9 #1: un EFECTIVO en vivo de $116 sobre la cancelada IVA_APARTE se rechaza y no registra nada (la v9: $100 registrados, $16 de cambio, CANCELADA y PAGADA fuera de los lectores)', async () => {
    const orderId = await cancelada('IVA_APARTE')
    await expect(
      payCashOrder(venueId, orderId, { amount: 11600, tip: 0, staffId, idempotencyKey: `vivo-${orderId}` }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'ORDER_CANCELLED_NO_NEW_CHARGE',
      message: 'Esta cuenta está cancelada, abre una nueva.',
    })
    expect(await foto(orderId)).toMatchObject({ status: 'CANCELLED', paymentStatus: 'PENDING', cobrado: 0, reaperturas: 0 })
  })

  it.each(['CREDIT_CARD', 'BANK_TRANSFER'] as const)(
    '🔴 r10 #2: %s registrada EN VIVO sobre la cancelada IVA_APARTE (ya cobrada por fuera) se conserva y la reabre: COMPLETED en $116 con su IVA, una bitácora, visible (la v10: 400)',
    async method => {
      const orderId = await cancelada('IVA_APARTE')
      await payCashOrder(venueId, orderId, {
        amount: 11600,
        tip: 0,
        staffId,
        method,
        externalSource: 'Terminal BBVA',
        idempotencyKey: `ext-${orderId}`,
      })
      expect(await foto(orderId)).toEqual({
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        iva: 16,
        total: 116,
        saldo: 0,
        reconstruido: 0,
        cobrado: 116,
        reaperturas: 1,
        visible: 1,
      })
    },
  )

  it.each([
    ['IVA_APARTE', 11600, { status: 'COMPLETED', paymentStatus: 'PAID', iva: 16, total: 116, saldo: 0, reconstruido: 0, cobrado: 116 }],
    ['IVA_APARTE', 10000, { status: 'PENDING', paymentStatus: 'PARTIAL', iva: 16, total: 116, saldo: 16, reconstruido: 16, cobrado: 100 }],
    ['DESCONOCIDO', 11600, { status: 'COMPLETED', paymentStatus: 'PAID', iva: 16, total: 116, saldo: 0, reconstruido: 0, cobrado: 116 }],
  ] as const)(
    '🔴 r9 #1-#3: el efectivo de la COLA (%s, %s centavos) nunca se rechaza: reabre la cuenta con su IVA, deja una bitácora y queda visible',
    async (contratoDePrecio, centavos, esperado) => {
      const orderId = await cancelada(contratoDePrecio)
      await payCashOrder(venueId, orderId, { amount: centavos, tip: 0, staffId, idempotencyKey: `cola-${orderId}`, isOfflineReplay: true })
      expect(await foto(orderId)).toEqual({ ...esperado, reaperturas: 1, visible: 1 })
    },
  )

  it.each([
    [
      10000,
      {
        status: 'PENDING',
        paymentStatus: 'PARTIAL',
        iva: 16,
        total: 116,
        saldo: 16,
        reconstruido: 16,
        cobrado: 100,
        reaperturas: 1,
        visible: 1,
      },
    ],
    [
      11599,
      {
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        iva: 16,
        total: 116,
        saldo: 0.01,
        reconstruido: 0.01,
        cobrado: 115.99,
        reaperturas: 1,
        visible: 1,
      },
    ],
    [
      11600,
      {
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        iva: 16,
        total: 116,
        saldo: 0,
        reconstruido: 0,
        cobrado: 116,
        reaperturas: 1,
        visible: 1,
      },
    ],
    [
      5000,
      {
        status: 'CANCELLED',
        paymentStatus: 'PARTIAL',
        iva: 16,
        total: 100,
        saldo: 50,
        reconstruido: 50,
        cobrado: 50,
        reaperturas: 0,
        visible: 0,
      },
    ], // control: lo de hoy
  ] as const)(
    '🔴 Codex r13 #1: una IMPORTADA de SoftRestaurant ($100 + $16) que SoftRestaurant canceló recibe por la cola %s centavos ⇒ se calcula y se guarda con su estado FINAL; saldo guardado = reconstruido (la v13: COMPLETED y PAGADA en $100 con $16 reconstruidos)',
    async (centavos, esperado) => {
      const o = await prisma.order.create({
        data: {
          venueId,
          orderNumber: randomUUID(),
          originSystem: 'POS_SOFTRESTAURANT',
          source: 'POS',
          externalId: `sr-${randomUUID()}`,
          status: 'CANCELLED',
          contratoDePrecio: 'DESCONOCIDO',
          subtotal: 100,
          taxAmount: 16,
          total: 116,
          remainingBalance: 116,
          items: { create: { productName: 'Plato', quantity: 1, unitPrice: 100, taxAmount: 16, total: 100 } },
        },
      })
      await payCashOrder(venueId, o.id, { amount: centavos, tip: 0, staffId, idempotencyKey: `imp-${o.id}`, isOfflineReplay: true })
      expect(await foto(o.id)).toEqual(esperado)
    },
  )

  it.each(['IVA_APARTE', 'DESCONOCIDO'] as const)(
    '🔴 r5 #3 + r7 #1: una cancelada VIEJA %s con IVA 16 (el origen de una fusión de antes del bloque: subtotal y total 0) rechaza el efectivo en vivo y, sin dinero, la reconciliación ni la reabre ni la cierra: total, saldo y saldo reconstruido en 0, su IVA y su contrato intactos',
    async contratoDePrecio => {
      const o = await crearEnTerminal(venueId, {
        items: [{ productId: cafeId, quantity: 1, unitPrice: 100 }],
        staffId,
        taxAmount: 0,
        subtotal: 100,
        total: 100,
        tip: 0,
      } as any)
      // Como la dejaba `mergeOrders` antes del bloque (`order.mobile.service.ts:2022-2033`): renglones movidos, CANCELADA, `paymentStatus` intacto.
      await prisma.orderItem.deleteMany({ where: { orderId: o.id } })
      await prisma.order.update({
        where: { id: o.id },
        data: { status: 'CANCELLED', contratoDePrecio, subtotal: 0, discountAmount: 0, total: 0, remainingBalance: 0, taxAmount: 16 },
      })
      await expect(payCashOrder(venueId, o.id, { amount: 1600, tip: 0, staffId, idempotencyKey: `fus-${o.id}` })).rejects.toMatchObject({
        code: 'ORDER_CANCELLED_NO_NEW_CHARGE',
      })
      await reconcileOrderFromPayments(o.id) // el mismo cierre de la terminal y del barrido
      expect(await foto(o.id)).toMatchObject({
        status: 'CANCELLED',
        iva: 16,
        total: 0,
        saldo: 0,
        reconstruido: 0,
        cobrado: 0,
        reaperturas: 0,
      })
      expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).contratoDePrecio).toBe(contratoDePrecio)
    },
  )

  it.each([
    ['con IVA 0', 0, { status: 'COMPLETED', paymentStatus: 'PAID', total: 100, saldo: 0 }],
    ['con IVA 16 escrito (como las 19 de producción)', 16, { status: 'PENDING', paymentStatus: 'PARTIAL', total: 116, saldo: 16 }],
  ] as const)(
    '🔴 Founder 3-oct + r8 #1: una cancelada nativa DESCONOCIDO de $100 %s con un cobro con tarjeta de $100 YA capturado: la reconciliación la reabre con su IVA; el pago aparece en depósitos, resultados y pólizas y su saldo guardado = reconstruido',
    async (_caso, iva, esperado) => {
      const order = await prisma.order.create({
        data: {
          venueId,
          orderNumber: randomUUID(),
          status: 'CANCELLED',
          contratoDePrecio: 'DESCONOCIDO',
          subtotal: 100,
          taxAmount: iva,
          total: 100,
          remainingBalance: 100,
          items: { create: { productName: 'Plato', quantity: 1, unitPrice: 100, taxAmount: iva, total: 100 } },
          payments: {
            create: { venueId, amount: 100, feePercentage: 0.03, feeAmount: 3, netAmount: 97, method: 'CREDIT_CARD', status: 'COMPLETED' },
          },
        },
      })
      const dia = (dias: number) => new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10)
      const [desde, hasta] = [dia(-1), dia(1)]
      const depositos = async () =>
        (await loadDepositCandidates(venueId, desde, hasta, 'America/Mexico_City', 0)).reduce((s, c) => s + c.netCents, 0)
      const ventas = async () => (await getIncomeStatement(venueId, { from: desde, to: hasta })).revenue.grossSalesCents
      const [depositosAntes, ventasAntes] = [await depositos(), await ventas()]
      expect((await foto(order.id)).visible).toBe(0)

      await reconcileOrderFromPayments(order.id) // el cierre de :1821; el de la terminal (:1364) lo prueba la unitaria
      expect(await foto(order.id)).toMatchObject({ ...esperado, iva, reconstruido: esperado.saldo, reaperturas: 1, visible: 1 })
      expect((await depositos()) - depositosAntes).toBe(9700)
      expect((await ventas()) - ventasAntes).toBe(10000)
    },
  )
})

describe('R9: borrar o anular renglones se lleva su IVA de la cabecera (Codex r4 R4-1)', () => {
  it.each(['borrar', 'anular'] as const)(
    '🔴 R9 caso 1 por %s: café $100 + IVA 16 y pan $50 + IVA 8; quitar el café deja IVA 8 y se cobran $58 (la v4: 24 y $74)',
    async camino => {
      const { orderId, cafe } = await cafeYPanConIvaAparte()
      await quitar(camino, orderId, cafe.id)
      expect(await cabecera(orderId)).toMatchObject({ subtotal: 50, descuento: 0 })
      expect(await cobroTras(orderId, 74)).toEqual({ impuesto: 8, total: 58, saldo: 58, reconstruido: 58, cobrado: 58 })
    },
  )

  it('🔴 R9: borrar el ÚLTIMO artículo de una cuenta con IVA aparte deja el impuesto en 0 (la v4: $24 por cobrar sobre una cuenta sin artículos)', async () => {
    const { orderId, cafe, pan } = await cafeYPanConIvaAparte()
    await quitar('borrar', orderId, pan.id)
    await quitar('borrar', orderId, cafe.id) // retirarImpuestoDeRenglones: 24 → 16 → 0
    expect(await cobroTras(orderId, 24)).toEqual({ impuesto: 0, total: 0, saldo: 0, reconstruido: 0, cobrado: 0 })
  })
  // Anular el último artículo ES anular todo: lo fija «V5» de la Tarea 6 (control, verde desde V5).

  it('🔴 R9 con un 10 % de cuenta del motor previo (D16): quitar el café re-deriva $15 → $5 y su reducción 2.40 → 0.80 en la misma transacción; IVA 7.20 y se cobran $52.20 (la v4: 23.20 y $68.20)', async () => {
    const { orderId, cafe } = await cafeYPanConIvaAparte()
    const diez = await prisma.discount.create({
      data: { venueId, name: `10 % D16 R9 ${orderId}`, type: 'PERCENTAGE', value: 10, scope: 'ORDER', applyBeforeTax: true },
    })
    const { applyDiscountToOrder } = await import('@/services/dashboard/discountEngine.service')
    expect(await applyDiscountToOrder(orderId, diez.id, staffVenueId, undefined, venueId)).toMatchObject({ success: true, amount: 15 })
    let [fila] = await filas(orderId)
    expect(Number(fila.taxReduction)).toBe(2.4) // 10 × 16/100 + 5 × 8/50
    expect(Number((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).taxAmount)).toBe(21.6)

    await quitar('borrar', orderId, cafe.id) // 21.60 − 16 (R9, primero) = 5.60; la sincronización devuelve 2.40 − 0.80 ⇒ 7.20
    ;[fila] = await filas(orderId)
    expect([Number(fila.amount), Number(fila.taxReduction)]).toEqual([5, 0.8])
    expect(await cabecera(orderId)).toMatchObject({ subtotal: 50, descuento: 5 })
    expect(await cobroTras(orderId, 68.2)).toEqual({ impuesto: 7.2, total: 52.2, saldo: 52.2, reconstruido: 52.2, cobrado: 52.2 })
  })
  // El mismo caso por ANULAR (P13) y el caso 2 de Codex se prueban en el describe «B2c: renglones que cambian debajo de un
  // descuento (P4, P5)».

  it('🔴 R9 respeta la cabecera con autoridad (no es la suma de sus renglones): IVA 20 con renglones de 16 + 8; quitar el café deja 4, no 8 (la v4: 20 y $70)', async () => {
    const { orderId, cafe } = await cafeYPanConIvaAparte(8, 20)
    await quitar('borrar', orderId, cafe.id)
    expect(await cobroTras(orderId, 70)).toEqual({ impuesto: 4, total: 54, saldo: 54, reconstruido: 54, cobrado: 54 })
  })

  it('🔴 R9 nunca deja la cabecera bajo cero: IVA 12 con renglones de 16 + 8; quitar el café deja 0, no −4 (la v4: 12 y $62)', async () => {
    const { orderId, cafe } = await cafeYPanConIvaAparte(8, 12)
    await quitar('borrar', orderId, cafe.id)
    expect(await cobroTras(orderId, 62)).toEqual({ impuesto: 0, total: 50, saldo: 50, reconstruido: 50, cobrado: 50 })
  })

  /** El contraejemplo de Codex r5: café con IVA 16 y pan exento; un descuento de cuenta de $20 del motor de ANTES de D16, que
   *  restó 3.20 con el 16 % inventado y no lleva la marca. Cabecera 12.80, total 142.80. */
  async function conDescuentoViejo() {
    const { orderId, cafe } = await cafeYPanConIvaAparte(0, 12.8)
    const vieja = await prisma.orderDiscount.create({
      data: { orderId, name: 'Viejo 16 %', type: 'FIXED_AMOUNT', value: 20, amount: 20, taxReduction: 3.2, isManual: true },
    }) // reparto nulo: anterior a B2
    await prisma.order.update({ where: { id: orderId }, data: { discountAmount: 20, total: 142.8, remainingBalance: 142.8 } })
    return { orderId, cafe, vieja }
  }
  const foto = async (orderId: string) => {
    const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true, orderDiscounts: true } })
    return {
      impuesto: Number(o.taxAmount),
      total: Number(o.total),
      renglones: o.items.length,
      reducciones: o.orderDiscounts.map(d => Number(d.taxReduction)),
    }
  }

  it.each(['borrar', 'anular'] as const)(
    '🔴 Codex r5 #1 — R9 con una reducción heredada por %s: se rechaza con la causa y nada se mueve (la v5: cabecera −3.20)',
    async camino => {
      const { orderId, cafe } = await conDescuentoViejo()
      await expect(quitar(camino, orderId, cafe.id)).rejects.toMatchObject({ code: 'DESCUENTO_CON_IVA_ANTERIOR' })
      expect(await foto(orderId)).toEqual({ impuesto: 12.8, total: 142.8, renglones: 2, reducciones: [3.2] })
    },
  )

  it('🔴 Codex r5 #1 — el camino que indica el mensaje: quitar primero el descuento viejo (vuelven 3.20 ⇒ 16) y luego el café ⇒ IVA 0 y se cobran $50', async () => {
    const { orderId, cafe, vieja } = await conDescuentoViejo()
    await removeDiscountFromOrder(orderId, vieja.id, staffId, venueId)
    expect(Number((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).taxAmount)).toBe(16)
    await quitar('borrar', orderId, cafe.id)
    expect(await cobroTras(orderId, 66)).toEqual({ impuesto: 0, total: 50, saldo: 50, reconstruido: 50, cobrado: 50 })
  })

  it('control — Codex r5 #1: una venta nativa con un descuento viejo (renglones sin IVA, cabecera −1.60) sigue borrando como hoy', async () => {
    const o = await crearEnTerminal(venueId, {
      items: [
        { productId: cafeId, quantity: 1, unitPrice: 100 },
        { productId: panId, quantity: 1, unitPrice: 50 },
      ],
      staffId,
      taxAmount: 0,
      subtotal: 150,
      total: 150,
      tip: 0,
    } as any)
    await prisma.orderDiscount.create({
      data: { orderId: o.id, name: 'Viejo 16 %', type: 'FIXED_AMOUNT', value: 10, amount: 10, taxReduction: 1.6, isManual: true },
    })
    await prisma.order.update({ where: { id: o.id }, data: { taxAmount: -1.6, discountAmount: 10, total: 140, remainingBalance: 140 } })
    await quitar('borrar', o.id, (await renglonDe(o.id, cafeId)).id)
    expect(await foto(o.id)).toEqual({ impuesto: -1.6, total: 40, renglones: 1, reducciones: [1.6] }) // como hoy: R9 no actúa sin IVA que salga
  })

  it.each(['borrar', 'anular'] as const)(
    'control — venta nativa con IVA incluido por %s: el impuesto sigue en 0 y el total es el de hoy ($50)',
    async camino => {
      const o = await crearEnTerminal(venueId, {
        items: [
          { productId: cafeId, quantity: 1, unitPrice: 100 },
          { productId: panId, quantity: 1, unitPrice: 50 },
        ],
        staffId,
        taxAmount: 0,
        subtotal: 150,
        total: 150,
        tip: 0,
      } as any)
      await quitar(camino, o.id, (await renglonDe(o.id, cafeId)).id)
      const escrita = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
      expect([escrita.contratoDePrecio, Number(escrita.taxAmount), Number(escrita.total), Number(escrita.remainingBalance)]).toEqual([
        'IVA_INCLUIDO',
        0,
        50,
        50,
      ])
    },
  )
})

// B2c (P4, P13; founder 1-oct y 2-oct): lo dirigido a un renglón que se borra, se anula o se regala se recorta o se retira con
// sus beneficios ANTES de tocarlo, y anular recalcula igual que borrar. Las cuentas de cada caso, a mano, en el plan B2c.
describe('B2c: renglones que cambian debajo de un descuento (P4, P5)', () => {
  async function cafeConDiezYPan() {
    const diez = await prisma.discount.create({
      data: { venueId, name: `10 % café ${randomUUID()}`, type: 'PERCENTAGE', value: 10, scope: 'ITEM' },
    })
    const o = await crearEnTerminal(venueId, {
      items: [
        { productId: cafeId, quantity: 1, unitPrice: 100, itemDiscountId: diez.id },
        { productId: panId, quantity: 1, unitPrice: 50 },
      ],
      staffId,
      taxAmount: 0,
      subtotal: 150,
      total: 140,
      tip: 0,
    } as any)
    return { orderId: o.id, cafe: await renglonDe(o.id, cafeId) }
  }

  it('🔴 P4: borrar un artículo con su propio descuento ya no deja ese descuento sobre los demás', async () => {
    const { orderId, cafe } = await cafeConDiezYPan()
    await removeOrderItem(venueId, orderId, cafe.id, await version(orderId)) // recortarDescuentosDeRenglones
    expect(await filas(orderId)).toEqual([])
    // Hoy: el espejo de $10 se quedaba (tiene appliedToItemIds) y el pan de $50 se cobraba en $40.
    expect(await cabecera(orderId)).toEqual({ subtotal: 50, descuento: 0, total: 50, saldo: 50 })
  })

  it('🔴 P4: anular un artículo con su propio descuento baja la cabecera', async () => {
    const { orderId, cafe } = await cafeConDiezYPan()
    await voidItems(venueId, orderId, { itemIds: [cafe.id], reason: 'Error de captura', staffId, expectedVersion: await version(orderId) })
    expect(await filas(orderId)).toEqual([])
    // Hoy: la cabecera seguía en $10 y el pan salía en $40.
    expect(await cabecera(orderId)).toEqual({ subtotal: 50, descuento: 0, total: 50, saldo: 50 })
  })

  async function cafeYPanConTreinta() {
    const o = await crearEnTerminal(venueId, {
      items: [
        { productId: cafeId, quantity: 1, unitPrice: 100 },
        { productId: panId, quantity: 1, unitPrice: 50 },
      ],
      staffId,
      taxAmount: 0,
      subtotal: 150,
      total: 150,
      tip: 0,
    } as any)
    await applyManualDiscount(o.id, 'PERCENTAGE', 30, '30 % cuenta', staffVenueId, undefined, undefined, venueId) // $45
    return { orderId: o.id, cafe: await renglonDe(o.id, cafeId) }
  }

  it('🔴 P13 antes/después: anular recalcula el % de cuenta sobre lo que queda (30 % de $50 = $15; hoy se quedaba en $45)', async () => {
    const { orderId, cafe } = await cafeYPanConTreinta()
    await voidItems(venueId, orderId, { itemIds: [cafe.id], reason: 'Error de captura', staffId, expectedVersion: await version(orderId) })
    const [fila] = await filas(orderId)
    expect(Number(fila.amount)).toBe(15)
    // Hoy: la cabecera seguía en $45 sobre un subtotal de $50 y la cuenta quedaba en $5.
    expect(await cabecera(orderId)).toEqual({ subtotal: 50, descuento: 15, total: 35, saldo: 35 })
  })

  it('control — P13: borrar el mismo artículo da exactamente lo mismo que anularlo (como hoy en borrar)', async () => {
    const { orderId, cafe } = await cafeYPanConTreinta()
    await removeOrderItem(venueId, orderId, cafe.id, await version(orderId))
    expect(await cabecera(orderId)).toEqual({ subtotal: 50, descuento: 15, total: 35, saldo: 35 })
  })

  // R7-1 (ruling heredado de B2): la cabecera puede traer un resto sin fila (orden anterior a B2, `applyDiscount` sin
  // renglones, la cortesía vieja de la terminal). Borrar y anular lo congelan (`conservarDescuentoHistorico`) ANTES del recorte;
  // en anular es indispensable porque P13 pasa su descuento de la cabecera leída a Σ filas.
  it.each([
    { camino: 'borrar', hoy: 'hoy perdía los $20: descuento $15 y total $35' },
    { camino: 'anular', hoy: 'hoy dejaba la cabecera en $65 y la cuenta en $0' },
  ] as const)(
    '🔴 R7-1 por $camino: $20 de cabecera sin fila + 30 % de cuenta; quitar el café conserva los $20 (descuento $35, total $15; $hoy)',
    async ({ camino }) => {
      const { orderId, cafe } = await cafeYPanConTreinta()
      await prisma.order.update({ where: { id: orderId }, data: { discountAmount: 65, total: 85, remainingBalance: 85 } })
      await quitar(camino, orderId, cafe.id)
      expect((await filas(orderId)).map(f => [f.name, Number(f.amount)])).toEqual([
        ['30 % cuenta', 15],
        ['Descuento anterior', 20],
      ])
      expect(await cabecera(orderId)).toEqual({ subtotal: 50, descuento: 35, total: 15, saldo: 15 })
    },
  )

  // R7-1 (ruling de B2 «al retirar un descuento, antes de borrarlo»): quitar una fila desde el móvil recalcula con Σ filas, así
  // que un resto de cabecera sin fila se perdía junto con ella.
  it('🔴 R7-1 por quitar desde el móvil: $20 de cabecera sin fila + 30 % de cuenta; quitar el 30 % conserva los $20 (descuento $20, total $130; hoy perdía los $20 y cobraba $150)', async () => {
    const { orderId } = await cafeYPanConTreinta()
    await prisma.order.update({ where: { id: orderId }, data: { discountAmount: 65, total: 85, remainingBalance: 85 } })
    const [treinta] = await filas(orderId)
    await removeOrderDiscount(venueId, orderId, treinta.id, staffId) // conservarDescuentoHistorico
    expect((await filas(orderId)).map(f => [f.name, Number(f.amount)])).toEqual([['Descuento anterior', 20]])
    expect(await cabecera(orderId)).toEqual({ subtotal: 150, descuento: 20, total: 130, saldo: 130 })
  })

  it('🔴 P4: borrar el artículo premiado con la cartilla devuelve el premio', async () => {
    const cliente = await prisma.customer.create({ data: { venueId, firstName: 'Premio P4' } })
    const o = await crearEnTerminal(venueId, {
      items: [
        { productId: cafeId, quantity: 1, unitPrice: 100 },
        { productId: panId, quantity: 1, unitPrice: 50 },
      ],
      staffId,
      taxAmount: 0,
      subtotal: 150,
      total: 150,
      tip: 0,
      customerId: cliente.id,
    } as any)
    const cartilla = await prisma.stampCard.create({
      data: { customerId: cliente.id, venueId, cycle: 1, stampsRequired: 5, stampsEarned: 5, completedAt: new Date() },
    })
    const premio = await prisma.stampReward.create({
      data: { stampCardId: cartilla.id, customerId: cliente.id, venueId, rewardType: 'FREE_PRODUCT', rewardLabel: 'Café gratis' },
    })
    const { redeemStampReward } = await import('@/services/wallet/redeemStampReward.service')
    await redeemStampReward(venueId, o.id, premio.id, { staffId })
    const cafe = await renglonDe(o.id, cafeId)
    await removeOrderItem(venueId, o.id, cafe.id, await version(o.id))
    expect(await filas(o.id)).toEqual([])
    expect((await prisma.stampReward.findUniqueOrThrow({ where: { id: premio.id } })).status).toBe('PENDING')
    // Hoy: el premio de $100 se quedaba restando sobre el pan de $50 y la cuenta quedaba en $0.
    expect(await cabecera(o.id)).toEqual({ subtotal: 50, descuento: 0, total: 50, saldo: 50 })
  })

  // R9 (Codex r4 R4-1): el retiro del IVA de B2b v5 junto con el recorte y P13. `cafeYPanConIvaAparte`, `cobroTras`, `version`
  // y `quitar` son de nivel de archivo.

  /** Café $100 + IVA $16 todo descontado por el motor (100 % del café, D16: reducción 16 ⇒ cabecera 0) y pan $50 exento: $50. */
  async function cafeDescontadoYPanExento() {
    const { orderId, cafe } = await cafeYPanConIvaAparte(0) // pan exento: cabecera 16
    const todoElCafe = await prisma.discount.create({
      data: {
        venueId,
        name: `100 % café D16 ${orderId}`,
        type: 'PERCENTAGE',
        value: 100,
        scope: 'ITEM',
        targetItemIds: [cafeId],
        applyBeforeTax: true,
      },
    })
    const { applyDiscountToOrder } = await import('@/services/dashboard/discountEngine.service')
    expect(await applyDiscountToOrder(orderId, todoElCafe.id, staffVenueId, undefined, venueId)).toMatchObject({
      success: true,
      amount: 100,
    })
    const [fila] = await filas(orderId)
    expect(fila.reparto).toMatchObject({ alcance: 'DIRIGIDO', reduceImpuesto: true, renglones: { [cafe.id]: 10000 } })
    expect(Number(fila.taxReduction)).toBe(16)
    expect(Number((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).taxAmount)).toBe(0) // ← el caso que el conteo de la v4 no veía
    expect(await cabecera(orderId)).toEqual({ subtotal: 150, descuento: 100, total: 50, saldo: 50 })
    return { orderId, cafe }
  }

  it.each(['borrar', 'anular'] as const)(
    '🔴 R9 caso 2 por %s: café todo descontado por D16 (cabecera 0) y pan exento; quitar el café no revive su IVA ⇒ IVA 0 y se cobran $50 (la v4: 16 y $66)',
    async camino => {
      const { orderId, cafe } = await cafeDescontadoYPanExento()
      await quitar(camino, orderId, cafe.id) // R9: 0 − 16 (base = 0 + 16); el recorte retira la dirigida y devuelve +16 ⇒ 0
      expect(await filas(orderId)).toEqual([])
      expect(await cabecera(orderId)).toMatchObject({ subtotal: 50, descuento: 0 })
      expect(await cobroTras(orderId, 66)).toEqual({ impuesto: 0, total: 50, saldo: 50, reconstruido: 50, cobrado: 50 })
    },
  )

  it('🔴 R9 + P13: anular el café con un 10 % de cuenta del motor (D16) da lo mismo que borrarlo — fila $5 con reducción 0.80, IVA 7.20 y $52.20 (la v4: 23.20 y $68.20)', async () => {
    const { orderId, cafe } = await cafeYPanConIvaAparte()
    const diez = await prisma.discount.create({
      data: { venueId, name: `10 % D16 anular ${orderId}`, type: 'PERCENTAGE', value: 10, scope: 'ORDER', applyBeforeTax: true },
    })
    const { applyDiscountToOrder } = await import('@/services/dashboard/discountEngine.service')
    expect(await applyDiscountToOrder(orderId, diez.id, staffVenueId, undefined, venueId)).toMatchObject({ success: true, amount: 15 })
    await quitar('anular', orderId, cafe.id) // R9: 21.60 − 16 = 5.60; P13 re-deriva $5 y la sincronización devuelve 1.60 ⇒ 7.20
    const [fila] = await filas(orderId)
    expect([Number(fila.amount), Number(fila.taxReduction)]).toEqual([5, 0.8])
    expect(await cabecera(orderId)).toMatchObject({ subtotal: 50, descuento: 5 })
    expect(await cobroTras(orderId, 68.2)).toEqual({ impuesto: 7.2, total: 52.2, saldo: 52.2, reconstruido: 52.2, cobrado: 52.2 })
  })

  // B2b T6b M1: anular parcial sin recortar ni sincronizar dejaba la cabecera GUARDADA negativa (el cobro la clampaba a 0).
  it('🔴 B2b T6b M1: anular el café con un 50 % dirigido (D16) y pan exento deja el impuesto guardado en 0 (hoy −8) y cobra $50', async () => {
    const { orderId, cafe } = await cafeYPanConIvaAparte(0) // pan exento: cabecera 16
    const mitad = await prisma.discount.create({
      data: {
        venueId,
        name: `50 % café D16 ${orderId}`,
        type: 'PERCENTAGE',
        value: 50,
        scope: 'ITEM',
        targetItemIds: [cafeId],
        applyBeforeTax: true,
      },
    })
    const { applyDiscountToOrder } = await import('@/services/dashboard/discountEngine.service')
    expect(await applyDiscountToOrder(orderId, mitad.id, staffVenueId, undefined, venueId)).toMatchObject({ success: true, amount: 50 })
    expect(Number((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).taxAmount)).toBe(8) // 16 − 50 × 16/100
    await quitar('anular', orderId, cafe.id) // R9: 8 − 16 (base = 8 + 8) = −8; el recorte retira la dirigida y devuelve +8 ⇒ 0
    expect(Number((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).taxAmount)).toBe(0)
    expect(await filas(orderId)).toEqual([])
    expect(await cabecera(orderId)).toEqual({ subtotal: 50, descuento: 0, total: 50, saldo: 50 })
  })
  // La reducción que devuelve una fila retirada entra al TOTAL (no sólo a `Order.taxAmount`): aquí no la tapa el piso de 0.
  it.each(['borrar', 'anular'] as const)(
    '🔴 P4 + R9 por %s: café con 50 %% dirigido (D16) y pan con IVA 8; quitar el café devuelve los 8 de la dirigida ⇒ IVA 8 y se cobran $58',
    async camino => {
      const { orderId, cafe } = await cafeYPanConIvaAparte() // cabecera 24
      const mitad = await prisma.discount.create({
        data: {
          venueId,
          name: `50 % café D16 ${camino} ${orderId}`,
          type: 'PERCENTAGE',
          value: 50,
          scope: 'ITEM',
          targetItemIds: [cafeId],
          applyBeforeTax: true,
        },
      })
      const { applyDiscountToOrder } = await import('@/services/dashboard/discountEngine.service')
      expect(await applyDiscountToOrder(orderId, mitad.id, staffVenueId, undefined, venueId)).toMatchObject({ success: true, amount: 50 })
      expect(Number((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).taxAmount)).toBe(16) // 24 − 8
      await quitar(camino, orderId, cafe.id) // R9: 16 − 16 (base 16 + 8) = 0; el recorte retira la dirigida y devuelve +8 ⇒ 8
      expect(await filas(orderId)).toEqual([])
      expect(await cabecera(orderId)).toMatchObject({ subtotal: 50, descuento: 0 })
      // Un efectivo de $74: lo que exceda el saldo es cambio.
      expect(await cobroTras(orderId, 74)).toEqual({ impuesto: 8, total: 58, saldo: 58, reconstruido: 58, cobrado: 58 })
    },
  )

  // Minor 4 de la revisión de T2: el recorte PARCIAL por los llamadores reales. Una DIRIGIDA (D16) sobre café y pan en una cuenta
  // IVA_APARTE; quitar sólo el café la RECORTA por su parte guardada (no la retira), su reducción se recalcula con el pan que le
  // queda, y la sincronización que corre después parte de lo guardado por el recorte: nunca devuelve el impuesto dos veces.
  // Cuentas: café $100 IVA 16 + pan $50 IVA 8 (cabecera 24). Dirigida de $30 ⇒ café 20 / pan 10; reducción 20 × 16/100 + 10 ×
  // 8/50 = 3.20 + 1.60 = 4.80 ⇒ cabecera 19.20, total 139.20. Quitar el café: R9 19.20 − 16 = 3.20; el recorte deja la fila en
  // $10 (pan) con reducción 1.60 y devuelve 4.80 − 1.60 = 3.20 ⇒ IVA 6.40 (= 8 − 1.60); total 50 − 10 + 6.40 = $46.40. Si la
  // sincronización volviera a devolver los 3.20: IVA 9.60 y $49.60.
  it.each([
    { camino: 'borrar', tipo: 'PERCENTAGE', valor: 20 },
    { camino: 'anular', tipo: 'PERCENTAGE', valor: 20 },
    { camino: 'borrar', tipo: 'FIXED_AMOUNT', valor: 30 },
    { camino: 'anular', tipo: 'FIXED_AMOUNT', valor: 30 },
  ] as const)(
    '🔴 recorte parcial por $camino ($tipo $valor dirigido a café y pan, D16): la fila queda en $10 con reducción 1.60, IVA 6.40 y se cobran $46.40 (nunca resta dos veces)',
    async ({ camino, tipo, valor }) => {
      const { orderId, cafe, pan } = await cafeYPanConIvaAparte() // cabecera 24
      const dirigida = await prisma.discount.create({
        data: {
          venueId,
          name: `${tipo} café y pan D16 ${camino} ${orderId}`,
          type: tipo,
          value: valor,
          scope: 'ITEM',
          targetItemIds: [cafeId, panId],
          applyBeforeTax: true,
        },
      })
      const { applyDiscountToOrder } = await import('@/services/dashboard/discountEngine.service')
      expect(await applyDiscountToOrder(orderId, dirigida.id, staffVenueId, undefined, venueId)).toMatchObject({
        success: true,
        amount: 30,
      })
      let [fila] = await filas(orderId)
      expect(fila.reparto).toMatchObject({ alcance: 'DIRIGIDO', reduceImpuesto: true })
      expect((fila.reparto as { renglones: unknown }).renglones).toEqual({ [cafe.id]: 2000, [pan.id]: 1000 })
      expect(Number(fila.taxReduction)).toBe(4.8)
      expect(await cobroAntes(orderId)).toEqual({ impuesto: 19.2, total: 139.2 })

      await quitar(camino, orderId, cafe.id) // recortarDescuentosDeRenglones: RECORTA la dirigida, no la retira
      const todas = await filas(orderId)
      expect(todas.map(f => f.id)).toEqual([fila.id]) // la MISMA fila, recortada (no retirada y vuelta a crear)
      ;[fila] = todas
      expect([Number(fila.amount), Number(fila.taxReduction)]).toEqual([10, 1.6])
      expect(fila.reparto).toMatchObject({ alcance: 'DIRIGIDO', reduceImpuesto: true })
      expect((fila.reparto as { renglones: unknown }).renglones).toEqual({ [pan.id]: 1000 })
      expect(await cabecera(orderId)).toMatchObject({ subtotal: 50, descuento: 10 })
      // Un efectivo de $49.60 (lo que pediría la doble devolución): lo que exceda el saldo es cambio.
      expect(await cobroTras(orderId, 49.6)).toEqual({ impuesto: 6.4, total: 46.4, saldo: 46.4, reconstruido: 46.4, cobrado: 46.4 })
    },
  )

  // ── P5: las cortesías (Tarea 4) ──────────────────────────────────────────────────────────────────────────────────────
  it('🔴 P5: dar de cortesía un artículo con descuento no le encima el descuento, y agregar después no pierde la cortesía', async () => {
    const { orderId, cafe } = await cafeConDiezYPan()
    const [espejoDelDiez] = await filas(orderId)
    await compItems(venueId, orderId, { itemIds: [cafe.id], reason: 'Invitación', staffId }) // recortarDescuentosDeRenglones
    const todas = await filas(orderId)
    expect(todas).toHaveLength(1) // el espejo del 10 % se retiró; queda la cortesía
    expect(todas[0]).toMatchObject({ type: 'COMP', isComp: true, appliedToItemIds: [cafe.id] })
    expect(todas[0].reparto).toEqual({ v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: true, renglones: { [cafe.id]: 10000 } })
    expect((await renglonDe(orderId, cafeId)).appliedDiscountId).toBeNull()
    // Hoy: 10 + 100 = 110 de descuento y el pan de $50 se cobraba en $40.
    expect(await cabecera(orderId)).toEqual({ subtotal: 150, descuento: 100, total: 50, saldo: 50 })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ITEM_COMPED',
        entityId: orderId,
        data: expect.objectContaining({ descuentosRetirados: [expect.objectContaining({ id: espejoDelDiez.id })] }),
      }),
    )

    // Otro pan como ronda NUEVA (`asNewRound`): en el modo caja, una línea que ya existe se fusiona reemplazando la cantidad.
    await addItemsToOrder(venueId, orderId, [{ productId: panId, quantity: 1 }], await version(orderId), true)
    // Hoy: la cortesía vivía sólo en la cabecera; el recálculo (Σ filas = 10) la borraba y la cuenta subía a $190.
    expect(await cabecera(orderId)).toEqual({ subtotal: 200, descuento: 100, total: 100, saldo: 100 })
  })

  /** Café $100 con 10 % de artículo (espejo) y pan $50, creada desde el móvil: $140. */
  async function cafeConDiezYPanEnMovil() {
    const diez = await prisma.discount.create({
      data: { venueId, name: `10 % móvil ${randomUUID()}`, type: 'PERCENTAGE', value: 10, scope: 'ITEM' },
    })
    const creada = await crearEnMovil(venueId, {
      staffId,
      items: [
        { productId: cafeId, quantity: 1, discountId: diez.id },
        { productId: panId, quantity: 1 },
      ],
      source: 'AVOQADO_ANDROID',
    } as any)
    return { orderId: creada.id, diez, cafe: await renglonDe(creada.id, cafeId), pan: await renglonDe(creada.id, panId) }
  }

  it('🔴 P5: la cortesía del móvil sobre un artículo con descuento retira ese descuento', async () => {
    const { orderId, cafe } = await cafeConDiezYPanEnMovil()
    const [espejoDelDiez] = await filas(orderId)
    await compOrderItem({ venueId, orderId, itemId: cafe.id, reason: 'Amigos y familia', staffId })
    expect(await filas(orderId)).toEqual([])
    expect((await renglonDe(orderId, cafeId)).appliedDiscountId).toBeNull()
    // Hoy: el espejo de $10 seguía en la cabecera aunque el café ya no se cobra; el pan de $50 salía en $40.
    expect(await cabecera(orderId)).toEqual({ subtotal: 50, descuento: 0, total: 50, saldo: 50 })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ORDER_ITEM_COMPED',
        entityId: cafe.id,
        data: expect.objectContaining({ descuentosRetirados: [expect.objectContaining({ id: espejoDelDiez.id })] }),
      }),
    )
  })

  it('🔴 P5: la cortesía de TODA la cuenta en el móvil retira el descuento propio de sus renglones (hoy quedaba $10 de descuento sobre $0)', async () => {
    const { orderId } = await cafeConDiezYPanEnMovil()
    await compWholeOrder({ venueId, orderId, reason: 'Amigos y familia', staffId })
    expect(await filas(orderId)).toEqual([])
    expect(await cabecera(orderId)).toEqual({ subtotal: 0, descuento: 0, total: 0, saldo: 0 })
  })

  // R7-1 en el móvil: su recálculo es Σ filas, así que un resto de cabecera sin fila se perdía al regalar cualquier renglón.
  it('🔴 R7-1 por la cortesía del móvil: $20 de cabecera sin fila sobreviven a regalar el pan (descuento $30, total $70; hoy $10 y $90)', async () => {
    const { orderId, diez, pan } = await cafeConDiezYPanEnMovil()
    await prisma.order.update({ where: { id: orderId }, data: { discountAmount: 30, total: 120, remainingBalance: 120 } })
    await compOrderItem({ venueId, orderId, itemId: pan.id, reason: 'Amigos y familia', staffId }) // conservarDescuentoHistorico
    expect((await filas(orderId)).map(f => [f.discountId === diez.id ? 'espejo del 10 %' : f.name, Number(f.amount)])).toEqual([
      ['espejo del 10 %', 10],
      ['Descuento anterior', 20],
    ])
    expect(await cabecera(orderId)).toEqual({ subtotal: 100, descuento: 30, total: 70, saldo: 70 })
  })

  it('🔴 B3a r2 N1: promoción → descuento de cuenta → cortesía de la promoción: el descuento de cuenta queda entero en el café', async () => {
    const combo = await prisma.promotion.create({
      data: {
        venueId,
        name: `Combo ${randomUUID()}`,
        type: 'BUNDLE',
        pricingMode: 'FIXED_TOTAL',
        priceCents: 8000,
        status: 'PUBLISHED',
        daysOfWeek: [],
        groups: { create: [{ name: 'Regalo', displayOrder: 0, options: { create: [{ productId: llaveroId }] } }] },
      },
      include: { groups: { include: { options: true } } },
    })
    const orderId = await cuentaDeCafe()
    const { applyPromotionToOrder } = await import('@/services/promotions/promotion.service')
    await applyPromotionToOrder({
      venueId,
      orderId,
      promotionId: combo.id,
      instanceId: randomUUID(),
      selections: combo.groups.map(g => ({ groupId: g.id, optionId: g.options[0].id })),
      soldAt: new Date(),
    }) // el llavero de $100 entra al combo en $80
    await applyManualDiscount(orderId, 'FIXED_AMOUNT', 10, 'Diez', staffVenueId, undefined, undefined, venueId)
    const cafe = await renglonDe(orderId, cafeId)
    const lineaCombo = await prisma.orderItem.findFirstOrThrow({ where: { orderId, orderPromotionId: { not: null } } })
    expect((await filas(orderId)).find(f => f.name === 'Diez')!.reparto).toMatchObject({
      renglones: { [cafe.id]: 556, [lineaCombo.id]: 444 },
    })

    await compItems(venueId, orderId, { itemIds: [lineaCombo.id], reason: 'Invitación', staffId })
    // La línea del combo queda con orderPromotionId, total 80, discountAmount 80 e isCortesia: aporta 0 (antes, 80).
    expect((await filas(orderId)).find(f => f.name === 'Diez')!.reparto).toMatchObject({ renglones: { [cafe.id]: 1000 } })
    expect(await cabecera(orderId)).toEqual({ subtotal: 180, descuento: 90, total: 90, saldo: 90 })
  })

  // R7-1 en la terminal: con la cortesía ya en su fila, el resto de cabecera sin fila se congela ANTES; si no, el siguiente
  // recálculo (Σ filas) lo perdía.
  async function cafeYPanSinDescuento() {
    const o = await crearEnTerminal(venueId, {
      items: [
        { productId: cafeId, quantity: 1, unitPrice: 100 },
        { productId: panId, quantity: 1, unitPrice: 50 },
      ],
      staffId,
      taxAmount: 0,
      subtotal: 150,
      total: 150,
      tip: 0,
    } as any)
    return { orderId: o.id, cafe: await renglonDe(o.id, cafeId) }
  }

  it('🔴 R7-1 por la cortesía de la terminal: $20 de cabecera sin fila sobreviven a regalar el café y a agregar el llavero ($120/$130)', async () => {
    const { orderId, cafe } = await cafeYPanSinDescuento()
    await prisma.order.update({ where: { id: orderId }, data: { discountAmount: 20, total: 130, remainingBalance: 130 } })
    await compItems(venueId, orderId, { itemIds: [cafe.id], reason: 'Invitación', staffId }) // conservarDescuentoHistorico
    // Hoy no había filas: la cortesía y los $20 vivían sólo en la cabecera.
    expect((await filas(orderId)).map(f => [f.name, Number(f.amount)])).toEqual([
      ['Descuento anterior', 20],
      ['Cortesía', 100],
    ])
    expect(await cabecera(orderId)).toEqual({ subtotal: 150, descuento: 120, total: 30, saldo: 30 })
    await addItemsToOrder(venueId, orderId, [{ productId: llaveroId, quantity: 1 }], await version(orderId))
    expect(await cabecera(orderId)).toEqual({ subtotal: 250, descuento: 120, total: 130, saldo: 130 })
  })

  // B2 T4 (C-11, T-14): el `applyDiscount` heredado y la cortesía, en los dos órdenes, seguidos de un recálculo. El heredado
  // lleva `appliedToItemIds` ⇒ su importe queda CONGELADO (10 % de $150 = $15, contando el café que después se regala, o que ya
  // estaba regalado: `applyDiscount` calcula sobre el subtotal). R8 (Tarea 4b) sólo cambia la base de los % que se re-derivan y la
  // del motor, así que estos números no se mueven con ella.
  it('🔴 B2 T4: applyDiscount heredado 10 % → cortesía del café → agregar el llavero ($115/$35 y luego $115/$135; hoy al agregar $15/$235)', async () => {
    const { orderId, cafe } = await cafeYPanSinDescuento()
    await applyDiscountHeredado(venueId, orderId, {
      type: 'PERCENTAGE',
      value: 10,
      reason: 'Diez heredado',
      staffId,
      expectedVersion: await version(orderId),
    })
    await compItems(venueId, orderId, { itemIds: [cafe.id], reason: 'Invitación', staffId })
    expect((await filas(orderId)).map(f => [f.type, f.name, Number(f.amount)])).toEqual([
      ['PERCENTAGE', 'Diez heredado', 15],
      ['COMP', 'Cortesía', 100],
    ])
    expect(await cabecera(orderId)).toEqual({ subtotal: 150, descuento: 115, total: 35, saldo: 35 })
    await addItemsToOrder(venueId, orderId, [{ productId: llaveroId, quantity: 1 }], await version(orderId))
    // Hoy: la cortesía vivía sólo en la cabecera y el recálculo (Σ filas = 15) la borraba.
    expect(await cabecera(orderId)).toEqual({ subtotal: 250, descuento: 115, total: 135, saldo: 135 })
  })

  it('🔴 B2 T4: cortesía del café → applyDiscount heredado 10 % → agregar el llavero: la cortesía es su fila COMP, no un «Descuento anterior» ($115/$35 y luego $115/$135)', async () => {
    const { orderId, cafe } = await cafeYPanSinDescuento()
    await compItems(venueId, orderId, { itemIds: [cafe.id], reason: 'Invitación', staffId })
    await applyDiscountHeredado(venueId, orderId, {
      type: 'PERCENTAGE',
      value: 10,
      reason: 'Diez heredado',
      staffId,
      expectedVersion: await version(orderId),
    })
    // Hoy: el heredado congelaba los $100 de la cortesía como «Descuento anterior» (D8, sin renglón: la factura no sabe de quién).
    expect((await filas(orderId)).map(f => [f.type, f.name, Number(f.amount)])).toEqual([
      ['COMP', 'Cortesía', 100],
      ['PERCENTAGE', 'Diez heredado', 15],
    ])
    expect(await cabecera(orderId)).toEqual({ subtotal: 150, descuento: 115, total: 35, saldo: 35 })
    await addItemsToOrder(venueId, orderId, [{ productId: llaveroId, quantity: 1 }], await version(orderId))
    expect(await cabecera(orderId)).toEqual({ subtotal: 250, descuento: 115, total: 135, saldo: 135 })
  })

  // B2c F2 (Codex r1 #3; ruling «P2 R5/R15, transición»): una orden VIEJA abierta al desplegar, con la cortesía de la terminal
  // de antes de B2c (sólo en su renglón y en la cabecera, sin fila) y un fijo con fila. `conservarDescuentoHistorico` congelaba
  // la cortesía como «Descuento anterior» sin destino y el recorte ya no la retiraba al quitar el café; ahora gana su espejo COMP.
  it.each([
    { camino: 'borrar', antes: 'antes de F2: descuento $110 y total $0' },
    { camino: 'anular', antes: 'antes de F2: descuento $110 y total $0' },
  ] as const)(
    '🔴 F2 (Codex r1 #3) por $camino: café regalado sólo en la cabecera + pan $50 + fijo $10 (cabecera $110); quitar el café deja $40 ($antes)',
    async ({ camino }) => {
      const { orderId, cafe } = await cafeYPanSinDescuento()
      await applyManualDiscount(orderId, 'FIXED_AMOUNT', 10, 'Diez fijo', staffVenueId, undefined, undefined, venueId)
      await prisma.orderItem.update({
        where: { id: cafe.id },
        data: { isCortesia: true, cortesiaReason: 'Invitación', discountAmount: 100 },
      })
      await prisma.order.update({ where: { id: orderId }, data: { discountAmount: 110, total: 40, remainingBalance: 40 } })
      await quitar(camino, orderId, cafe.id)
      expect((await filas(orderId)).map(f => [f.name, Number(f.amount)])).toEqual([['Diez fijo', 10]])
      expect(await cabecera(orderId)).toEqual({ subtotal: 50, descuento: 10, total: 40, saldo: 40 })
    },
  )

  it('🔴 F2: normalizar no cambia el cobro del momento — orden vieja (café regalado sólo en la cabecera) + otro fijo de $5 ⇒ $45, y la cortesía queda en su espejo', async () => {
    const { orderId, cafe } = await cafeYPanSinDescuento()
    await prisma.orderItem.update({ where: { id: cafe.id }, data: { isCortesia: true, cortesiaReason: 'Invitación', discountAmount: 100 } })
    await prisma.order.update({ where: { id: orderId }, data: { discountAmount: 100, total: 50, remainingBalance: 50 } })
    await applyManualDiscount(orderId, 'FIXED_AMOUNT', 5, 'Cinco fijo', staffVenueId, undefined, undefined, venueId) // conservar
    // Antes de F2: [['Descuento anterior', 100], ['Cinco fijo', 5]] con el mismo total.
    expect((await filas(orderId)).map(f => [f.type, f.name, Number(f.amount), f.appliedToItemIds])).toEqual([
      ['COMP', 'Cortesía', 100, [cafe.id]],
      ['FIXED_AMOUNT', 'Cinco fijo', 5, []],
    ])
    expect(await cabecera(orderId)).toEqual({ subtotal: 150, descuento: 105, total: 45, saldo: 45 })
  })

  it('🔴 F2: el espejo nuevo de un descuento propio viejo se reconoce al QUITARLO — revierte el descuento del renglón ($10 propios + fijo $5)', async () => {
    const { orderId, cafe } = await cafeYPanSinDescuento()
    await prisma.orderItem.update({ where: { id: cafe.id }, data: { discountAmount: 10 } })
    await prisma.order.update({ where: { id: orderId }, data: { discountAmount: 10, total: 140, remainingBalance: 140 } })
    await applyManualDiscount(orderId, 'FIXED_AMOUNT', 5, 'Cinco fijo', staffVenueId, undefined, undefined, venueId) // conservar
    // Antes de F2: [['Descuento anterior', 10, []], ['Cinco fijo', 5, []]] y quitar el anterior no tocaba el renglón.
    expect((await filas(orderId)).map(f => [f.name, Number(f.amount), f.appliedToItemIds])).toEqual([
      ['Descuento del artículo', 10, [cafe.id]],
      ['Cinco fijo', 5, []],
    ])
    const [espejo] = await filas(orderId)
    expect(await cabecera(orderId)).toEqual({ subtotal: 150, descuento: 15, total: 135, saldo: 135 })
    await removeDiscountFromOrder(orderId, espejo.id, staffId, venueId) // revertirDescuentoDelRenglon
    expect(Number((await renglonDe(orderId, cafeId)).discountAmount)).toBe(0)
    expect(await cabecera(orderId)).toEqual({ subtotal: 150, descuento: 5, total: 145, saldo: 145 })
  })

  // F2b (Codex r2 P2): un descuento propio del CATÁLOGO materializado sin fila ni uso (como un vale v7). El espejo normalizado no
  // consumió ningún uso: quitarlo no puede «devolver» uno (antes: `currentUses` −1, que deja pasar usos sobre `maxTotalUses`).
  it('🔴 F2b (Codex r2): normalizar el descuento propio del catálogo y quitar su espejo deja el cobro en $100, el renglón limpio y currentUses en 0', async () => {
    const diez = await prisma.discount.create({
      data: { venueId, name: `10 % catálogo ${randomUUID()}`, type: 'PERCENTAGE', value: 10, scope: 'ITEM', maxTotalUses: 1 },
    })
    const orderId = await cuentaDeCafe()
    const cafe = await renglonDe(orderId, cafeId)
    await prisma.orderItem.update({ where: { id: cafe.id }, data: { discountAmount: 10, appliedDiscountId: diez.id } })
    await prisma.order.update({ where: { id: orderId }, data: { discountAmount: 10, total: 90, remainingBalance: 90 } })
    await applyManualDiscount(orderId, 'FIXED_AMOUNT', 5, 'Cinco fijo', staffVenueId, undefined, undefined, venueId) // conservar
    const [espejo, cinco] = await filas(orderId)
    expect([espejo.name, Number(espejo.amount), espejo.appliedToItemIds]).toEqual([diez.name, 10, [cafe.id]])
    await removeDiscountFromOrder(orderId, espejo.id, staffId, venueId)
    await removeDiscountFromOrder(orderId, cinco.id, staffId, venueId)
    const limpio = await renglonDe(orderId, cafeId)
    expect([Number(limpio.discountAmount), limpio.appliedDiscountId]).toEqual([0, null])
    expect(await cabecera(orderId)).toEqual({ subtotal: 100, descuento: 0, total: 100, saldo: 100 })
    expect((await prisma.discount.findUniqueOrThrow({ where: { id: diez.id } })).currentUses).toBe(0)
  })

  it('control — F2b: una aplicación NORMAL del catálogo (que sí consumió su uso) lo devuelve al quitarse', async () => {
    const diez = await prisma.discount.create({
      data: { venueId, name: `10 % de cuenta ${randomUUID()}`, type: 'FIXED_AMOUNT', value: 10, scope: 'ORDER' },
    })
    const orderId = await cuentaDeCafe()
    const { applyDiscountToOrder } = await import('@/services/dashboard/discountEngine.service')
    expect(await applyDiscountToOrder(orderId, diez.id, staffVenueId, undefined, venueId)).toMatchObject({ success: true, amount: 10 })
    expect((await prisma.discount.findUniqueOrThrow({ where: { id: diez.id } })).currentUses).toBe(1)
    const [fila] = await filas(orderId)
    await removeDiscountFromOrder(orderId, fila.id, staffId, venueId)
    expect((await prisma.discount.findUniqueOrThrow({ where: { id: diez.id } })).currentUses).toBe(0)
    expect(await cabecera(orderId)).toEqual({ subtotal: 100, descuento: 0, total: 100, saldo: 100 })
  })

  // Ruling de la revisión de T2: la cortesía de la terminal YA tiene su espejo, así que borrar el renglón regalado lo retira y
  // no queda un «Descuento anterior» restando sobre los demás; el % de cuenta se re-deriva sobre lo que queda.
  // Ruling de la revisión de T4 (Tarea 4b): `compItems` también RECALCULA (R8: el % ya no cuenta lo regalado), así que la misma
  // cortesía cobra igual en la terminal que en el móvil: el pan en $35 (antes la terminal dejaba $5 y el móvil $35).
  it('🔴 P5 + P4 + R8: 30 % de cuenta y cortesía del café ⇒ el 30 % baja a $15 y se cobran $35, igual que la cortesía del móvil (hoy la terminal dejaba $45 + $100 y $5); borrar el café no cambia nada', async () => {
    const { orderId, cafe } = await cafeYPanConTreinta() // $45
    await compItems(venueId, orderId, { itemIds: [cafe.id], reason: 'Invitación', staffId })
    expect((await filas(orderId)).map(f => [f.name, Number(f.amount)])).toEqual([
      ['30 % cuenta', 15],
      ['Cortesía', 100],
    ])
    expect(await cabecera(orderId)).toEqual({ subtotal: 150, descuento: 115, total: 35, saldo: 35 })
    // La MISMA cortesía desde el móvil (renglón en total 0): el 30 % se re-deriva sobre el pan y se cobran los mismos $35.
    const enMovil = await cafeYPanConTreinta()
    await compOrderItem({ venueId, orderId: enMovil.orderId, itemId: enMovil.cafe.id, reason: 'Amigos y familia', staffId })
    expect((await filas(enMovil.orderId)).map(f => [f.name, Number(f.amount)])).toEqual([['30 % cuenta', 15]])
    expect(await cabecera(enMovil.orderId)).toEqual({ subtotal: 50, descuento: 15, total: 35, saldo: 35 })

    await removeOrderItem(venueId, orderId, cafe.id, await version(orderId))
    expect((await filas(orderId)).map(f => [f.name, Number(f.amount)])).toEqual([['30 % cuenta', 15]])
    expect(await cabecera(orderId)).toEqual({ subtotal: 50, descuento: 15, total: 35, saldo: 35 })
  })

  it('🔴 R8 antes/después: tras regalar el pan, el 10 % de cuenta se recalcula sin él (agregar un llavero: $20; hoy $25)', async () => {
    const orderId = (
      await crearEnTerminal(venueId, {
        items: [
          { productId: cafeId, quantity: 1, unitPrice: 100 },
          { productId: panId, quantity: 1, unitPrice: 50 },
        ],
        staffId,
        taxAmount: 0,
        subtotal: 150,
        total: 150,
        tip: 0,
      } as any)
    ).id
    await applyManualDiscount(orderId, 'PERCENTAGE', 10, '10 % cuenta', staffVenueId, undefined, undefined, venueId) // $15
    const pan = await renglonDe(orderId, panId)
    await compItems(venueId, orderId, { itemIds: [pan.id], reason: 'Invitación', staffId })
    // `compItems` ya recalcula (ruling de T4): 10 % del café = $10, más la cortesía de $50 (hoy $15 + $50).
    expect(await cabecera(orderId)).toEqual({ subtotal: 150, descuento: 60, total: 90, saldo: 90 })
    await addItemsToOrder(venueId, orderId, [{ productId: llaveroId, quantity: 1 }], await version(orderId))
    const pct = (await filas(orderId)).find(f => f.type === 'PERCENTAGE')!
    expect(Number(pct.amount)).toBe(20) // 10 % de café + llavero; hoy contaba también el pan regalado ($25)
    expect(await cabecera(orderId)).toEqual({ subtotal: 250, descuento: 70, total: 180, saldo: 180 }) // 20 + la cortesía de 50
  })

  // Ronda de arreglo 1 de T4b: con filas, la cabecera de `compItems` es Σ filas SIN tope (como `voidItems`). Topada al subtotal,
  // quitar después una fila con `removeDiscountFromOrder` (cabecera − su importe) cobraba de más. El total ya lo topa
  // `computeStoredOrderTotal` (nunca negativo).
  async function cafeYPanConFijoDeSesentaYCafeRegalado() {
    const { orderId, cafe } = await cafeYPanSinDescuento()
    await applyManualDiscount(orderId, 'FIXED_AMOUNT', 60, 'Sesenta', staffVenueId, undefined, undefined, venueId)
    await compItems(venueId, orderId, { itemIds: [cafe.id], reason: 'Invitación', staffId })
    // 60 + 100 = 160 de descuento sobre 150 de mercancía: se cobra 0 (la cabecera topada guardaba 150).
    expect(await cabecera(orderId)).toEqual({ subtotal: 150, descuento: 160, total: 0, saldo: 0 })
    const fila = async (name: string) => (await filas(orderId)).find(f => f.name === name)!
    return { orderId, fijo: await fila('Sesenta'), cortesia: await fila('Cortesía') }
  }

  it('🔴 cortesía del café sobre una cuenta con un fijo de $60, luego quitar el fijo ⇒ se cobra el pan: $50 (con la cabecera topada, $60)', async () => {
    const { orderId, fijo } = await cafeYPanConFijoDeSesentaYCafeRegalado()
    await removeDiscountFromOrder(orderId, fijo.id, staffId, venueId)
    expect(await cabecera(orderId)).toEqual({ subtotal: 150, descuento: 100, total: 50, saldo: 50 })
  })

  it('🔴 cortesía del café sobre una cuenta con un fijo de $60, luego quitar la cortesía ⇒ $150 − $60 = $90 (con la cabecera topada, $100)', async () => {
    const { orderId, cortesia } = await cafeYPanConFijoDeSesentaYCafeRegalado()
    await removeDiscountFromOrder(orderId, cortesia.id, staffId, venueId)
    expect((await renglonDe(orderId, cafeId)).isCortesia).toBe(false)
    expect(await cabecera(orderId)).toEqual({ subtotal: 150, descuento: 60, total: 90, saldo: 90 })
  })
})

describe('R11 (Codex r5 #2): una cuenta importada de SoftRestaurant no se rearma desde Avoqado; sólo se cobra', () => {
  const foto = async (orderId: string) => {
    const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true, orderDiscounts: true } })
    return {
      status: o.status,
      subtotal: Number(o.subtotal),
      impuesto: Number(o.taxAmount),
      total: Number(o.total),
      renglones: o.items.length,
      filas: o.orderDiscounts.length,
    }
  }
  const cafeYPanImportados = () =>
    importadaDeSoftRestaurant([
      { productId: cafeId, cantidad: 1, precioConIva: 116, ivaPorPieza: 16 },
      { productId: panId, cantidad: 1, precioConIva: 58, ivaPorPieza: 8 },
    ]) // cabecera: subtotal 150, IVA 24, total 174
  const nativa = async () =>
    (
      await crearEnTerminal(venueId, {
        items: [{ productId: llaveroId, quantity: 1, unitPrice: 100 }],
        staffId,
        taxAmount: 0,
        subtotal: 100,
        total: 100,
        tip: 0,
      } as any)
    ).id
  const ids = async (orderId: string) =>
    (await prisma.orderItem.findMany({ where: { orderId }, select: { id: true }, take: 10 })).map(i => i.id)

  const operaciones: Array<[string, (orderId: string) => Promise<unknown>]> = [
    ['borrar el café (la v5 cobraba $66)', async id => removeOrderItem(venueId, id, (await renglonDe(id, cafeId)).id, await version(id))],
    [
      'anular el café',
      async id =>
        voidItems(venueId, id, {
          itemIds: [(await renglonDe(id, cafeId)).id],
          reason: 'Error de captura',
          staffId,
          expectedVersion: await version(id),
        }),
    ],
    [
      'anular todo',
      async id =>
        voidItems(venueId, id, { itemIds: await ids(id), reason: 'Error de captura', staffId, expectedVersion: await version(id) }),
    ],
    ['agregar un artículo', async id => addItemsToOrder(venueId, id, [{ productId: llaveroId, quantity: 1 }], await version(id))],
    [
      'regalar el café desde la terminal',
      async id => compItems(venueId, id, { itemIds: [(await renglonDe(id, cafeId)).id], reason: 'Invitación', staffId }),
    ],
    [
      'regalar el café desde el móvil',
      async id => compOrderItem({ venueId, orderId: id, itemId: (await renglonDe(id, cafeId)).id, reason: 'Amigos y familia', staffId }),
    ],
    ['separar el café', async id => splitOrderItems(venueId, id, [(await renglonDe(id, cafeId)).id], staffId)],
    ['fusionarla en otra cuenta', async id => mergeOrders(venueId, await nativa(), id, staffId)],
    ['fusionar otra cuenta en ella', async id => mergeOrders(venueId, id, await nativa(), staffId)],
    ['un descuento manual', async id => applyManualDiscount(id, 'FIXED_AMOUNT', 10, 'Diez', staffVenueId, undefined, undefined, venueId)],
    [
      'el descuento heredado de la terminal',
      async id => applyDiscountHeredado(venueId, id, { type: 'FIXED_AMOUNT', value: 10, staffId, expectedVersion: await version(id) }),
    ],
  ]

  it.each(operaciones)('🔴 R11: %s sobre una importada se rechaza con la causa y no mueve nada', async (_op, correr) => {
    const id = await cafeYPanImportados()
    await expect(correr(id)).rejects.toMatchObject({ code: 'ORDEN_IMPORTADA_DEL_POS' })
    expect(await foto(id)).toEqual({ status: 'CONFIRMED', subtotal: 150, impuesto: 24, total: 174, renglones: 2, filas: 0 })
  })

  it('🔴 R11: el último renglón de dos piezas ($116 c/u, impuesto unitario 16, cabecera 32) no se borra (la v5 retiraba 16 y dejaba $16 cobrables sin artículos)', async () => {
    const id = await importadaDeSoftRestaurant([{ productId: cafeId, cantidad: 2, precioConIva: 116, ivaPorPieza: 16 }])
    await expect(removeOrderItem(venueId, id, (await renglonDe(id, cafeId)).id, await version(id))).rejects.toMatchObject({
      code: 'ORDEN_IMPORTADA_DEL_POS',
    })
    expect(await foto(id)).toEqual({ status: 'CONFIRMED', subtotal: 200, impuesto: 32, total: 232, renglones: 1, filas: 0 })
  })

  it('🔴 R11: lo automático no truena sobre una importada, pero tampoco la toca (un descuento automático activo: nada aplicado)', async () => {
    const auto = await prisma.discount.create({
      data: { venueId, name: `Auto R11 ${randomUUID()}`, type: 'FIXED_AMOUNT', value: 5, scope: 'ORDER', isAutomatic: true },
    })
    try {
      const id = await cafeYPanImportados()
      expect(await applyAutomaticDiscounts(id, staffVenueId, venueId)).toEqual({ applied: [], total: 0 })
      expect(await syncAutomaticServiceCharges(venueId, id)).toBeNull()
      expect(await foto(id)).toEqual({ status: 'CONFIRMED', subtotal: 150, impuesto: 24, total: 174, renglones: 2, filas: 0 })
    } finally {
      await prisma.discount.update({ where: { id: auto.id }, data: { active: false } })
    }
  })

  it('control — R11: cobrar una importada sigue igual ($174, con su IVA aparte por P12)', async () => {
    const id = await cafeYPanImportados()
    await payCashOrder(venueId, id, { amount: 17400, tip: 0, staffId, idempotencyKey: `sr-${id}` })
    const o = await prisma.order.findUniqueOrThrow({ where: { id } })
    expect([o.paymentStatus, Number(o.remainingBalance)]).toEqual(['PAID', 0])
  })
})

describe('Codex r5 #3: fusionar deja el origen en impuesto 0 y su IVA pasa al destino', () => {
  it('🔴 origen café $100 + IVA 16 aparte, destino pan con IVA incluido: origen CANCELADO en 0 y sin nada que cobrar; destino DESCONOCIDO con IVA 16 y total $166 (la v5: el origen guardaba 16 y el destino quedaba en $150)', async () => {
    const origen = await crearEnTerminal(venueId, {
      items: [{ productId: cafeId, quantity: 1, unitPrice: 100 }],
      staffId,
      taxAmount: 0,
      subtotal: 100,
      total: 100,
      tip: 0,
    } as any)
    await prisma.orderItem.updateMany({ where: { orderId: origen.id }, data: { taxAmount: 16 } })
    await prisma.order.update({
      where: { id: origen.id },
      data: { contratoDePrecio: 'IVA_APARTE', taxAmount: 16, total: 116, remainingBalance: 116 },
    })
    const destino = await crearEnTerminal(venueId, {
      items: [{ productId: panId, quantity: 1, unitPrice: 50 }],
      staffId,
      taxAmount: 0,
      subtotal: 50,
      total: 50,
      tip: 0,
    } as any)
    await mergeOrders(venueId, destino.id, origen.id, staffId)
    const o = await prisma.order.findUniqueOrThrow({ where: { id: origen.id } })
    const d = await prisma.order.findUniqueOrThrow({ where: { id: destino.id } })
    expect([o.status, Number(o.taxAmount), Number(o.total)]).toEqual(['CANCELLED', 0, 0])
    expect([d.contratoDePrecio, Number(d.taxAmount), Number(d.subtotal), Number(d.total)]).toEqual(['DESCONOCIDO', 16, 150, 166])
    expect(Number(computeOrderBalance(d, []).remainingBalance)).toBe(166)
    // R-5: el origen cancelado no tiene nada que cobrar, y un cobro EN VIVO sobre él se rechaza por su causa exacta (Tarea 6a)
    // sin registrar nada — nunca `.catch(() => null)`, que también pasaría si el cobro tronara por otra razón.
    expect(Number(computeOrderBalance(o, []).remainingBalance)).toBe(0)
    await expect(
      payCashOrder(venueId, origen.id, { amount: 1600, tip: 0, staffId, idempotencyKey: `fusion-${origen.id}` }),
    ).rejects.toMatchObject({
      code: 'ORDER_CANCELLED_NO_NEW_CHARGE',
    })
    expect(await prisma.payment.count({ where: { orderId: origen.id } })).toBe(0)
  })
})

describe('D16: la reducción sigue al reparto y vuelve al quitar (B2b)', () => {
  let aguaId: string
  beforeAll(async () => {
    const categoria = await prisma.menuCategory.findFirstOrThrow({ where: { venueId } })
    aguaId = (await prisma.product.create({ data: { venueId, categoryId: categoria.id, name: 'Agua', sku: 'B2B-AGUA', price: 100 } })).id
  })

  /** Café $100 con IVA $16 aparte y un descuento del motor de $10: de cuenta ($10 fijos) o dirigido (10 % del café). */
  async function ordenConImpuestoAparte(alcance: 'CUENTA' | 'DIRIGIDO' = 'CUENTA') {
    const o = await crearEnTerminal(venueId, {
      items: [{ productId: cafeId, quantity: 1, unitPrice: 100 }],
      staffId,
      taxAmount: 0,
      subtotal: 100,
      total: 100,
      tip: 0,
    } as any)
    await prisma.orderItem.updateMany({ where: { orderId: o.id }, data: { taxAmount: 16 } })
    await prisma.order.update({ where: { id: o.id }, data: { contratoDePrecio: 'IVA_APARTE', taxAmount: 16 } })
    const diez = await prisma.discount.create({
      data:
        alcance === 'CUENTA'
          ? { venueId, name: `$10 D16 ${o.id}`, type: 'FIXED_AMOUNT', value: 10, scope: 'ORDER', applyBeforeTax: true }
          : {
              venueId,
              name: `10 % café D16 ${o.id}`,
              type: 'PERCENTAGE',
              value: 10,
              scope: 'ITEM',
              targetItemIds: [cafeId],
              applyBeforeTax: true,
            },
    })
    const { applyDiscountToOrder } = await import('@/services/dashboard/discountEngine.service')
    expect(await applyDiscountToOrder(o.id, diez.id, staffVenueId, undefined, venueId)).toMatchObject({ success: true, amount: 10 })
    return o.id
  }
  const impuesto = async (orderId: string) => Number((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).taxAmount)

  it.each(['motor', 'móvil'] as const)(
    'aplicar (1.60) → entra un renglón exento (0.80) → quitar desde %s ⇒ el impuesto vuelve a 16',
    async camino => {
      const orderId = await ordenConImpuestoAparte()
      let [fila] = await filas(orderId)
      expect(Number(fila.taxReduction)).toBe(1.6)
      expect(await impuesto(orderId)).toBe(14.4)
      expect((await cabecera(orderId)).total).toBe(104.4) // 100 − 10 + 14.40 de IVA aparte

      const { version } = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { version: true } })
      await addItemsToOrder(venueId, orderId, [{ productId: aguaId, quantity: 1 }], version) // el renglón nuevo nace con impuesto 0
      ;[fila] = await filas(orderId)
      expect(Number(fila.amount)).toBe(10) // importe comercial intacto
      expect(Number(fila.taxReduction)).toBe(0.8)
      expect(await impuesto(orderId)).toBe(15.2)
      expect((await cabecera(orderId)).total).toBe(205.2) // P12: 200 − 10 + 15.20 (antes de P12 el recálculo guardaba 190)

      if (camino === 'motor') await removeDiscountFromOrder(orderId, fila.id, staffId, venueId)
      else await removeOrderDiscount(venueId, orderId, fila.id, staffId)
      expect(await filas(orderId)).toEqual([])
      expect(await impuesto(orderId)).toBe(16)
      expect((await cabecera(orderId)).total).toBe(216) // por los dos caminos (antes de la Tarea 5 el móvil guardaba 200)
    },
  )

  it.each(['CUENTA', 'DIRIGIDO'] as const)(
    '🔴 Codex r3 V3: un descuento %s nuevo resta el IVA UNA vez — 16 → 14.40 (total 104.40) → quitar ⇒ 16 (total 116)',
    async alcance => {
      const orderId = await ordenConImpuestoAparte(alcance)
      const [fila] = await filas(orderId)
      expect(fila.reparto).toMatchObject({ alcance, reduceImpuesto: true })
      expect(Number(fila.taxReduction)).toBe(1.6)
      expect(await impuesto(orderId)).toBe(14.4) // la v3 de este plan restaba en la sincronización Y al aplicar: 12.80
      expect((await cabecera(orderId)).total).toBe(104.4) // v3: 102.80
      await removeDiscountFromOrder(orderId, fila.id, staffId, venueId)
      expect(await impuesto(orderId)).toBe(16) // v3: 14.40
      expect((await cabecera(orderId)).total).toBe(116)
    },
  )

  it('🔴 Codex r3 V4: el café sube de 1 a 2 piezas (mismo renglón, mismo impuesto registrado) ⇒ la reducción baja a 0.80 aunque el reparto no cambie', async () => {
    const orderId = await ordenConImpuestoAparte()
    const { version } = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { version: true } })
    // La caja re-manda el carrito completo (asNewRound = false): la línea igual se FUSIONA reemplazando la cantidad, sin tocar
    // su `taxAmount` (rama de fusión de `addItemsToOrder`; la rama por `externalId` hace lo mismo).
    await addItemsToOrder(venueId, orderId, [{ productId: cafeId, quantity: 2 }], version, false)
    const cafe = await renglonDe(orderId, cafeId)
    const [fila] = await filas(orderId)
    expect([Number(cafe.total), Number(cafe.taxAmount)]).toEqual([200, 16])
    expect(fila.reparto).toMatchObject({ renglones: { [cafe.id]: 1000 } }) // el mapa NO cambió
    expect(Number(fila.taxReduction)).toBe(0.8) // 10 × 16 / 200; la v3 de este plan conservaba 1.60
    expect(await impuesto(orderId)).toBe(15.2)
    expect((await cabecera(orderId)).total).toBe(205.2) // 200 − 10 + 15.20
  })
})
