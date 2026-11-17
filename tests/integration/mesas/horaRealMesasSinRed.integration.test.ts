/**
 * D93 (encargo 18cc7f, founder 16-nov «B», como Square) — la cola de mesas sin red guarda la hora del aparato, SÓLO para reportes.
 * Postgres REAL, por el reducer de verdad (`processIntents`).
 *
 * Abrir la mesa (OPEN_TABLE), cobrarla (PAY_CASH), separar su cuenta (SPLIT_ORDER) y la ronda tardía que cae en cuenta aparte (D7):
 * cada cuenta y cada cobro que NACE de la cola lleva `clientCreatedAt` (la hora del aparato, dentro de 24 h). `createdAt` sigue siendo
 * la llegada (lo que leen el corte, los turnos y demás reglas de dinero). En línea, nada.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { processIntents } from '@/services/mobile/sync.mobile.service'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { assignTable, clearTable } from '@/services/tpv/table.tpv.service'
import { addItemsToOrder } from '@/services/tpv/order.tpv.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
jest.setTimeout(60_000)

const fixture = `d93-${randomUUID().slice(0, 8)}`
let venueId: string
let mesera: string
let caja: string
let coca: string
let seq = 0
const aparato = `samsung-${fixture}`

const replay = (intents: any[]) => processIntents({ venueId, staffId: mesera, deviceId: aparato, intents, authorizeIntent: () => true })
const hace = (ms: number) => Date.now() - ms
const intent = (type: string, payload: Record<string, unknown>, createdAtLocal?: number) => ({
  id: randomUUID(),
  seq: ++seq,
  type,
  payload,
  ...(createdAtLocal === undefined ? {} : { createdAtLocal }),
})

async function mesa(): Promise<string> {
  return (await prisma.table.create({ data: { venueId, number: randomUUID().slice(0, 6), capacity: 4, qrCode: randomUUID() } })).id
}
const horasDe = async (orderId: string) =>
  prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { createdAt: true, clientCreatedAt: true } })

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: fixture, email: `${fixture}@example.test`, phone: '' } })
  venueId = (
    await prisma.venue.create({ data: { organizationId: org.id, name: fixture, slug: fixture, type: 'RESTAURANT', status: 'TRIAL' } })
  ).id
  await prisma.venueSettings.create({ data: { venueId, enableShifts: false, requirePinLogin: false } })
  mesera = (await prisma.staff.create({ data: { email: `m-${fixture}@staff.test`, firstName: 'Mesera', lastName: 'Uno', active: true } }))
    .id
  caja = (await prisma.staff.create({ data: { email: `c-${fixture}@staff.test`, firstName: 'Caja', lastName: 'Dos', active: true } })).id
  await prisma.staffVenue.createMany({
    data: [
      { venueId, staffId: mesera, role: 'WAITER' },
      { venueId, staffId: caja, role: 'OWNER' },
    ],
  })
  const cat = await prisma.menuCategory.create({ data: { venueId, name: 'Bebidas', slug: `bebidas-${fixture}` } })
  coca = (await prisma.product.create({ data: { venueId, categoryId: cat.id, name: 'Coca', sku: `C-${fixture}`, price: 25 } })).id
})
afterAll(async () => {
  await prisma.$disconnect()
}) // Se conservan las filas únicas de esta corrida como evidencia.

describe('D93 · la cola de mesas guarda la hora del aparato (sólo reportes)', () => {
  it('abrir, pedir, separar y cobrar sin red: la cuenta, la hija y el cobro llevan su hora del aparato; createdAt es la llegada', async () => {
    const t = await mesa()
    const local = randomUUID()
    const hija = randomUUID()
    const abierta = hace(30 * 60_000)
    const cobrada = hace(10 * 60_000)
    const antes = Date.now()
    const acks = await replay([
      intent('OPEN_TABLE', { tableId: t, covers: 2, localOrderId: local }, abierta),
      intent(
        'ADD_ITEMS',
        {
          localOrderId: local,
          items: [
            { productId: coca, quantity: 1, externalId: `l1-${fixture}` },
            { productId: coca, quantity: 1, externalId: `l2-${fixture}` },
          ],
        },
        hace(25 * 60_000),
      ),
      intent('SPLIT_ORDER', { localOrderId: local, itemRefs: [{ externalId: `l2-${fixture}` }], newLocalOrderId: hija }, hace(20 * 60_000)),
      intent('PAY_CASH', { localOrderId: local, amountCents: 2500, tipCents: 0, method: 'CASH' }, cobrada),
    ])
    expect(acks.map(a => a.status)).toEqual(['ACKED', 'ACKED', 'ACKED', 'ACKED'])

    const madre = String((acks[0].result as any).orderId)
    const separada = String((acks[2].result as any).createdOrderId)
    const m = await horasDe(madre)
    expect(m.clientCreatedAt?.getTime()).toBe(abierta)
    expect(m.createdAt.getTime()).toBeGreaterThanOrEqual(antes - 1000) // la llegada, no la del aparato
    // La hija es la misma comida: hereda la hora del aparato de su origen.
    expect((await horasDe(separada)).clientCreatedAt?.getTime()).toBe(abierta)
    const pago = await prisma.payment.findFirstOrThrow({ where: { orderId: madre }, select: { createdAt: true, clientCreatedAt: true } })
    expect(pago.clientCreatedAt?.getTime()).toBe(cobrada)
    expect(pago.createdAt.getTime()).toBeGreaterThanOrEqual(antes - 1000)
  })

  it('la ronda tardía que cae en cuenta aparte (D7) lleva la hora en que se pidió sin red', async () => {
    const t = await mesa()
    const cobrada = (await assignTable(venueId, t, mesera, 2)).order.id
    const v = await prisma.order.findUniqueOrThrow({ where: { id: cobrada }, select: { version: true } })
    await addItemsToOrder(venueId, cobrada, [{ productId: coca, quantity: 1 }] as any, v.version, true)
    await payCashOrder(venueId, cobrada, { amount: 2500, tip: 0, staffId: caja, idempotencyKey: `caja-${cobrada}` })
    await clearTable(venueId, t)

    const pedida = hace(5 * 60_000)
    const [ack] = await replay([intent('ADD_ITEMS', { orderId: cobrada, items: [{ productId: coca, quantity: 1 }] }, pedida)])
    expect(ack.status).toBe('ACKED')
    const aparte = String((ack.result as any).cuentaAparte?.orderId)
    expect((await horasDe(aparte)).clientCreatedAt?.getTime()).toBe(pedida)
    // La cuenta que abrió la caja con internet no lleva hora del aparato.
    expect((await horasDe(cobrada)).clientCreatedAt).toBeNull()
  })

  it('una hora del aparato de hace más de 24 h no se guarda (y nunca se recorta a una orilla)', async () => {
    const t = await mesa()
    const local = randomUUID()
    const [ack] = await replay([intent('OPEN_TABLE', { tableId: t, covers: 2, localOrderId: local }, hace(30 * 3_600_000))])
    expect(ack.status).toBe('ACKED')
    expect((await horasDe(String((ack.result as any).orderId))).clientCreatedAt).toBeNull()
  })
})
