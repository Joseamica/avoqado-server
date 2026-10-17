/**
 * La cuenta de tarjetas contra Postgres REAL (Tarea A5): nace con sus sobres PENDING sin encender la marca de IVA mixto,
 * deduplica por llave, no admite descuentos aunque los pida una app vieja, y cancelarla sin cobrar desactiva sus sobres.
 *
 * Correr: source ../urls-tarjetas.sh && TZ=UTC npx jest --selectProjects integration \
 *   --runTestsByPath tests/integration/giftCards/cuentaDeTarjetas.integration.test.ts --ci --runInBand
 *
 * El plan (`GIFT_CARDS`) lo registra C2: aquí `venueHasFeatureAccess` se fija en `true`. La libreta no se borra (trigger):
 * la base es desechable y este archivo no limpia.
 */
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))

import prisma from '@/utils/prismaClient'
import { createGiftCardOrder } from '@/services/giftCards/giftCardOrder.service'
import { applyOrderDiscount, cancelOrder } from '@/services/mobile/order.mobile.service'
import { deleteOrder, updateOrder } from '@/services/dashboard/order.dashboard.service'
import { limpiarNegocioDePrueba } from './sembrarTarjetasDeRegalo'

jest.setTimeout(60000)

const SUF = `cuenta-${process.pid}-${Date.now()}`
let orgId: string
let venueId: string
let staffId: string

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: SUF, email: `${SUF}@example.test`, phone: '5500000000' } })).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: SUF, slug: SUF } })).id
  staffId = (await prisma.staff.create({ data: { email: `${SUF}@staff.test`, firstName: 'Caja', lastName: 'QA', active: true } })).id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'CASHIER', active: true } })
  await prisma.giftCardSettings.create({ data: { venueId, enabled: true, suggestedAmounts: [500, 1000, 2000] } })
})

// Cierre (punto 16): sus órdenes no se quedan en la base desechable para el barrido de otras suites.
afterAll(async () => {
  await limpiarNegocioDePrueba(venueId)
})

const venta = (llave: string, montos: number[]) =>
  createGiftCardOrder(venueId, staffId, {
    idempotencyKey: llave,
    purchaserName: 'Ana',
    sobres: montos.map(amount => ({ amount, deliveryChannel: 'PRINTED' as const })),
  })

