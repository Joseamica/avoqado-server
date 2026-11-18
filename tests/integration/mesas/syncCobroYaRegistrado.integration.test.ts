/**
 * D20 (hz:72be07e6:D20) — PostgreSQL real. Un cobro de la cola (`PAY_CASH`) que YA está en la base no se contesta «rechazado».
 *
 * El servidor guarda el cobro y su huella en la misma transacción y cae antes de cerrar la reserva (queda PROCESSING). El MISMO
 * aparato lo reenvía pasados 60 s con otra persona en sesión, o sin el permiso de cobrar: antes recibía REJECTED (ACTOR_MISMATCH o
 * PERMISSION_DENIED) y la TPV/el POS lo mandaban a «Acciones rechazadas» siendo dinero registrado. Ahora recibe ESE cobro, no se
 * cobra otra vez y la reserva se cierra. Otro aparato sigue recibiendo el rechazo y la reserva queda para su dueño.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { processIntents, type MarcaDeReserva } from '@/services/mobile/sync.mobile.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
jest.setTimeout(60_000)

const MARCA: MarcaDeReserva = { protocolo: 'huella-v1', retomable: true }
const fixture = `d20-${randomUUID().slice(0, 8)}`
let venueId: string
let mesera: string
let cajera: string
let productId: string
const device = 'device-d20'
let seq = 0

const params = (intents: any[], over: Partial<{ staffId: string; deviceId: string; permiso: boolean }> = {}) => ({
  venueId,
  staffId: over.staffId ?? mesera,
  deviceId: over.deviceId ?? device,
  intents,
  authorizeIntent: () => over.permiso ?? true,
})
async function mesa(): Promise<string> {
  const t = await prisma.table.create({ data: { venueId, number: randomUUID().slice(0, 6), capacity: 4, qrCode: randomUUID() } })
  return t.id
}

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: fixture, email: `${fixture}@example.test`, phone: '' } })
  const venue = await prisma.venue.create({
    data: { organizationId: org.id, name: fixture, slug: fixture, type: 'RESTAURANT', status: 'TRIAL' },
  })
  venueId = venue.id
  await prisma.venueSettings.create({ data: { venueId, enableShifts: false, requirePinLogin: false } })
  const a = await prisma.staff.create({ data: { email: `${fixture}@mesera.test`, firstName: 'Mesera', lastName: 'D20', active: true } })
  const b = await prisma.staff.create({ data: { email: `${fixture}@cajera.test`, firstName: 'Cajera', lastName: 'D20', active: true } })
  mesera = a.id
  cajera = b.id
  await prisma.staffVenue.create({ data: { venueId, staffId: mesera, role: 'OWNER' } })
  await prisma.staffVenue.create({ data: { venueId, staffId: cajera, role: 'OWNER' } })
  const cat = await prisma.menuCategory.create({ data: { venueId, name: 'Cocina', slug: 'cocina' } })
  productId = (await prisma.product.create({ data: { venueId, categoryId: cat.id, name: 'Tacos', sku: 'D20-1', price: 120 } })).id
})
afterAll(async () => {
  await prisma.$disconnect()
}) // Se conservan las filas únicas de esta corrida como evidencia.

const open = (tableId: string, localOrderId = randomUUID()) => ({
  id: randomUUID(),
  seq: ++seq,
  type: 'OPEN_TABLE' as const,
  payload: { tableId, covers: 2, localOrderId },
})
const add = (localOrderId: string, quantity = 1) => ({
  id: randomUUID(),
  seq: ++seq,
  type: 'ADD_ITEMS' as const,
  payload: { localOrderId, items: [{ productId, quantity }] },
})
const pay = (localOrderId: string, amountCents: number) => ({
  id: randomUUID(),
  seq: ++seq,
  type: 'PAY_CASH' as const,
  payload: { localOrderId, amountCents, tipCents: 0, method: 'CASH' },
})

/**
 * La mesera abre la mesa, pide y cobra por la cola, y el servidor «cae» entre el commit del cobro y el cierre de su reserva: la escritura
 * que la cierra (paso 4 de processIntents, `data.status`) falla. El cobro y su huella son los REALES de la transacción (Codex r2 #6:
 * nada se escribe a mano). Después la reserva se envejece 2 min y la mesa se deja ocupada, como si la liberación no hubiera alcanzado.
 */
