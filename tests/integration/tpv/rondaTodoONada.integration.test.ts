/**
 * 🔴 DINERO — `addItemsToOrder` es TODO-O-NADA.
 *
 * Antes escribía los renglones de la ronda uno por uno, sin transacción, y sólo al final hacía el CAS de la versión de
 * la orden. Si el CAS perdía (otro aparato movió la orden entre la lectura y la escritura), si una validación reventaba
 * a media ronda (el peso, 400) o si la base fallaba (500), los renglones YA escritos se quedaban con los totales viejos.
 * El siguiente recálculo los sumaba, y un cliente que reintenta SIN llaves por renglón (la caja de Windows, la PAX, las
 * apps viejas de Android/iOS) volvía a mandar la ronda entera: platillos cobrados dos veces.
 *
 * Integración contra Postgres real (`TEST_DATABASE_URL`, nunca `av-db-25`): la atomicidad no se demuestra con mocks.
 */
import prisma from '@/utils/prismaClient'
import * as kds from '@/services/kds/kitchenDisplayStations'
import * as cargos from '@/services/shared/serviceCharges'
import { addItemsToOrder } from '@/services/tpv/order.tpv.service'

const SUF = `todo-o-nada-${Date.now()}`
let orgId: string
let venueId: string
let taco: string
let polloPorKilo: string
let n = 0

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Todo o nada ${SUF}`, email: `${SUF}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `V ${SUF}`, slug: `v-${SUF}` } })).id
  const categoryId = (await prisma.menuCategory.create({ data: { venueId, name: 'Comida', slug: `comida-${SUF}` } })).id
  taco = (await prisma.product.create({ data: { venueId, categoryId, sku: `taco-${SUF}`, name: 'Taco', price: 50 } })).id
  polloPorKilo = (
    await prisma.product.create({ data: { venueId, categoryId, sku: `pollo-${SUF}`, name: 'Pollo', price: 200, soldByWeight: true } })
  ).id
})

afterEach(() => {
  jest.restoreAllMocks()
})