describe('cuenta de tarjetas · Postgres real', () => {
  it('nace con un sobre PENDING por tarjeta, líneas NO_OBJETO sin producto, y NO enciende la marca de IVA mixto', async () => {
    const r = await venta(`${SUF}-a`, [500, 1000])
    const cuenta = await prisma.order.findUniqueOrThrow({ where: { id: r.orderId }, include: { items: { include: { giftCard: true } } } })
    expect(cuenta.total.toFixed(2)).toBe('1500.00')
    expect(
      cuenta.items.map(i => [i.productId, i.ivaTratamiento, i.taxAmount.toFixed(2), i.giftCard?.status, i.giftCard?.balance.toFixed(2)]),
    ).toEqual([
      [null, 'NO_OBJETO', '0.00', 'PENDING', '0.00'],
      [null, 'NO_OBJETO', '0.00', 'PENDING', '0.00'],
    ])
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).ivaMixtoAlgunaVez).toBe(false)
  })

  it('la misma llave devuelve la misma cuenta y los mismos códigos; con otro contenido, IDEMPOTENCY_KEY_REUSED', async () => {
    const a = await venta(`${SUF}-b`, [700])
    const b = await venta(`${SUF}-b`, [700])
    expect(b).toMatchObject({ replay: true, orderId: a.orderId })
    expect(b.sobres.map(s => s.codigo)).toEqual(a.sobres.map(s => s.codigo))
    await expect(venta(`${SUF}-b`, [800])).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
    expect(await prisma.giftCard.count({ where: { venueId, initialAmount: 700 } })).toBe(1)
  })

  it('🔴 no admite descuentos (lo pida quien lo pida): GIFT_CARD_ORDER_IMMUTABLE y la cuenta no cambia', async () => {
    const r = await venta(`${SUF}-c`, [500])
    await expect(applyOrderDiscount(venueId, r.orderId, 'cualquier-descuento', staffId)).rejects.toMatchObject({
      code: 'GIFT_CARD_ORDER_IMMUTABLE',
      statusCode: 409,
    })
    const cuenta = await prisma.order.findUniqueOrThrow({ where: { id: r.orderId } })
    expect(cuenta.discountAmount.toFixed(2)).toBe('0.00')
    expect(cuenta.total.toFixed(2)).toBe('500.00')
  })

  it('cancelarla sin cobrar deja sus sobres DEACTIVATED (nunca activados) con su DEACTIVATE', async () => {
    const r = await venta(`${SUF}-d`, [500, 600])
    await cancelOrder(venueId, r.orderId, 'El cliente ya no la quiso', staffId)
    const sobres = await prisma.giftCard.findMany({ where: { venueId, id: { in: r.sobres.map(s => s.id) } }, take: 5 })
    expect(sobres.map(s => [s.status, s.activatedAt])).toEqual([
      ['DEACTIVATED', null],
      ['DEACTIVATED', null],
    ])
    const filas = await prisma.giftCardActivity.findMany({ where: { venueId, giftCardId: { in: r.sobres.map(s => s.id) } }, take: 5 })
    expect(filas.map(f => [f.type, f.reason, f.amount.toFixed(2)])).toEqual([
      ['DEACTIVATE', 'SALE_CANCELLED', '0.00'],
      ['DEACTIVATE', 'SALE_CANCELLED', '0.00'],
    ])

    // A5 r1: el reintento de la MISMA venta después de cancelarla dice que está cancelada y que sus sobres no sirven.
    const reintento = await venta(`${SUF}-d`, [500, 600])
    expect(reintento).toMatchObject({ replay: true, orderId: r.orderId, status: 'CANCELLED' })
    expect(reintento.sobres.map(s => s.status)).toEqual(['DEACTIVATED', 'DEACTIVATED'])
  })

  /** A5 r1: los dos caminos del dashboard que cancelan, sobre una cuenta de tarjetas REAL con sobres. */
  async function sobresTrasCancelar(llave: string, cancelar: (orderId: string) => Promise<unknown>) {
    const r = await venta(llave, [500, 700])
    expect(r.sobres.map(s => s.status)).toEqual(['PENDING', 'PENDING'])
    await cancelar(r.orderId)
    const sobres = await prisma.giftCard.findMany({ where: { venueId, id: { in: r.sobres.map(s => s.id) } }, take: 5 })
    const filas = await prisma.giftCardActivity.findMany({ where: { venueId, giftCardId: { in: r.sobres.map(s => s.id) } }, take: 5 })
    return {
      cuenta: (await prisma.order.findUniqueOrThrow({ where: { id: r.orderId } })).status,
      sobres: sobres.map(s => [s.status, s.balance.toFixed(2), s.activatedAt]),
      filas: filas.map(f => [f.type, f.reason, f.orderId === r.orderId]),
    }
  }

  it.each([
    ['dashboard · updateOrder a CANCELLED', (orderId: string) => updateOrder(venueId, orderId, { status: 'CANCELLED' })],
    ['dashboard · deleteOrder', (orderId: string) => deleteOrder(venueId, orderId)],
  ])('%s deja los sobres PENDING DEACTIVATED (nunca activados) con su DEACTIVATE', async (caso, cancelar) => {
    expect(await sobresTrasCancelar(`${SUF}-${caso.includes('update') ? 'u' : 'x'}`, cancelar)).toEqual({
      cuenta: 'CANCELLED',
      sobres: [
        ['DEACTIVATED', '0.00', null],
        ['DEACTIVATED', '0.00', null],
      ],
      filas: [
        ['DEACTIVATE', 'SALE_CANCELLED', true],
        ['DEACTIVATE', 'SALE_CANCELLED', true],
      ],
    })
  })
})
