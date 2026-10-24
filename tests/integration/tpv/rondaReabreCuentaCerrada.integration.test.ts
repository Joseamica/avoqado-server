/**
 * Cuentas fuera del plano (23-oct-2026; Codex r2 #1), contra Postgres real: el mesero abre una mesa vacía y guarda una ronda SIN RED;
 * mientras, alguien cierra esa cuenta en $0 (COMPLETED sin pagar). Al volver la red, `ADD_ITEMS` aceptaba la ronda y la cuenta
 * quedaba COMPLETED debiendo dinero: fuera del plano de todos los aparatos. Ahora una ronda sobre una cuenta CERRADA y no pagada la
 * REABRE (PENDING), igual que un cobro tardío reabre una anulada (`reabrirSiRecibeDinero`): la ronda no se pierde y la cuenta vuelve.
 *   TEST_DATABASE_URL='postgresql://…/avoqado_cuentasplano_test_20261023' \
 *     npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/tpv/rondaReabreCuentaCerrada.integration.test.ts
 * Sin limpieza a propósito: venue único en una base desechable.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { addItemsToOrder } from '@/services/tpv/order.tpv.service'
import { getTablesWithStatus } from '@/services/tpv/table.tpv.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

const target = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(target.hostname) || !/^\/avoqado_[a-z0-9]+_test_/.test(target.pathname)) {
  throw new Error('Exige una base de prueba local y desechable (p. ej. avoqado_cuentasplano_test_20261023).')
}

let venueId = ''
let taco = ''

beforeEach(async () => {
  venueId = `ronda-cerrada-${randomUUID()}`
  await prisma.organization.create({ data: { id: venueId, name: 'Ronda org', email: `${venueId}@example.test`, phone: '5500000000' } })
  await prisma.venue.create({ data: { id: venueId, organizationId: venueId, name: 'Ronda', slug: venueId } })
  const categoryId = (await prisma.menuCategory.create({ data: { venueId, name: 'Comida', slug: `comida-${venueId}` } })).id
  taco = (await prisma.product.create({ data: { venueId, categoryId, sku: `taco-${venueId}`, name: 'Taco', price: 50 } })).id
})

afterAll(() => prisma.$disconnect())

async function cuentaCerradaEnMesa(paymentStatus: 'PENDING' | 'PAID') {
  const mesa = await prisma.table.create({ data: { venueId, number: '1', capacity: 4, qrCode: randomUUID() } })
  const o = await prisma.order.create({
    data: { venueId, tableId: mesa.id, orderNumber: randomUUID(), status: 'COMPLETED', paymentStatus, subtotal: 0, taxAmount: 0, total: 0 },
  })
  await prisma.table.update({ where: { id: mesa.id }, data: { currentOrderId: o.id, status: 'OCCUPIED' } })
  return o
}

describe('una ronda tardía sobre una cuenta cerrada sin pagar', () => {
  it('la reabre con su ronda, deja rastro y la cuenta vuelve al plano', async () => {
    const o = await cuentaCerradaEnMesa('PENDING')
    await addItemsToOrder(venueId, o.id, [{ productId: taco, quantity: 2 }], o.version, true)

    const despues = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(despues.status).toBe('PENDING')
    expect(despues.completedAt).toBeNull()
    expect(Number(despues.total)).toBe(100)
    const rastro = await prisma.activityLog.findMany({ where: { venueId, entityId: o.id, action: 'ORDER_REOPENED_BY_LATE_ROUND' } })
    expect(rastro).toHaveLength(1)
    const mesas = await getTablesWithStatus(venueId)
    expect(mesas[0].openOrders?.map(x => x.id)).toEqual([o.id])
  })

  it('regresión: una cuenta PAGADA sigue rechazando la ronda', async () => {
    const o = await cuentaCerradaEnMesa('PAID')
    await expect(addItemsToOrder(venueId, o.id, [{ productId: taco, quantity: 1 }], o.version, true)).rejects.toMatchObject({
      message: 'Cannot add items to a paid order',
    })
  })
})