afterAll(async () => {
  if (!orgId) return
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.table.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

async function cuenta({ conMesa = false } = {}) {
  n += 1
  const tableId = conMesa
    ? (await prisma.table.create({ data: { venueId, number: `${n}`, capacity: 4, qrCode: `qr-${n}-${SUF}` } })).id
    : null
  return prisma.order.create({
    data: { venueId, orderNumber: `TN-${n}-${SUF}`, tableId, subtotal: 0, taxAmount: 0, total: 0 },
    select: { id: true },
  })
}

async function leer(orderId: string) {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  return {
    version: o.version,
    subtotal: Number(o.subtotal),
    discountAmount: Number(o.discountAmount),
    serviceChargeAmount: Number(o.serviceChargeAmount),
    total: Number(o.total),
    remainingBalance: Number(o.remainingBalance),
  }
}

const renglones = (orderId: string) => prisma.orderItem.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' }, take: 50 })

/** El defecto escribía renglones en segundo plano DESPUÉS de que la llamada ya había respondido: se les da tiempo de aterrizar. */
const dejarAterrizar = () => new Promise(resolve => setTimeout(resolve, 500))

describe('🔴 la ronda que pierde la carrera de versión no deja nada', () => {
  it.each([
    ['caja de Windows / PAX (asNewRound=false)', false],
    ['app vieja sin llaves (asNewRound=true)', true],
  ])('%s: ningún renglón huérfano, y el reintento cobra UNA sola ronda', async (_quien, asNewRound) => {
    const o = await cuenta({ conMesa: true })
    const { version: v } = await leer(o.id)
    // Otro aparato mueve la orden justo después de que esta ronda la leyó. La consulta de la pantalla de cocina corre
    // entre la lectura y la escritura: es el gancho para meter al otro aparato en ese hueco.
    jest.spyOn(kds, 'debeMarcarCocina').mockImplementationOnce(async () => {
      await prisma.order.update({ where: { id: o.id }, data: { version: { increment: 1 } } })
      return false
    })
    const ronda = [{ productId: taco, quantity: 2 }]

    await expect(addItemsToOrder(venueId, o.id, ronda, v, asNewRound)).rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 })
    await dejarAterrizar()
    expect(await renglones(o.id)).toHaveLength(0)
    expect(await leer(o.id)).toMatchObject({ version: v + 1, subtotal: 0, total: 0 })

    // El cliente reintenta la MISMA ronda (sin llaves) con la versión fresca: la cuenta trae 2 tacos, no 4.
    await addItemsToOrder(venueId, o.id, ronda, v + 1, asNewRound)
    const filas = await renglones(o.id)
    expect(filas.reduce((s, r) => s + r.quantity, 0)).toBe(2)
    expect(await leer(o.id)).toMatchObject({ version: v + 2, subtotal: 100, total: 100 })
  })

  it('dos rondas sin llaves en paralelo sobre la misma versión: gana una y la otra no deja renglones', async () => {
    const o = await cuenta()
    const { version: v } = await leer(o.id)
    const resultados = await Promise.allSettled([
      addItemsToOrder(venueId, o.id, [{ productId: taco, quantity: 1 }], v, true),
      addItemsToOrder(venueId, o.id, [{ productId: taco, quantity: 3 }], v, true),
    ])
    await dejarAterrizar()

    const perdidas = resultados.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(perdidas).toHaveLength(1)
    expect(perdidas[0].reason).toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 })
    const filas = await renglones(o.id)
    expect(filas).toHaveLength(1)
    expect(await leer(o.id)).toMatchObject({ version: v + 1, subtotal: filas[0].quantity * 50 })
  })

  it('regresión: la MISMA ronda con llaves en paralelo (en línea + réplica de la cola) ⇒ un renglón y un VERSION_CONFLICT reintentable', async () => {
    const o = await cuenta()
    const { version: v } = await leer(o.id)
    const ronda = [{ productId: taco, quantity: 2, externalId: 'sync:rk-par:0' }]
    const resultados = await Promise.allSettled([
      addItemsToOrder(venueId, o.id, ronda, v, true),
      addItemsToOrder(venueId, o.id, ronda, v, true),
    ])

    const perdidas = resultados.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(perdidas).toHaveLength(1)
    expect(perdidas[0].reason).toMatchObject({ code: 'VERSION_CONFLICT' })
    const filas = await renglones(o.id)
    expect(filas.map(f => [f.externalId, f.quantity])).toEqual([['sync:rk-par:0', 2]])
    expect(await leer(o.id)).toMatchObject({ version: v + 1, subtotal: 100 })
  })
})

describe('🔴 un error a media ronda no deja nada escrito', () => {
  it('peso inválido en el SEGUNDO renglón (400): el primero no se queda en la cuenta', async () => {
    const o = await cuenta()
    const antes = await leer(o.id)
    const ronda = [
      { productId: taco, quantity: 1 },
      { productId: polloPorKilo, quantity: 1 }, // se vende por peso y no trae peso
    ]

    await expect(addItemsToOrder(venueId, o.id, ronda, antes.version, true)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('se vende por peso'),
    })
    await dejarAterrizar()
    expect(await renglones(o.id)).toHaveLength(0)
    expect(await leer(o.id)).toEqual(antes)
  })

  it('un fallo de la base DESPUÉS de escribir la ronda deshace el renglón creado Y el actualizado', async () => {
    const o = await cuenta()
    // La cuenta ya trae 1 taco (carrito de la terminal).
    await addItemsToOrder(venueId, o.id, [{ productId: taco, quantity: 1 }], (await leer(o.id)).version, false)
    const antes = await leer(o.id)
    const [tacoAntes] = await renglones(o.id)
    // El recálculo de cargos corre DESPUÉS de escribir todos los renglones: un fallo ahí es un 500 a media escritura.
    jest.spyOn(cargos, 'recalcularCargosPorServicio').mockRejectedValueOnce(new Error('fallo simulado de la base'))

    // Carrito completo: el taco sube a 3 (ACTUALIZA su renglón) y entra medio kilo de pollo (CREA otro).
    const carrito = [
      { productId: taco, quantity: 3 },
      { productId: polloPorKilo, quantity: 1, weightQuantity: 0.5 },
    ]
    await expect(addItemsToOrder(venueId, o.id, carrito, antes.version, false)).rejects.toThrow('fallo simulado de la base')

    const filas = await renglones(o.id)
    expect(filas.map(f => [f.id, f.quantity, Number(f.total)])).toEqual([[tacoAntes.id, 1, 50]])
    expect(await leer(o.id)).toEqual(antes)
  })
})

