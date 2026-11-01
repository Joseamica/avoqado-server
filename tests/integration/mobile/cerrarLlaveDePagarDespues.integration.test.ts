import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createOrderWithItems as crearEnMovil } from '@/services/mobile/order.mobile.service'
import { createOrder as createTpvOrder, createOrderWithItems as createTpvOrderWithItems } from '@/services/tpv/order.tpv.service'
import { processPosOrderEvent } from '@/services/pos-sync/posSyncOrder.service'
import { liberarLlaveDePagarDespues } from '@/services/mobile/pagarDespuesLlave'
import { crearNegocioDePrueba, limpiarNegocioDePrueba } from '../giftCards/sembrarTarjetasDeRegalo'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { broadcastToUser: jest.fn(), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn(async () => undefined) }))

// D9 (tablero hz:fa2343a0:D9), contra PostgreSQL: cerrar la llave de una «Pagar después» y crear su cuenta toman el MISMO
// candado; nunca quedan la cuenta Y la venta devuelta a «Carritos guardados» (Codex plan r1 #1, r2 #1).
const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(database.hostname) || !/^\/avoqado_(?:[a-z0-9]+|cambio_r5)_test_/.test(database.pathname)) {
  throw new Error('Esta suite exige una base local aislada (avoqado_<x>_test_…), nunca av-db-25.')
}

jest.setTimeout(60000)
let venueId = ''
let staffId = ''
let cafeId = ''

beforeAll(async () => {
  ;({ venueId, staffId } = await crearNegocioDePrueba('d9-llave'))
  const category = await prisma.menuCategory.create({ data: { venueId, name: 'Cafés', slug: 'cafes' } })
  cafeId = (
    await prisma.product.create({
      data: { venueId, categoryId: category.id, sku: `${venueId}-cafe`, name: 'Café', price: new Prisma.Decimal(100) },
    })
  ).id
})

afterAll(async () => {
  if (venueId) {
    await prisma.orderKeyRelease.deleteMany({ where: { venueId } })
    await limpiarNegocioDePrueba(venueId)
  }
  await prisma.$disconnect()
})

const venta = (externalId: string) => ({ staffId, externalId, items: [{ productId: cafeId, quantity: 1 }], source: 'AVOQADO_ANDROID' }) as never
const cuentas = (externalId: string) => prisma.order.count({ where: { venueId, externalId } })
const cerradas = (externalId: string) => prisma.orderKeyRelease.count({ where: { venueId, externalId } })

describe('D9 · cerrar la llave de «Pagar después»', () => {
  it('cerrada la llave, la cuenta ya no nace (409 ORDER_KEY_RELEASED), y cerrarla otra vez sigue diciendo released', async () => {
    const llave = `pay-later:${venueId}-1`
    await expect(liberarLlaveDePagarDespues(venueId, llave, staffId)).resolves.toEqual({ released: true })

    await expect(crearEnMovil(venueId, venta(llave))).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_KEY_RELEASED' })
    expect(await cuentas(llave)).toBe(0)
    await expect(liberarLlaveDePagarDespues(venueId, llave, staffId)).resolves.toEqual({ released: true })
    expect(await cerradas(llave)).toBe(1)
  })

  it('si la cuenta ya existe (la respuesta se perdió), la devuelve y no cierra nada', async () => {
    const llave = `pay-later:${venueId}-2`
    const creada = await crearEnMovil(venueId, venta(llave))

    await expect(liberarLlaveDePagarDespues(venueId, llave, staffId)).resolves.toEqual({
      released: false,
      order: expect.objectContaining({ id: creada.id, total: 100 }),
    })
    expect(await cerradas(llave)).toBe(0)
  })

  it('crear y cerrar al mismo tiempo: queda la cuenta o la llave cerrada, nunca las dos', async () => {
    for (let i = 0; i < 6; i++) {
      const llave = `pay-later:${venueId}-c${i}`
      const [crear, cerrar] = await Promise.allSettled([crearEnMovil(venueId, venta(llave)), liberarLlaveDePagarDespues(venueId, llave, staffId)])

      expect((await cuentas(llave)) + (await cerradas(llave))).toBe(1)
      if (cerrar.status === 'fulfilled' && cerrar.value.released) {
        expect(crear).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ code: 'ORDER_KEY_RELEASED' }) })
      } else {
        expect(crear.status).toBe('fulfilled')
      }
    }
  })

  it('las otras entradas (TPV, SoftRestaurant) no aceptan una llave de «Pagar después»', async () => {
    const llave = `pay-later:${venueId}-3`
    for (const crear of [
      () => createTpvOrder(venueId, { externalId: llave, items: [] } as never),
      () => createTpvOrderWithItems(venueId, { externalId: ` ${llave}`, items: [] } as never),
      () => processPosOrderEvent({ venueId, orderData: { externalId: llave } } as never),
    ])
      await expect(crear()).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('reservado') })
    expect(await cuentas(llave)).toBe(0)
  })
})
