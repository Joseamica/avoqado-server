/**
 * D7 (hz:033d44ca:D7, encargo b61791, 16-nov-2026) — la ronda que llega después de que otra caja cobró la mesa. Postgres REAL.
 *
 * El caso (ensayo del 16-nov, fila A5): la mesera abre la mesa con internet y manda una ronda; se queda sin internet y agrega otra
 * («por sincronizar»). La caja, con internet, cobra lo que ve y libera la mesa. Al volver la red, el SERVIDOR rechazaba la ronda
 * («Cannot add items to a paid order»): lo servido nunca se cobraba.
 *
 * Decisión del founder («A», 16-nov): la ronda tardía cae en una cuenta nueva de la misma mesa, por cobrar, con nota en la bitácora
 * (`RONDA_TARDIA_EN_CUENTA_APARTE`). La cobrada no se toca. Lo demás del MISMO aparato para esa cuenta (otra ronda, su cobro sin red)
 * cae en esa misma cuenta aparte.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { processIntents } from '@/services/mobile/sync.mobile.service'
import { mergeOrders, payCashOrder } from '@/services/mobile/order.mobile.service'
import { assignTable, clearTable } from '@/services/tpv/table.tpv.service'
import { addItemsToOrder } from '@/services/tpv/order.tpv.service'
import { voidOrderItem } from '@/services/mobile/void-item.mobile.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
jest.setTimeout(60_000)

const fixture = `d7r-${randomUUID().slice(0, 8)}`
let venueId: string
let mesera: string
let caja: string
let coca: string
let agua: string
const aparatoMesera = `samsung-${fixture}`
const aparatoCaja = `d3-${fixture}`
let seq = 0

const replay = (intents: any[], staffId = mesera, deviceId = aparatoMesera) =>
  processIntents({ venueId, staffId, deviceId, intents, authorizeIntent: () => true })
const ronda = (orderId: string, productId = agua, quantity = 1, id = randomUUID()) => ({
  id,
  seq: ++seq,
  type: 'ADD_ITEMS' as const,
  payload: { orderId, items: [{ productId, quantity }] },
  createdAtLocal: Date.now() - 120_000,
})
const cobroSinRed = (orderId: string, amountCents: number) => ({
  id: randomUUID(),
  seq: ++seq,
  type: 'PAY_CASH' as const,
  payload: { orderId, amountCents, tipCents: 0, method: 'CASH' },
  createdAtLocal: Date.now() - 60_000,
})

async function mesa(): Promise<string> {
  return (await prisma.table.create({ data: { venueId, number: randomUUID().slice(0, 6), capacity: 4, qrCode: randomUUID() } })).id
}

/** La mesera abre la mesa con internet y manda Coca $25; la caja, con internet, la cobra completa y libera la mesa. */
async function mesaCobradaPorLaCaja(): Promise<{ t: string; cobrada: string }> {
  const t = await mesa()
  const cobrada = (await assignTable(venueId, t, mesera, 2)).order.id
  const v = await prisma.order.findUniqueOrThrow({ where: { id: cobrada }, select: { version: true } })
  await addItemsToOrder(venueId, cobrada, [{ productId: coca, quantity: 1 }] as any, v.version, true)
  await payCashOrder(venueId, cobrada, { amount: 2500, tip: 0, staffId: caja, idempotencyKey: `caja-${cobrada}` })
  await clearTable(venueId, t)
  return { t, cobrada }
}

const fotoDe = async (orderId: string) => {
  const o = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { total: true, paymentStatus: true, status: true, version: true, tableId: true },
  })
  return {
    ...o,
    total: Number(o.total),
    renglones: await prisma.orderItem.count({ where: { orderId } }),
    pagos: await prisma.payment.count({ where: { orderId } }),
  }
}
const notasDe = (cobrada: string) =>
  prisma.activityLog.findMany({
    where: { venueId, action: 'RONDA_TARDIA_EN_CUENTA_APARTE', data: { path: ['cuentaOriginal'], equals: cobrada } },
  })

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
  agua = (await prisma.product.create({ data: { venueId, categoryId: cat.id, name: 'Agua', sku: `A-${fixture}`, price: 20 } })).id
})
afterAll(async () => {
  await prisma.$disconnect()
}) // Se conservan las filas únicas de esta corrida como evidencia.