async function cobroConCaida() {
  const t = await mesa()
  const o = open(t)
  const [a1, a2] = await processIntents(params([o, add(o.payload.localOrderId, 2)]))
  expect([a1.status, a2.status]).toEqual(['ACKED', 'ACKED'])
  const p = pay(o.payload.localOrderId, 24000)
  const original = prisma.posSyncIntent.updateMany.bind(prisma.posSyncIntent)
  const caida = jest.spyOn(prisma.posSyncIntent, 'updateMany').mockImplementation(((args: any) => {
    if (args?.where?.idempotencyKey === p.id && args?.data?.status) return Promise.reject(new Error('el servidor cayó antes de cerrar'))
    return original(args)
  }) as any)
  let primera: Awaited<ReturnType<typeof processIntents>>[number]
  try {
    ;[primera] = await processIntents(params([p]))
  } finally {
    caida.mockRestore()
  }
  expect(primera.status).toBe('ACKED') // esa respuesta se la llevó la caída: el aparato nunca la vio
  // El cobro sí creó su recibo (Codex r3 #3): sin él, la prueba del filtro «recibo sólo a quien cobró» no probaría nada.
  expect(primera.result!.digitalReceipt).toEqual(expect.objectContaining({ accessKey: expect.any(String), receiptUrl: expect.any(String) }))
  const orderId = String(a1.result!.orderId)
  const paymentId = String(primera.result!.paymentId)
  const reservada = await fila(p.id)
  expect(reservada).toMatchObject({ status: 'PROCESSING', resultJson: { ...MARCA, huella: { orderId, paymentId } } })
  await prisma.posSyncIntent.update({
    where: { venueId_idempotencyKey: { venueId, idempotencyKey: p.id } },
    data: { createdAt: new Date(Date.now() - 120_000) },
  })
  await prisma.table.update({ where: { id: t }, data: { status: 'OCCUPIED', currentOrderId: orderId } })
  return { t, p, orderId, paymentId, primera }
}
function fila(id: string) {
  return prisma.posSyncIntent.findUniqueOrThrow({ where: { venueId_idempotencyKey: { venueId, idempotencyKey: id } } })
}

describe('D20 · el cobro de la cola que ya está en la base', () => {
  it.each([
    { caso: 'otra persona en el MISMO aparato', over: () => ({ staffId: cajera }), deOtra: true },
    { caso: 'la misma mesera sin el permiso de cobrar', over: () => ({ permiso: false }), deOtra: false },
  ])('$caso ⇒ ACKED con ESE cobro, un solo pago, la mesa liberada y la reserva sigue siendo de su dueña', async ({ over, deOtra }) => {
    const { t, p, orderId, primera } = await cobroConCaida()
    const antes = await fila(p.id)

    const [ack] = await processIntents(params([p], over()))

    // La MISMA forma que el acuse del cobro; el recibo digital sólo a quien cobró (a otra persona del aparato, sin él).
    const esperado = deOtra ? { ...primera.result, digitalReceipt: null } : primera.result
    expect(ack).toEqual({ id: p.id, status: 'ACKED', result: esperado })
    expect(await prisma.payment.count({ where: { venueId, orderId } })).toBe(1)
    expect(await prisma.table.findUniqueOrThrow({ where: { id: t } })).toMatchObject({ status: 'AVAILABLE', currentOrderId: null })
    // No se escribe la reserva: sigue abierta, con su huella y su turno, para su dueña.
    expect(await fila(p.id)).toMatchObject({ status: 'PROCESSING', createdAt: antes.createdAt, resultJson: antes.resultJson })

    // Si esa respuesta también se pierde, el siguiente reenvío contesta igual y sigue sin cobrar.
    const [otraVez] = await processIntents(params([p], over()))
    expect(otraVez).toEqual(ack)
    expect(await prisma.payment.count({ where: { venueId, orderId } })).toBe(1)

    // La dueña, con su sesión y su permiso, la retoma después: recibe su cobro con su recibo y la reserva se cierra.
    const [delDueno] = await processIntents(params([p]))
    expect(delDueno).toEqual({ id: p.id, status: 'ACKED', result: primera.result })
    expect(await fila(p.id)).toMatchObject({ status: 'ACKED', errorCode: null })
    expect(await prisma.payment.count({ where: { venueId, orderId } })).toBe(1)
  })

  it('OTRO aparato con la misma llave ⇒ el rechazo de siempre y la reserva intacta para su dueña', async () => {
    const { p, orderId, paymentId } = await cobroConCaida()
    const antes = await fila(p.id)

    const [ack] = await processIntents(params([p], { staffId: cajera, deviceId: 'device-ajeno' }))

    expect(ack).toMatchObject({ status: 'REJECTED', errorCode: 'ACTOR_MISMATCH' })
    expect(ack.result).toBeUndefined()
    expect(await fila(p.id)).toMatchObject({ status: 'PROCESSING', createdAt: antes.createdAt })

    // Su dueña la retoma después y recibe su cobro, sin cobrar dos veces.
    const [delDueno] = await processIntents(params([p]))
    expect(delDueno).toMatchObject({ status: 'ACKED', result: expect.objectContaining({ paymentId }) })
    expect(await prisma.payment.count({ where: { venueId, orderId } })).toBe(1)
  })

  it('control: sin huella (el cobro no ocurrió) otra persona recibe el rechazo de siempre y no se cobra', async () => {
    const t = await mesa()
    const o = open(t)
    await processIntents(params([o, add(o.payload.localOrderId)]))
    const p = pay(o.payload.localOrderId, 12000)
    await prisma.posSyncIntent.create({
      data: {
        venueId,
        deviceId: device,
        staffId: mesera,
        seq: p.seq,
        type: 'PAY_CASH',
        idempotencyKey: p.id,
        status: 'PROCESSING',
        resultJson: MARCA as any,
        createdAt: new Date(Date.now() - 120_000),
      },
    })

    const [ack] = await processIntents(params([p], { staffId: cajera }))

    expect(ack).toMatchObject({ status: 'REJECTED', errorCode: 'ACTOR_MISMATCH' })
    expect(await prisma.payment.count({ where: { venueId, idempotencyKey: p.id } })).toBe(0)
    expect(await fila(p.id)).toMatchObject({ status: 'PROCESSING' })
  })
})
