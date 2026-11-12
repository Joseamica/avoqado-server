/**
 * W7 A1, rediseño B (founder, 12-nov): quitar un descuento en la TPV (`removeDiscountFromOrder`) recalcula la cuenta IGUAL que
 * quitarlo en el móvil (`removeOrderDiscount` → `recalculateOrderTotals`): las mismas filas y la misma cabecera, con los % re-derivados
 * y el tope de la cuenta. Y una fila de % de ámbito topada a $0 no se pierde al quitar uno de sus renglones (Codex r4 #1).
 * Contra PostgreSQL real, con los escritores reales de la caja.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { compItems, createOrderWithItems as crearEnTerminal, removeOrderItem } from '@/services/tpv/order.tpv.service'
import { applyDiscountToOrder, applyManualDiscount, removeDiscountFromOrder } from '@/services/dashboard/discountEngine.service'
import { payCashOrder, removeOrderDiscount } from '@/services/mobile/order.mobile.service'
import { applyServiceCharge } from '@/services/mobile/service-charge.mobile.service'

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(database.hostname) || !/^\/avoqado_(?:[a-z0-9]+|cambio_r5)_test_/.test(database.pathname)) {
  throw new Error('Esta suite exige una base local aislada (avoqado_<x>_test_…), nunca av-db-25.')
}

const venueId = `quitar-b-${randomUUID()}`
let staffId: string, staffVenueId: string, categoriaId: string
const productos: Record<string, string> = {}

const PESOS = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v).toFixed(2)
const filas = (orderId: string) => prisma.orderDiscount.findMany({ where: { orderId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
const montos = async (orderId: string) => (await filas(orderId)).map(f => [f.name, PESOS(f.amount)])
const cabecera = async (orderId: string) => {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  return { subtotal: PESOS(o.subtotal), descuento: PESOS(o.discountAmount), total: PESOS(o.total), saldo: PESOS(o.remainingBalance) }
}
const version = async (orderId: string) =>
  (await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { version: true } })).version
const renglonDe = (orderId: string, productId: string) => prisma.orderItem.findFirstOrThrow({ where: { orderId, productId } })

const quitar = {
  tpv: (orderId: string, filaId: string) => removeDiscountFromOrder(orderId, filaId, staffId, venueId),
  movil: (orderId: string, filaId: string) => removeOrderDiscount(venueId, orderId, filaId, staffId),
} as const
type Camino = keyof typeof quitar
const CAMINOS: Camino[] = ['tpv', 'movil']

beforeAll(async () => {
  await prisma.organization.create({ data: { id: venueId, name: venueId, email: `${venueId}@test.example`, phone: '5500000000' } })
  await prisma.venue.create({ data: { id: venueId, organizationId: venueId, name: venueId, slug: venueId } })
  staffId = (await prisma.staff.create({ data: { email: `${venueId}@staff.test`, firstName: 'Caja', lastName: 'B' } })).id
  staffVenueId = (await prisma.staffVenue.create({ data: { venueId, staffId, role: 'MANAGER' } })).id
  const pizzas = await prisma.menuCategory.create({ data: { venueId, name: 'Pizzas', slug: `pizzas-${venueId}` } })
  categoriaId = pizzas.id
  const otros = await prisma.menuCategory.create({ data: { venueId, name: 'Otros', slug: `otros-${venueId}` } })
  const producto = async (clave: string, categoria: string, price: number) =>
    (productos[clave] = (
      await prisma.product.create({ data: { venueId, categoryId: categoria, name: clave, sku: `B-${clave}`, price } })
    ).id)
  await producto('A', pizzas.id, 45)
  await producto('B', pizzas.id, 45)
  await producto('C', otros.id, 10)
  await producto('Combo', otros.id, 100)
  await producto('Raro', otros.id, 100.11)
  // Codex r7 #1: chicos de la misma categoría que A y B.
  await producto('Quince', pizzas.id, 15)
  await producto('Medio', pizzas.id, 0.5)
  await producto('Casi', pizzas.id, 0.99)
})

afterAll(async () => {
  const ordenes = (await prisma.order.findMany({ where: { venueId }, select: { id: true }, take: 200 })).map(o => o.id)
  await prisma.orderDiscount.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.payment.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.orderServiceCharge.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.orderAction.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.orderItem.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.order.deleteMany({ where: { id: { in: ordenes } } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.serviceCharge.deleteMany({ where: { venueId } })
  await prisma.discount.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: venueId } })
})

async function cuenta(lineas: Array<[clave: string, precio: number]>) {
  const subtotal = lineas.reduce((s, [, p]) => s + p, 0)
  const o = await crearEnTerminal(venueId, {
    items: lineas.map(([clave, precio]) => ({ productId: productos[clave], quantity: 1, unitPrice: precio })),
    staffId,
    taxAmount: 0,
    subtotal,
    total: subtotal,
    tip: 0,
  } as any)
  return o.id
}

const fila = async (orderId: string, name: string) => (await filas(orderId)).find(f => f.name === name)!
const manual = (orderId: string, tipo: 'FIXED_AMOUNT' | 'PERCENTAGE', valor: number, nombre: string) =>
  applyManualDiscount(orderId, tipo, valor, nombre, staffVenueId, undefined, 'B', venueId, true)

describe('W7 A1 · B: quitar un descuento en la TPV = quitarlo en el móvil (mismas filas, misma cabecera)', () => {
  it.each(CAMINOS)(
    'Codex r2 #1: $100 con fijo $50 + 10 %% (nace $5 sobre lo que queda) + fijo $45; quitar el $45 ⇒ el %% vuelve a $10 y se cobran $40 (%s)',
    async camino => {
      const orderId = await cuenta([['Combo', 100]])
      for (const [tipo, valor, nombre] of [
        ['FIXED_AMOUNT', 50, 'Cincuenta'],
        ['PERCENTAGE', 10, 'Diez'],
        ['FIXED_AMOUNT', 45, 'Cuarenta y cinco'],
      ] as const)
        expect(await manual(orderId, tipo, valor, nombre)).toMatchObject({ success: true })
      expect(await montos(orderId)).toEqual([
        ['Cincuenta', '50.00'],
        ['Diez', '5.00'],
        ['Cuarenta y cinco', '45.00'],
      ])

      await quitar[camino](orderId, (await fila(orderId, 'Cuarenta y cinco')).id)

      expect(await montos(orderId)).toEqual([
        ['Cincuenta', '50.00'],
        ['Diez', '10.00'],
      ])
      expect(await cabecera(orderId)).toEqual({ subtotal: '100.00', descuento: '60.00', total: '40.00', saldo: '40.00' })
    },
  )

  it.each(CAMINOS)(
    'Codex r4 #1: A $45 y B $45 (10 %% de categoría), C $10 y fijo $90; quitar C y A topa el %% a $0, y al quitar el fijo vuelve el 10 %% de B ⇒ $40.50 (%s)',
    async camino => {
      const orderId = await cuenta([
        ['A', 45],
        ['B', 45],
        ['C', 10],
      ])
      const categoria = await prisma.discount.create({
        data: {
          venueId,
          name: `10 % pizzas ${camino}`,
          type: 'PERCENTAGE',
          value: 10,
          scope: 'CATEGORY',
          targetCategoryIds: [categoriaId],
        },
      })
      expect(await applyDiscountToOrder(orderId, categoria.id, staffVenueId, undefined, venueId)).toMatchObject({
        success: true,
        amount: 9,
      })
      expect(await manual(orderId, 'FIXED_AMOUNT', 90, 'Noventa')).toMatchObject({ success: true, amount: 90 })

      await removeOrderItem(venueId, orderId, (await renglonDe(orderId, productos.C)).id, await version(orderId))
      // $9 de pizzas + $90 no caben en $90: el % (re-derivado) queda en $0.
      expect(await montos(orderId)).toEqual([
        [categoria.name, '0.00'],
        ['Noventa', '90.00'],
      ])
      await removeOrderItem(venueId, orderId, (await renglonDe(orderId, productos.A)).id, await version(orderId))
      // 🔴 r4 #1: la fila del % topada a $0 sigue (B es suyo y vale $45); antes se borraba aquí y ya no volvía.
      expect((await montos(orderId)).map(([nombre]) => nombre)).toEqual([categoria.name, 'Noventa'])

      await quitar[camino](orderId, (await fila(orderId, 'Noventa')).id)

      expect(await montos(orderId)).toEqual([[categoria.name, '4.50']])
      expect(await cabecera(orderId)).toEqual({ subtotal: '45.00', descuento: '4.50', total: '40.50', saldo: '40.50' })
    },
  )

  describe('Codex r5 #1: la TPV deja quitar con un abono (el móvil no); re-derivar nunca deja la cuenta abajo de lo ya cobrado', () => {
    /** $100 con 40 % ($40) + 40 % de lo que queda ($24) + fijo $1 = $35, y un abono de $30. */
    async function conAbono() {
      const orderId = await cuenta([['Combo', 100]])
      for (const [tipo, valor, nombre] of [
        ['PERCENTAGE', 40, 'Cuarenta A'],
        ['PERCENTAGE', 40, 'Cuarenta B'],
        ['FIXED_AMOUNT', 1, 'Uno'],
      ] as const)
        expect(await manual(orderId, tipo, valor, nombre)).toMatchObject({ success: true })
      await payCashOrder(venueId, orderId, { amount: 3000, tip: 0, staffId, idempotencyKey: `abono-${orderId}` } as any)
      return orderId
    }
    const foto = async (orderId: string) => ({
      filas: await montos(orderId),
      cabecera: await cabecera(orderId),
      cobro: (await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { paymentStatus: true } })).paymentStatus,
    })

    it('quitar el $1 re-derivaría los dos 40 % a $40 y la cuenta quedaría en $20 (< $30 cobrados) ⇒ se rechaza con la causa y nada se mueve', async () => {
      const orderId = await conAbono()
      const antes = await foto(orderId)
      expect(antes).toEqual({
        filas: [
          ['Cuarenta A', '40.00'],
          ['Cuarenta B', '24.00'],
          ['Uno', '1.00'],
        ],
        cabecera: { subtotal: '100.00', descuento: '65.00', total: '35.00', saldo: '5.00' },
        cobro: 'PARTIAL',
      })

      await expect(quitar.tpv(orderId, (await fila(orderId, 'Uno')).id)).rejects.toMatchObject({
        statusCode: 400,
        code: 'QUITAR_DESCUENTO_BAJO_LO_COBRADO',
        message: expect.stringContaining('Primero reembolsa lo cobrado'),
      })
      expect(await foto(orderId)).toEqual(antes)
    })

    it('control — con el abono, quitar un descuento que deja la cuenta arriba de lo cobrado sigue pasando en la TPV', async () => {
      const orderId = await conAbono()
      await quitar.tpv(orderId, (await fila(orderId, 'Cuarenta B')).id)
      // El 40 % que queda ya era 40 % de la cuenta: $40 + $1 de descuento, $59 de cuenta y $29 por cobrar.
      expect(await foto(orderId)).toEqual({
        filas: [
          ['Cuarenta A', '40.00'],
          ['Uno', '1.00'],
        ],
        cabecera: { subtotal: '100.00', descuento: '41.00', total: '59.00', saldo: '29.00' },
        cobro: 'PARTIAL',
      })
    })
  })

  const catalogo = (name: string, data: Partial<Prisma.DiscountUncheckedCreateInput>) =>
    prisma.discount.create({
      data: { venueId, name, type: 'PERCENTAGE', value: 10, scope: 'ORDER', ...data } as Prisma.DiscountUncheckedCreateInput,
    })

  it.each(CAMINOS)(
    'Codex r6 #1 (estado 2, aceptado por el founder): fijos de $45 a B y $44.99 a A, 10 %% de categoría nace en $0.01 (cuenta llena); quitar A y luego el fijo de B ⇒ $40.50 (%s)',
    async camino => {
      const orderId = await cuenta([
        ['A', 45],
        ['B', 45],
      ])
      const fijoB = await catalogo(`Fijo B ${camino}`, { type: 'FIXED_AMOUNT', value: 45, scope: 'ITEM', targetItemIds: [productos.B] })
      const fijoA = await catalogo(`Fijo A ${camino}`, { type: 'FIXED_AMOUNT', value: 44.99, scope: 'ITEM', targetItemIds: [productos.A] })
      const pizzas = await catalogo(`10 % pizzas r6 ${camino}`, { scope: 'CATEGORY', targetCategoryIds: [categoriaId] })
      for (const d of [fijoB, fijoA, pizzas])
        expect(await applyDiscountToOrder(orderId, d.id, staffVenueId, undefined, venueId, true)).toMatchObject({ success: true })
      expect(await montos(orderId)).toEqual([
        [fijoB.name, '45.00'],
        [fijoA.name, '44.99'],
        [pizzas.name, '0.01'],
      ])

      await removeOrderItem(venueId, orderId, (await renglonDe(orderId, productos.A)).id, await version(orderId))
      // La cuenta estaba llena y el 10 % no cupo: sobrevive (en $0, porque el fijo de B la sigue llenando).
      expect(await montos(orderId)).toEqual([
        [fijoB.name, '45.00'],
        [pizzas.name, '0.00'],
      ])

      await quitar[camino](orderId, (await fila(orderId, fijoB.name)).id)

      expect(await montos(orderId)).toEqual([[pizzas.name, '4.50']])
      expect(await cabecera(orderId)).toEqual({ subtotal: '45.00', descuento: '4.50', total: '40.50', saldo: '40.50' })
    },
  )

  it('🔴 Codex r7 #1: A $15, B $0.50 y C $0.99 regalada, 1 % de categoría ($0.15); la cuenta NO está llena: quitar A retira el %, como develop ($0.50)', async () => {
    const orderId = await cuenta([
      ['Quince', 15],
      ['Medio', 0.5],
      ['Casi', 0.99],
    ])
    await compItems(venueId, orderId, { itemIds: [(await renglonDe(orderId, productos.Casi)).id], reason: 'Invitación', staffId })
    const uno = await catalogo('1 % pizzas r7', { value: 1, scope: 'CATEGORY', targetCategoryIds: [categoriaId] })
    expect(await applyDiscountToOrder(orderId, uno.id, staffVenueId, undefined, venueId)).toMatchObject({ success: true, amount: 0.15 })

    await removeOrderItem(venueId, orderId, (await renglonDe(orderId, productos.Quince)).id, await version(orderId))

    expect((await montos(orderId)).map(([nombre]) => nombre)).not.toContain(uno.name)
    expect(await cabecera(orderId)).toMatchObject({ total: '0.50', saldo: '0.50' })
  })

  it('Codex r4 #2: $100.11, fijo $96, 5 % y servicio del 5 %; quitar el $96 da las mismas filas y la misma cabecera en la TPV y en el móvil', async () => {
    const servicio = await prisma.serviceCharge.create({ data: { venueId, name: 'Servicio', type: 'PERCENTAGE', value: 5 } })
    const preparar = async () => {
      const orderId = await cuenta([['Raro', 100.11]])
      expect(await manual(orderId, 'FIXED_AMOUNT', 96, 'Noventa y seis')).toMatchObject({ success: true })
      expect(await manual(orderId, 'PERCENTAGE', 5, 'Cinco')).toMatchObject({ success: true }) // nace sobre lo que queda
      await applyServiceCharge(venueId, orderId, servicio.id, staffId) // recalcula: el 5 % se re-deriva y se topa a lo que cabe
      expect(await montos(orderId)).toEqual([
        ['Noventa y seis', '96.00'],
        ['Cinco', '4.11'],
      ])
      return orderId
    }
    const [enTpv, enMovil] = [await preparar(), await preparar()]

    await quitar.tpv(enTpv, (await fila(enTpv, 'Noventa y seis')).id)
    await quitar.movil(enMovil, (await fila(enMovil, 'Noventa y seis')).id)

    expect(await montos(enTpv)).toEqual([['Cinco', '5.01']])
    expect(await montos(enMovil)).toEqual(await montos(enTpv))
    expect((await cabecera(enTpv)).descuento).toBe('5.01')
    expect((await cabecera(enMovil)).descuento).toBe('5.01')
  })
})