describe('D7 · ronda sin red que llega a una cuenta que otra caja ya cobró', () => {
  it('A5: la ronda entra en una cuenta nueva de la misma mesa, por cobrar; la cobrada no cambia y la mesa queda ocupada', async () => {
    const { t, cobrada } = await mesaCobradaPorLaCaja()
    const antes = await fotoDe(cobrada)
    expect(antes).toMatchObject({ paymentStatus: 'PAID', total: 25, renglones: 1, pagos: 1 })

    const r = ronda(cobrada)
    const [ack] = await replay([r])

    expect(ack.status).toBe('ACKED')
    // El ACK nombra la cuenta que el aparato conoce (apps viejas confirman su sesión y releen el servidor) y la cuenta aparte.
    expect(ack.result).toMatchObject({ orderId: cobrada })
    const aparte = String((ack.result as any).cuentaAparte?.orderId)
    expect(aparte).not.toBe(cobrada)
    expect(await fotoDe(cobrada)).toEqual(antes)
    expect(await fotoDe(aparte)).toMatchObject({ tableId: t, paymentStatus: 'PENDING', total: 20, renglones: 1, pagos: 0 })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: aparte } })).toMatchObject({
      servedById: mesera,
      rondaTardiaDeId: cobrada,
      rondaTardiaAparato: aparatoMesera,
      // D30: la cuenta aparte recibe su propio folio de la base, distinto del de la cobrada.
      orderNumber: expect.stringMatching(/^ORD-0\d{12}$/),
    })
    expect(await prisma.table.findUniqueOrThrow({ where: { id: t } })).toMatchObject({ status: 'OCCUPIED', currentOrderId: aparte })
    const [nota] = await notasDe(cobrada)
    expect(nota).toMatchObject({ entity: 'Order', entityId: aparte, staffId: mesera })
    expect(nota.data).toMatchObject({ tableId: t, cuentaOriginal: cobrada, deviceId: aparatoMesera, intentId: r.id })
  })

  it('otra ronda y el cobro sin red del MISMO aparato caen en la misma cuenta aparte (una sola), y el sobrepago queda ahí', async () => {
    const { cobrada } = await mesaCobradaPorLaCaja()
    // La mesera veía $25 + $20 + $20 = $65 y lo cobró sin red.
    const acks = await replay([ronda(cobrada), ronda(cobrada), cobroSinRed(cobrada, 6500)])

    expect(acks.map(a => a.status)).toEqual(['ACKED', 'ACKED', 'ACKED'])
    const aparte = String((acks[0].result as any).cuentaAparte?.orderId)
    expect((acks[1].result as any).cuentaAparte?.orderId).toBe(aparte)
    expect((acks[2].result as any).cuentaAparte?.orderId).toBe(aparte)
    expect(acks[2].result).toMatchObject({ orderId: cobrada })
    expect(await notasDe(cobrada)).toHaveLength(1)
    expect(await fotoDe(cobrada)).toMatchObject({ paymentStatus: 'PAID', total: 25, renglones: 1, pagos: 1 })
    expect(await fotoDe(aparte)).toMatchObject({ paymentStatus: 'PAID', total: 40, renglones: 2, pagos: 1 })
  })

  it('el mismo ADD_ITEMS repetido (respuesta perdida) no duplica la ronda ni la cuenta aparte', async () => {
    const { cobrada } = await mesaCobradaPorLaCaja()
    const r = ronda(cobrada)
    const [primero] = await replay([r])
    const [otraVez] = await replay([r])

    expect(otraVez.status).toBe('ACKED')
    const aparte = String((primero.result as any).cuentaAparte?.orderId)
    expect((otraVez.result as any).cuentaAparte?.orderId).toBe(aparte)
    expect(await fotoDe(aparte)).toMatchObject({ total: 20, renglones: 1 })
    expect(await notasDe(cobrada)).toHaveLength(1)
  })

  it('el cobro sin red de OTRO aparato a la cuenta cobrada sigue registrándose en ella (como hoy)', async () => {
    const { cobrada } = await mesaCobradaPorLaCaja()
    const [deLaRonda] = await replay([ronda(cobrada)])
    const aparte = String((deLaRonda.result as any).cuentaAparte?.orderId)

    const [cobro] = await replay([cobroSinRed(cobrada, 2500)], caja, aparatoCaja)

    expect(cobro.status).toBe('ACKED')
    expect(await fotoDe(cobrada)).toMatchObject({ pagos: 2 })
    expect(await fotoDe(aparte)).toMatchObject({ paymentStatus: 'PENDING', pagos: 0 })
  })

  it('la mesa ya tiene otra visita viva: la cuenta aparte nace junto a ella sin moverle el puntero', async () => {
    const { t, cobrada } = await mesaCobradaPorLaCaja()
    const otraVisita = (await assignTable(venueId, t, caja, 4)).order.id

    const [ack] = await replay([ronda(cobrada)])

    expect(ack.status).toBe('ACKED')
    const aparte = String((ack.result as any).cuentaAparte?.orderId)
    expect(aparte).not.toBe(otraVisita)
    expect(await fotoDe(otraVisita)).toMatchObject({ renglones: 0, total: 0 })
    expect(await fotoDe(aparte)).toMatchObject({ tableId: t, total: 20, renglones: 1 })
    expect(await prisma.table.findUniqueOrThrow({ where: { id: t } })).toMatchObject({ status: 'OCCUPIED', currentOrderId: otraVisita })
    const [nota] = await notasDe(cobrada)
    expect(nota.data).toMatchObject({ otrasCuentas: [otraVisita] })
  })

  it('una cuenta aparte vacía que dejó un proceso muerto se reusa: no nace otra', async () => {
    const { t, cobrada } = await mesaCobradaPorLaCaja()
    // La transacción que la creó commiteó; la de la ronda nunca llegó (sin huella): la retoma vuelve a correr el reducer.
    const huerfana = (await assignTable(venueId, t, mesera, 2)).order.id
    await prisma.order.update({ where: { id: huerfana }, data: { rondaTardiaDeId: cobrada, rondaTardiaAparato: aparatoMesera } })

    const [ack] = await replay([ronda(cobrada)])

    expect(ack.status).toBe('ACKED')
    expect((ack.result as any).cuentaAparte?.orderId).toBe(huerfana)
    expect(await fotoDe(huerfana)).toMatchObject({ total: 20, renglones: 1 })
  })

  it('la ronda que ya estaba en la cuenta antes del cobro se reconoce sin escribir (no se duplica en una cuenta aparte)', async () => {
    const t = await mesa()
    const cobrada = (await assignTable(venueId, t, mesera, 2)).order.id
    const r = ronda(cobrada)
    // La ronda entró (otro intento, cuya respuesta se perdió y cuya reserva no quedó) y la caja cobró ya con ella.
    const v = await prisma.order.findUniqueOrThrow({ where: { id: cobrada }, select: { version: true } })
    await addItemsToOrder(venueId, cobrada, [{ productId: agua, quantity: 1, externalId: `sync:${r.id}:0` }] as any, v.version, true)
    await payCashOrder(venueId, cobrada, { amount: 2000, tip: 0, staffId: caja, idempotencyKey: `caja-${cobrada}` })

    const [ack] = await replay([r])

    expect(ack.status).toBe('ACKED')
    expect(ack.result).toMatchObject({ orderId: cobrada })
    expect((ack.result as any).cuentaAparte).toBeUndefined()
    expect(await fotoDe(cobrada)).toMatchObject({ renglones: 1, total: 20, pagos: 1 })
    expect(await notasDe(cobrada)).toHaveLength(0)
  })

  /** La mesera manda Coca (con red) y luego el Agua en una ronda cuya respuesta pierde; la caja ANULA el agua («Anular producto»). */
  async function aguaAnuladaPorLaCaja(): Promise<{ cobrada: string; r: ReturnType<typeof ronda> }> {
    const t = await mesa()
    const cobrada = (await assignTable(venueId, t, mesera, 2)).order.id
    const v0 = await prisma.order.findUniqueOrThrow({ where: { id: cobrada }, select: { version: true } })
    await addItemsToOrder(venueId, cobrada, [{ productId: coca, quantity: 1 }] as any, v0.version, true)
    const r = ronda(cobrada)
    const v1 = await prisma.order.findUniqueOrThrow({ where: { id: cobrada }, select: { version: true } })
    await addItemsToOrder(venueId, cobrada, [{ productId: agua, quantity: 1, externalId: `sync:${r.id}:0` }] as any, v1.version, true)
    const aguaId = (await prisma.orderItem.findFirstOrThrow({ where: { orderId: cobrada, externalId: `sync:${r.id}:0` } })).id
    await voidOrderItem({ venueId, orderId: cobrada, itemId: aguaId, reason: 'El cliente cambió de parecer', actorId: caja })
    return { cobrada, r }
  }

  it('«Anular producto» (Codex r1 #1): la cuenta sigue abierta y la ronda se reenvía: el agua anulada NO vuelve', async () => {
    const { cobrada, r } = await aguaAnuladaPorLaCaja()

    const [ack] = await replay([r])

    expect(ack.status).toBe('ACKED')
    expect(await prisma.orderItem.count({ where: { externalId: `sync:${r.id}:0` } })).toBe(0)
    expect(await fotoDe(cobrada)).toMatchObject({ renglones: 1, total: 25 })
  })

  it('«Anular producto» (Codex r2 #1): la caja anuló el agua y cobró lo demás: la ronda reenviada NO abre una cuenta aparte', async () => {
    const { cobrada, r } = await aguaAnuladaPorLaCaja()
    await payCashOrder(venueId, cobrada, { amount: 2500, tip: 0, staffId: caja, idempotencyKey: `caja-${cobrada}` })

    const [ack] = await replay([r])

    expect(ack.status).toBe('ACKED')
    expect((ack.result as any).cuentaAparte).toBeUndefined()
    expect(await prisma.orderItem.count({ where: { externalId: `sync:${r.id}:0` } })).toBe(0)
    expect(await fotoDe(cobrada)).toMatchObject({ renglones: 1, total: 25, pagos: 1 })
    expect(await notasDe(cobrada)).toHaveLength(0)
  })

  it('«Anular producto» (Codex r3 #4): la llave propia del aparato llega con espacios; la guardada va recortada y la lápida igual la reconoce', async () => {
    const t = await mesa()
    const cobrada = (await assignTable(venueId, t, mesera, 2)).order.id
    const v0 = await prisma.order.findUniqueOrThrow({ where: { id: cobrada }, select: { version: true } })
    await addItemsToOrder(venueId, cobrada, [{ productId: coca, quantity: 1 }] as any, v0.version, true)
    const llave = `propia-${randomUUID()}`
    const r = { ...ronda(cobrada), payload: { orderId: cobrada, items: [{ productId: agua, quantity: 1, externalId: `  ${llave} ` }] } }
    const v1 = await prisma.order.findUniqueOrThrow({ where: { id: cobrada }, select: { version: true } })
    await addItemsToOrder(venueId, cobrada, [{ productId: agua, quantity: 1, externalId: `  ${llave} ` }] as any, v1.version, true)
    const aguaId = (await prisma.orderItem.findFirstOrThrow({ where: { orderId: cobrada, externalId: llave } })).id
    await voidOrderItem({ venueId, orderId: cobrada, itemId: aguaId, reason: 'El cliente cambió de parecer', actorId: caja })
    await payCashOrder(venueId, cobrada, { amount: 2500, tip: 0, staffId: caja, idempotencyKey: `caja-${cobrada}` })

    const [ack] = await replay([r])

    expect(ack.status).toBe('ACKED')
    expect((ack.result as any).cuentaAparte).toBeUndefined()
    expect(await prisma.orderItem.count({ where: { externalId: llave } })).toBe(0)
    expect(await fotoDe(cobrada)).toMatchObject({ renglones: 1, total: 25, pagos: 1 })
    expect(await notasDe(cobrada)).toHaveLength(0)
  })

  it('Codex r5 #6: una llave hecha sólo de espacios recibe la determinista; anulado ese producto, el reenvío NO lo recrea', async () => {
    const t = await mesa()
    const cuenta = (await assignTable(venueId, t, mesera, 2)).order.id
    const v0 = await prisma.order.findUniqueOrThrow({ where: { id: cuenta }, select: { version: true } })
    await addItemsToOrder(venueId, cuenta, [{ productId: coca, quantity: 1 }] as any, v0.version, true)
    const r = { ...ronda(cuenta), payload: { orderId: cuenta, items: [{ productId: agua, quantity: 1, externalId: '   ' }] } }
    // La primera aplicación de esa ronda (cuya respuesta se perdió) la guardó con la llave determinista que ahora le toca.
    const v1 = await prisma.order.findUniqueOrThrow({ where: { id: cuenta }, select: { version: true } })
    await addItemsToOrder(venueId, cuenta, [{ productId: agua, quantity: 1, externalId: `sync:${r.id}:0` }] as any, v1.version, true)
    const agua1 = await prisma.orderItem.findFirstOrThrow({ where: { orderId: cuenta, externalId: `sync:${r.id}:0` } })
    await voidOrderItem({ venueId, orderId: cuenta, itemId: agua1.id, reason: 'El cliente cambió de parecer', actorId: caja })

    const [ack] = await replay([r])

    expect(ack.status).toBe('ACKED')
    expect(await prisma.orderItem.count({ where: { orderId: cuenta, productId: agua } })).toBe(0)
    expect(await fotoDe(cuenta)).toMatchObject({ renglones: 1, total: 25 })
  })

  it('Codex r0 #1: la ronda ya estaba guardada y otra caja la SEPARÓ a otra cuenta antes de cobrar: no se duplica', async () => {
    const { t, cobrada } = await mesaCobradaPorLaCaja()
    const r = ronda(cobrada)
    const hija = (
      await prisma.order.create({
        data: {
          venueId,
          tableId: t,
          orderNumber: `HIJA-${randomUUID().slice(0, 6)}`,
          servedById: caja,
          total: 20,
          subtotal: 20,
          taxAmount: 0,
        },
      })
    ).id
    await prisma.orderItem.create({
      data: {
        orderId: hija,
        productId: agua,
        productName: 'Agua',
        quantity: 1,
        unitPrice: 20,
        total: 20,
        taxAmount: 0,
        externalId: `sync:${r.id}:0`,
      },
    })

    const [ack] = await replay([r])

    expect(ack.status).toBe('ACKED')
    expect(ack.result).toMatchObject({ orderId: cobrada, cuentaAparte: { orderId: hija } })
    expect(await prisma.orderItem.count({ where: { externalId: `sync:${r.id}:0` } })).toBe(1)
    expect(await notasDe(cobrada)).toHaveLength(0)
  })

  it('Codex r0 #2: un cobro posterior del mismo aparato, con la cuenta aparte ya saldada, sigue yendo a ella (nunca a la cobrada)', async () => {
    const { cobrada } = await mesaCobradaPorLaCaja()
    const acks = await replay([ronda(cobrada), cobroSinRed(cobrada, 2000), cobroSinRed(cobrada, 500)])

    expect(acks.map(a => a.status)).toEqual(['ACKED', 'ACKED', 'ACKED'])
    const aparte = String((acks[0].result as any).cuentaAparte?.orderId)
    expect((acks[2].result as any).cuentaAparte?.orderId).toBe(aparte)
    expect(await fotoDe(cobrada)).toMatchObject({ pagos: 1 })
    expect(await fotoDe(aparte)).toMatchObject({ paymentStatus: 'PAID', pagos: 2 })
  })

  it('Codex r0 #4: con propiedad de mesa, si a la cuenta aparte se la pasaron a otro mesero, la ronda de la mesera ya no entra ahí', async () => {
    const { cobrada } = await mesaCobradaPorLaCaja()
    const [primero] = await replay([ronda(cobrada)])
    const deCaja = String((primero.result as any).cuentaAparte?.orderId)
    await prisma.order.update({ where: { id: deCaja }, data: { servedById: caja } })
    await prisma.venueSettings.update({ where: { venueId }, data: { enforceTableOwnership: true } })
    try {
      const [segundo] = await replay([ronda(cobrada, coca)])
      // La misma regla que una ronda de todos los días a la cuenta de otro mesero.
      expect(segundo).toMatchObject({ status: 'REJECTED', errorCode: 'TABLE_OWNED_BY_OTHER' })
      expect(await fotoDe(deCaja)).toMatchObject({ renglones: 1, total: 20 })
    } finally {
      await prisma.venueSettings.update({ where: { venueId }, data: { enforceTableOwnership: false } })
    }
  })

  it('la cuenta aparte ya se cobró y llega OTRA ronda tardía del mismo aparato: nace otra, colgada de la anterior', async () => {
    const { cobrada } = await mesaCobradaPorLaCaja()
    const [primero] = await replay([ronda(cobrada)])
    const primera = String((primero.result as any).cuentaAparte?.orderId)
    await payCashOrder(venueId, primera, { amount: 2000, tip: 0, staffId: caja, idempotencyKey: `caja-${primera}` })

    const [segundo] = await replay([ronda(cobrada, coca)])

    expect(segundo.status).toBe('ACKED')
    const segunda = String((segundo.result as any).cuentaAparte?.orderId)
    expect(segunda).not.toBe(primera)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: segunda } })).toMatchObject({
      rondaTardiaDeId: primera,
      rondaTardiaAparato: aparatoMesera,
      paymentStatus: 'PENDING',
    })
    expect(await fotoDe(segunda)).toMatchObject({ total: 25, renglones: 1 })
    expect(await fotoDe(primera)).toMatchObject({ paymentStatus: 'PAID', renglones: 1, pagos: 1 })
  })

  it('Codex r0 #7: con otra visita en la mesa, el «Liberar mesa» de una app vieja (sólo la mesa) tras saldar la aparte no queda por revisar', async () => {
    const { t, cobrada } = await mesaCobradaPorLaCaja()
    const otraVisita = (await assignTable(venueId, t, caja, 4)).order.id
    await addItemsToOrder(venueId, otraVisita, [{ productId: coca, quantity: 1 }] as any, 1, true)

    const acks = await replay([
      ronda(cobrada),
      cobroSinRed(cobrada, 2000),
      { id: randomUUID(), seq: ++seq, type: 'CLEAR_TABLE' as const, payload: { tableId: t }, createdAtLocal: Date.now() - 30_000 },
    ])

    expect(acks.map(a => a.status)).toEqual(['ACKED', 'ACKED', 'ACKED'])
    expect(acks[2].result).toMatchObject({ mesaSinCambios: true })
    expect(await fotoDe(otraVisita)).toMatchObject({ paymentStatus: 'PENDING', renglones: 1 })
    expect(await prisma.table.findUniqueOrThrow({ where: { id: t } })).toMatchObject({ status: 'OCCUPIED', currentOrderId: otraVisita })
  })

  it('Codex r2 #1: la caja FUSIONÓ la cuenta aparte con otra cuenta viva: el cobro sin red de la mesera sigue a los productos', async () => {
    const { t, cobrada } = await mesaCobradaPorLaCaja()
    const otraVisita = (await assignTable(venueId, t, caja, 4)).order.id
    await addItemsToOrder(venueId, otraVisita, [{ productId: coca, quantity: 1 }] as any, 1, true)
    const [deLaRonda] = await replay([ronda(cobrada)])
    const aparte = String((deLaRonda.result as any).cuentaAparte?.orderId)

    await mergeOrders(venueId, otraVisita, aparte, caja)
    const [cobro] = await replay([cobroSinRed(cobrada, 2000)])

    expect(cobro.status).toBe('ACKED')
    expect((cobro.result as any).cuentaAparte?.orderId).toBe(otraVisita)
    expect(await fotoDe(cobrada)).toMatchObject({ pagos: 1, total: 25 })
    expect(await fotoDe(otraVisita)).toMatchObject({ renglones: 2, total: 45, pagos: 1 })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: aparte } })).toMatchObject({ status: 'CANCELLED', rondaTardiaDeId: null })
  })

  it('Codex r3 #1: la caja juntó la cuenta aparte con OTRA cuenta aparte: el cobro sigue a la cuenta del aparato y la cobrada no cambia', async () => {
    const primera = await mesaCobradaPorLaCaja()
    const segunda = await mesaCobradaPorLaCaja()
    const [a] = await replay([ronda(primera.cobrada)])
    const [b] = await replay([ronda(segunda.cobrada, coca)], caja, aparatoCaja)
    const aparteA = String((a.result as any).cuentaAparte?.orderId)
    const aparteB = String((b.result as any).cuentaAparte?.orderId)

    await mergeOrders(venueId, aparteB, aparteA, caja)
    const [cobro] = await replay([cobroSinRed(primera.cobrada, 2000)])

    expect(cobro.status).toBe('ACKED')
    expect((cobro.result as any).cuentaAparte?.orderId).toBe(aparteA)
    expect(await fotoDe(primera.cobrada)).toMatchObject({ pagos: 1, total: 25 })
    expect(await fotoDe(aparteA)).toMatchObject({ pagos: 1 })
  })

  it('una venta SIN mesa ya cobrada sigue rechazando la ronda tardía (no entra en este arreglo)', async () => {
    const t = await mesa()
    const cobrada = (await assignTable(venueId, t, mesera, 2)).order.id
    const v = await prisma.order.findUniqueOrThrow({ where: { id: cobrada }, select: { version: true } })
    await addItemsToOrder(venueId, cobrada, [{ productId: coca, quantity: 1 }] as any, v.version, true)
    await payCashOrder(venueId, cobrada, { amount: 2500, tip: 0, staffId: caja, idempotencyKey: `caja-${cobrada}` })
    await clearTable(venueId, t)
    await prisma.order.update({ where: { id: cobrada }, data: { tableId: null } })

    const [ack] = await replay([ronda(cobrada)])

    expect(ack.status).toBe('REJECTED')
    expect(await notasDe(cobrada)).toHaveLength(0)
  })
})