describe('regresión: la ronda que sí se guarda', () => {
  it('recalcula y persiste el % de descuento y el % de cargo junto con la ronda', async () => {
    const o = await cuenta()
    const descuento = await prisma.orderDiscount.create({
      data: { orderId: o.id, type: 'PERCENTAGE', name: '10 %', value: 10, amount: 0 },
    })
    const cargo = await prisma.orderServiceCharge.create({
      data: { orderId: o.id, name: 'Servicio', type: 'PERCENTAGE', value: 10, amount: 0 },
    })
    const { version: v } = await leer(o.id)

    const respuesta = await addItemsToOrder(venueId, o.id, [{ productId: taco, quantity: 2 }], v, true)

    expect(respuesta).toMatchObject({ id: o.id, version: v + 1, tableName: null })
    expect(await leer(o.id)).toEqual({
      version: v + 1,
      subtotal: 100,
      discountAmount: 10,
      serviceChargeAmount: 9,
      total: 99,
      remainingBalance: 99,
    })
    expect(Number((await prisma.orderDiscount.findUniqueOrThrow({ where: { id: descuento.id } })).amount)).toBe(10)
    expect(Number((await prisma.orderServiceCharge.findUniqueOrThrow({ where: { id: cargo.id } })).amount)).toBe(9)
    const [renglon] = await renglones(o.id)
    expect(renglon.sentToKitchenAt).toBeInstanceOf(Date)
  })

  it('réplica de la MISMA ronda con llaves (la cola la reenvía): reusa sus renglones, no los duplica', async () => {
    const o = await cuenta()
    const ronda = [
      { productId: taco, quantity: 2, externalId: 'sync:rep:0' },
      { customName: 'Importe libre', customUnitPriceCents: 3000, quantity: 1, externalId: 'sync:rep:1' },
    ]
    const { version: v } = await leer(o.id)
    await addItemsToOrder(venueId, o.id, ronda, v, true)
    await addItemsToOrder(venueId, o.id, ronda, v + 1, true)

    const filas = await renglones(o.id)
    expect(filas.map(f => [f.externalId, f.quantity, Number(f.total)]).sort()).toEqual([
      ['sync:rep:0', 2, 100],
      ['sync:rep:1', 1, 30],
    ])
    expect(await leer(o.id)).toMatchObject({ version: v + 2, subtotal: 130, total: 130 })
  })

  it('carrito completo (asNewRound=false): la línea igual REEMPLAZA su cantidad, como siempre', async () => {
    const o = await cuenta()
    await addItemsToOrder(venueId, o.id, [{ productId: taco, quantity: 2 }], (await leer(o.id)).version, false)
    await addItemsToOrder(venueId, o.id, [{ productId: taco, quantity: 1 }], (await leer(o.id)).version, false)
    const filas = await renglones(o.id)
    expect(filas.map(f => [f.quantity, f.sentToKitchenAt])).toEqual([[1, null]])
    expect(await leer(o.id)).toMatchObject({ subtotal: 50, total: 50 })
  })
})
