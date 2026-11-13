/**
 * 🔴 D23 (`hz:e5ee98bc:D23`) contra Postgres REAL: la venta del cajón que escribe el SERVIDOR sale en `/cash-drawer/current` con la
 * llave EXACTA con la que el aparato mandó ese cobro.
 *
 * La prueba unitaria fija la forma con un pago simulado; ésta fija QUIÉN ESCRIBE el dato: que por los caminos de verdad del POS (la
 * cola sin red `PAY_CASH`, cuyo id es la llave, y el cobro en vivo con su `idempotencyKey`) el pago guarda esa llave y la venta del
 * cajón la devuelve. Si un camino guardara otra, el POS no reconocería su copia y la contaría dos veces.
 */
import { randomUUID } from 'crypto'
import { Prisma, StaffRole } from '@prisma/client'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn() }))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn().mockResolvedValue(undefined) }))

import prisma from '@/utils/prismaClient'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { processIntents } from '@/services/mobile/sync.mobile.service'
import { getCurrentSession } from '@/services/mobile/cash-drawer.mobile.service'

jest.setTimeout(90_000)

const fixture = `d23-${randomUUID().slice(0, 8)}`
let venueId: string
let staffId: string
let productId: string
let seq = 0

beforeAll(async () => {
  const organizationId = (await prisma.organization.create({ data: { name: fixture, email: `${fixture}@example.test`, phone: '' } })).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId, name: fixture, slug: fixture, type: 'RESTAURANT', status: 'TRIAL', timezone: 'America/Mexico_City' },
    })
  ).id
  await prisma.venueSettings.create({ data: { venueId, enableShifts: false, requirePinLogin: false } })
  staffId = (await prisma.staff.create({ data: { email: `caja-${fixture}@staff.test`, firstName: 'Caja', lastName: 'D3', active: true } }))
    .id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: StaffRole.OWNER } })
  const categoryId = (await prisma.menuCategory.create({ data: { venueId, name: 'Barra', slug: `barra-${fixture}` } })).id
  productId = (
    await prisma.product.create({
      data: { venueId, categoryId, name: 'Café', sku: `CAFE-${fixture}`, price: new Prisma.Decimal(300) },
    })
  ).id
  await prisma.cashDrawerSession.create({
    data: {
      venueId,
      openedByStaffId: staffId,
      openedByName: 'Caja D3',
      startingAmount: new Prisma.Decimal(0),
      openedAt: new Date(Date.now() - 60_000),
    },
  })
})

afterAll(async () => {
  // La base de CI la comparten todas las suites: los efectos que deja ESTE negocio no los debe reclamar el worker de otra.
  await prisma.paymentEffect.deleteMany({ where: { venueId } })
  await prisma.$disconnect()
})

const params = (intents: any[]) => ({ venueId, staffId, deviceId: `device-${fixture}`, intents, authorizeIntent: () => true })
const pausa = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Abre una mesa con un café de $300 por la cola (como el POS sin red) y devuelve su orden y su id local. */
async function mesa(): Promise<{ orderId: string; localOrderId: string }> {
  const table = await prisma.table.create({ data: { venueId, number: randomUUID().slice(0, 6), capacity: 2, qrCode: randomUUID() } })
  const localOrderId = randomUUID()
  const [abierta, pedido] = await processIntents(
    params([
      { id: randomUUID(), seq: ++seq, type: 'OPEN_TABLE', payload: { tableId: table.id, covers: 1, localOrderId } },
      { id: randomUUID(), seq: ++seq, type: 'ADD_ITEMS', payload: { localOrderId, items: [{ productId, quantity: 1 }] } },
    ]),
  )
  expect([abierta.status, pedido.status]).toEqual(['ACKED', 'ACKED'])
  return { orderId: String(abierta.result!.orderId), localOrderId }
}

/** La venta del cajón de esa orden en `/current` (se escribe después del commit del cobro: se espera a que aparezca). */
async function ventaDelCajon(orderId: string) {
  for (let i = 0; i < 60; i++) {
    const caja = await getCurrentSession(venueId, true)
    const venta = (caja?.events as any[] | undefined)?.find(e => e.type === 'CASH_SALE' && e.orderId === orderId)
    if (venta) return venta
    await pausa(50)
  }
  throw new Error(`La venta de ${orderId} no llegó al cajón`)
}

describe('D23 · la venta del cajón trae la llave con la que el aparato mandó el cobro', () => {
  it('🔴 cola sin red: PAY_CASH ⇒ la llave es el id del intent', async () => {
    const { orderId, localOrderId } = await mesa()
    const K = randomUUID()

    const [ack] = await processIntents(
      params([{ id: K, seq: ++seq, type: 'PAY_CASH', payload: { localOrderId, amountCents: 30000, tipCents: 0 } }]),
    )

    expect(ack.status).toBe('ACKED')
    expect(await ventaDelCajon(orderId)).toMatchObject({
      amount: 300,
      localId: expect.stringMatching(/^srv-cash-sale:/),
      paymentIdempotencyKey: K,
    })
  })

  it('🔴 en vivo: payCashOrder con su idempotencyKey ⇒ esa llave', async () => {
    const { orderId } = await mesa()
    const K = randomUUID()

    await payCashOrder(venueId, orderId, { amount: 30000, tip: 0, staffId, idempotencyKey: K })

    expect((await ventaDelCajon(orderId)).paymentIdempotencyKey).toBe(K)
  })
})
