/**
 * D1 «fotocopia del ticket» (28-oct), contra Postgres REAL: el cobro en efectivo de UNA parte guarda en `Payment.processorData` los
 * renglones que imprimió la app, sólo si cuadran EXACTO con lo que quedó en el pago. Nunca frena el cobro.
 * Promesa: Avoqado/docs/audit/2026-10-28-parte-por-producto/promesa.md
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { getTransactionDetail } from '@/services/mobile/transaction.mobile.service'
import { asegurarBaseDePrueba, borrarMundoComisiones, crearMundoComisiones, MundoComisiones } from '../commission/_mundoComisiones'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.mock('@/services/shared/cashDrawerPosting', () => ({
  ...jest.requireActual('@/services/shared/cashDrawerPosting'),
  postCashSaleToDrawer: jest.fn().mockResolvedValue(undefined),
}))

let m: MundoComisiones
let n = 0
beforeAll(asegurarBaseDePrueba)
beforeEach(async () => {
  m = await crearMundoComisiones('fotocopia-ticket')
})
afterEach(async () => {
  const mundo = m
  m = undefined as unknown as MundoComisiones
  await borrarMundoComisiones(mundo)
})

/** Una cuenta ABIERTA de $50 (Café $30 + Agua $20), como la deja el POS móvil antes de dividir. */
async function cuentaAbierta(): Promise<string> {
  const D = (x: number) => new Prisma.Decimal(x)
  const o = await prisma.order.create({
    data: {
      venueId: m.venueId,
      orderNumber: `${m.key}-foto-${++n}`,
      subtotal: D(50),
      discountAmount: D(0),
      taxAmount: D(0),
      total: D(50),
      paidAmount: D(0),
      remainingBalance: D(50),
      status: 'CONFIRMED',
      paymentStatus: 'PENDING',
    },
  })
  return o.id
}

const cafe = { nombre: 'Café Americano', cantidad: 1, unitarioCents: 3000, totalCents: 3000 }
const copiaDelCafe = { lineas: [cafe], subtotalCents: 3000, descuentoCents: 0 }
const guardada = async (paymentId: string) =>
  ((await prisma.payment.findUnique({ where: { id: paymentId }, select: { processorData: true } }))?.processorData ?? null) as any

describe('D1 · la copia del ticket de una parte', () => {
  it('🔴 la parte de Café ($30 de $50) guarda su copia y el detalle de la venta la devuelve', async () => {
    const orderId = await cuentaAbierta()
    const r = await payCashOrder(m.venueId, orderId, {
      amount: 3000,
      tip: 0,
      staffId: m.ana,
      idempotencyKey: `foto-1-${orderId}`,
      lineasDelTicket: copiaDelCafe,
    })
    expect((await guardada(r.paymentId))?.lineasDelTicket).toEqual(copiaDelCafe)
    const detalle = await getTransactionDetail(m.venueId, r.paymentId)
    expect(detalle.lineasDelTicket).toEqual(copiaDelCafe)
  })

  it('una copia que no cuadra con lo cobrado no se guarda, y el cobro pasa igual', async () => {
    const orderId = await cuentaAbierta()
    const r = await payCashOrder(m.venueId, orderId, {
      amount: 2500,
      tip: 0,
      staffId: m.ana,
      idempotencyKey: `foto-2-${orderId}`,
      lineasDelTicket: copiaDelCafe,
    })
    const pago = await prisma.payment.findUnique({ where: { id: r.paymentId }, select: { amount: true, status: true } })
    expect(pago?.amount.toFixed(2)).toBe('25.00')
    expect(pago?.status).toBe('COMPLETED')
    expect((await guardada(r.paymentId))?.lineasDelTicket).toBeUndefined()
  })

  it('el reintento con la misma llave no duplica el pago ni cambia la primera copia', async () => {
    const orderId = await cuentaAbierta()
    const llave = `foto-3-${orderId}`
    const r1 = await payCashOrder(m.venueId, orderId, { amount: 3000, tip: 0, staffId: m.ana, idempotencyKey: llave, lineasDelTicket: copiaDelCafe })
    const otra = { lineas: [{ ...cafe, nombre: 'Otro nombre' }], subtotalCents: 3000, descuentoCents: 0 }
    const r2 = await payCashOrder(m.venueId, orderId, { amount: 3000, tip: 0, staffId: m.ana, idempotencyKey: llave, lineasDelTicket: otra })
    expect(r2.paymentId).toBe(r1.paymentId)
    expect(await prisma.payment.count({ where: { orderId, status: 'COMPLETED' } })).toBe(1)
    expect((await guardada(r1.paymentId))?.lineasDelTicket).toEqual(copiaDelCafe)
  })

  it('control: un cobro sin copia (apps viejas) deja `processorData` como siempre', async () => {
    const orderId = await cuentaAbierta()
    const r = await payCashOrder(m.venueId, orderId, { amount: 5000, tip: 0, staffId: m.ana, idempotencyKey: `foto-4-${orderId}` })
    expect((await guardada(r.paymentId))?.lineasDelTicket).toBeUndefined()
    expect((await getTransactionDetail(m.venueId, r.paymentId)).lineasDelTicket).toBeUndefined()
  })
})
