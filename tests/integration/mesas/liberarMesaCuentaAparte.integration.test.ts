/**
 * D75 (hz:8024bc1c:D75, 14-nov-2026) — «Liberar mesa» tras la cuenta aparte de una mesa abierta sin red. Postgres REAL.
 *
 * Desde D51/D71 una mesa abierta sin red cuya mesa recibió OTRA cuenta mientras tanto nace en cuenta propia y se cobra bien. Pero el
 * aparato, al terminar de cobrar SU cuenta, encola `CLEAR_TABLE` sólo con la mesa, y el SERVIDOR lo rechazaba porque la mesa todavía
 * tiene la otra cuenta (`BUSINESS_RULE` «Cannot clear table with unpaid order <B>», o `TABLE_OWNED_BY_OTHER` con propiedad de mesa):
 * una «operación por revisar» que nadie puede resolver. Medido en D3 + SAMSUNG el 14-nov (`PosSyncIntent` seq 111, 119, 123, 127).
 *
 * Regla: el `CLEAR_TABLE` trae (opcional) la cuenta que el aparato quiso liberar. Si esa cuenta ya no debe y lo que debe la mesa es
 * OTRA cuenta, ACK sin tocar nada. Con la cuenta todavía debiendo o sin otra cuenta, como hoy.
 *
 * D75b (15-nov-2026): sin el campo (apps viejas), la cuenta es la cuenta aparte que ESE aparato abrió en esa mesa (nota con su deviceId),
 * si lo que debe la mesa ya estaba cuando nació y la nota tiene menos de 24 h. Si no, como hoy.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { processIntents } from '@/services/mobile/sync.mobile.service'
import { assignTable } from '@/services/tpv/table.tpv.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
jest.setTimeout(60_000)

const fixture = `d75-${randomUUID().slice(0, 8)}`
let seq = 0

interface Negocio {
  venueId: string
  /** El aparato que abrió la mesa sin red. */
  mesero: string
  /** El que abrió la otra cuenta en línea. */
  otro: string
  productId: string
}
let libre: Negocio // propiedad de mesa APAGADA (D51)
let conDueno: Negocio // propiedad de mesa ENCENDIDA (D71)

const replay = (n: Negocio, intents: any[], staffId = n.mesero, deviceId = `aparato-${staffId}`) =>
  processIntents({ venueId: n.venueId, staffId, deviceId, intents, authorizeIntent: () => true })
const open = (tableId: string, createdAtLocal = Date.now() - 60_000, localOrderId: string = randomUUID()) => ({
  id: randomUUID(),
  seq: ++seq,
  type: 'OPEN_TABLE' as const,
  payload: { tableId, covers: 2, localOrderId },
  createdAtLocal,
})
const add = (n: Negocio, localOrderId: string) => ({
  id: randomUUID(),
  seq: ++seq,
  type: 'ADD_ITEMS' as const,
  payload: { localOrderId, items: [{ productId: n.productId, quantity: 2 }] },
})
const pay = (localOrderId: string, amountCents: number) => ({
  id: randomUUID(),
  seq: ++seq,
  type: 'PAY_CASH' as const,
  payload: { localOrderId, amountCents, tipCents: 0, method: 'CASH' },
})
/** `cuenta` = lo que manda ANDROID desde D75 (`localOrderId` de la apertura sin red u `orderId`); sin ella, una app vieja. */
const clear = (tableId: string, cuenta?: { localOrderId: string } | { orderId: string }) => ({
  id: randomUUID(),
  seq: ++seq,
  type: 'CLEAR_TABLE' as const,
  payload: { tableId, ...(cuenta ?? {}) },
})

async function crearNegocio(propiedad: boolean): Promise<Negocio> {
  const nombre = `${fixture}-${propiedad ? 'dueno' : 'libre'}`
  const org = await prisma.organization.create({ data: { name: nombre, email: `${nombre}@example.test`, phone: '' } })
  const venueId = (
    await prisma.venue.create({ data: { organizationId: org.id, name: nombre, slug: nombre, type: 'RESTAURANT', status: 'TRIAL' } })
  ).id
  await prisma.venueSettings.create({ data: { venueId, enableShifts: false, requirePinLogin: false, enforceTableOwnership: propiedad } })
  const persona = async (quien: string) =>
    (await prisma.staff.create({ data: { email: `${quien}-${nombre}@staff.test`, firstName: 'Mesero', lastName: quien, active: true } })).id
  const mesero = await persona('uno')
  const otro = await persona('maria')
  await prisma.staffVenue.createMany({
    data: [
      { venueId, staffId: mesero, role: 'WAITER' },
      { venueId, staffId: otro, role: 'WAITER' },
    ],
  })
  const cat = await prisma.menuCategory.create({ data: { venueId, name: 'Cocina', slug: `cocina-${nombre}` } })
  const productId = (
    await prisma.product.create({ data: { venueId, categoryId: cat.id, name: 'Ensalada', sku: `D75-${nombre}`, price: 120 } })
  ).id
  return { venueId, mesero, otro, productId }
}

async function mesa(n: Negocio): Promise<string> {
  return (await prisma.table.create({ data: { venueId: n.venueId, number: randomUUID().slice(0, 6), capacity: 4, qrCode: randomUUID() } }))
    .id
}
/** La otra cuenta: la abrió en línea otro mesero DESPUÉS de que el aparato abrió la mesa sin red, con un producto. */
async function otraCuenta(n: Negocio, tableId: string): Promise<string> {
  const id = (await assignTable(n.venueId, tableId, n.otro, 2)).order.id
  await prisma.orderItem.create({ data: { orderId: id, productName: 'Limonada', quantity: 1, unitPrice: 35, total: 35, taxAmount: 0 } })
  return id
}
const huellaDe = async (orderId: string) => {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, paymentStatus: true, tableId: true } })
  return {
    ...o,
    renglones: await prisma.orderItem.count({ where: { orderId } }),
    pagos: await prisma.payment.count({ where: { orderId } }),
  }
}
const laMesa = (tableId: string) =>
  prisma.table.findUniqueOrThrow({ where: { id: tableId }, select: { status: true, currentOrderId: true } })

beforeAll(async () => {
  libre = await crearNegocio(false)
  conDueno = await crearNegocio(true)
})
afterAll(async () => {
  await prisma.$disconnect()
}) // Se conservan las filas únicas de esta corrida como evidencia.

/** Abre sin red, pide y cobra completo en una sola petición (como el replay de la D3); devuelve la cuenta propia. */
async function mesaSinRedCobrada(n: Negocio, tableId: string, localOrderId: string, abiertaSinRed = Date.now() - 60_000) {
  const o = open(tableId, abiertaSinRed, localOrderId)
  const acks = await replay(n, [o, add(n, localOrderId), pay(localOrderId, 24000)])
  expect(acks.map(a => a.status)).toEqual(['ACKED', 'ACKED', 'ACKED'])
  expect(acks[0].result).toMatchObject({ isNewOrder: true, localOrderId })
  return String(acks[0].result!.orderId)
}

describe('D75 · «Liberar mesa» de la cuenta aparte', () => {
  it('D51-A (propiedad apagada): su cuenta ya está pagada y la mesa debe OTRA → ACK sin tocar la mesa ni la otra cuenta', async () => {
    const t = await mesa(libre)
    const abiertaSinRed = Date.now() - 60_000
    const b = await otraCuenta(libre, t) // la SAMSUNG, en línea, mientras la D3 sigue sin red
    const antesB = await huellaDe(b)
    const local = randomUUID()
    const propia = await mesaSinRedCobrada(libre, t, local, abiertaSinRed)

    const [ack] = await replay(libre, [clear(t, { localOrderId: local })])

    expect(ack).toMatchObject({ status: 'ACKED', result: { tableId: t, mesaSinCambios: true } })
    // El ACK no nombra la cuenta: ANDROID confirmaría con ella la sesión (TableSyncCoordinator) y no hay nada que confirmar.
    expect(ack.result).not.toHaveProperty('orderId')
    expect(ack.result).not.toHaveProperty('localOrderId')
    expect(await huellaDe(b)).toEqual(antesB)
    expect(antesB).toMatchObject({ status: 'PENDING', pagos: 0 })
    expect(await huellaDe(propia)).toMatchObject({ paymentStatus: 'PAID', pagos: 1 })
    expect(await laMesa(t)).toEqual({ status: 'OCCUPIED', currentOrderId: b })
  })

  it('D71-B1 (propiedad encendida): la otra cuenta es de María → ACK sin tocar nada, ya no TABLE_OWNED_BY_OTHER', async () => {
    const t = await mesa(conDueno)
    const abiertaSinRed = Date.now() - 60_000
    const deMaria = await otraCuenta(conDueno, t)
    const antes = await huellaDe(deMaria)
    const local = randomUUID()
    const propia = await mesaSinRedCobrada(conDueno, t, local, abiertaSinRed)

    const [ack] = await replay(conDueno, [clear(t, { localOrderId: local })])

    expect(ack).toMatchObject({ status: 'ACKED', result: { tableId: t, mesaSinCambios: true } })
    expect(await huellaDe(deMaria)).toEqual(antes)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: deMaria }, select: { servedById: true } })).toEqual({
      servedById: conDueno.otro,
    })
    expect(await huellaDe(propia)).toMatchObject({ paymentStatus: 'PAID' })
    expect(await laMesa(t)).toEqual({ status: 'OCCUPIED', currentOrderId: deMaria })
  })

  it('en el MISMO lote que la apertura (sin otra petición de por medio) también se resuelve con la cuenta local', async () => {
    const t = await mesa(libre)
    const abiertaSinRed = Date.now() - 60_000
    const b = await otraCuenta(libre, t)
    const local = randomUUID()
    const o = open(t, abiertaSinRed, local)

    const acks = await replay(libre, [o, add(libre, local), pay(local, 24000), clear(t, { localOrderId: local })])

    expect(acks.map(a => a.status)).toEqual(['ACKED', 'ACKED', 'ACKED', 'ACKED'])
    expect(acks[3].result).toMatchObject({ mesaSinCambios: true })
    expect(await laMesa(t)).toEqual({ status: 'OCCUPIED', currentOrderId: b })
  })

  it('anular su cuenta (CANCEL_ORDER) y liberar con la otra cuenta en la mesa → ACK sin tocar la otra', async () => {
    const t = await mesa(libre)
    const abiertaSinRed = Date.now() - 60_000
    const b = await otraCuenta(libre, t)
    const antesB = await huellaDe(b)
    const local = randomUUID()
    const o = open(t, abiertaSinRed, local)
    const cancel = {
      id: randomUUID(),
      seq: ++seq,
      type: 'CANCEL_ORDER' as const,
      payload: { localOrderId: local, reason: 'Error de entrada' },
    }

    const acks = await replay(libre, [o, cancel, clear(t, { localOrderId: local })])

    expect(acks.map(a => a.status)).toEqual(['ACKED', 'ACKED', 'ACKED'])
    expect(acks[2].result).toMatchObject({ mesaSinCambios: true })
    expect(await huellaDe(String(acks[0].result!.orderId))).toMatchObject({ status: 'CANCELLED' })
    expect(await huellaDe(b)).toEqual(antesB)
    expect(await laMesa(t)).toEqual({ status: 'OCCUPIED', currentOrderId: b })
  })

  // ── Controles: todo lo demás, como hoy ─────────────────────────────────────────────────────────────────────────────────────

  it('control · mesa con una sola cuenta (la suya, pagada): se libera como hoy', async () => {
    const t = await mesa(libre)
    const local = randomUUID()
    await mesaSinRedCobrada(libre, t, local)

    const [ack] = await replay(libre, [clear(t, { localOrderId: local })])

    expect(ack).toMatchObject({ status: 'ACKED', result: { tableId: t } })
    expect(ack.result).not.toHaveProperty('mesaSinCambios')
    expect(await laMesa(t)).toEqual({ status: 'AVAILABLE', currentOrderId: null })
  })

  // ── D75b (15-nov-2026): las apps viejas mandan el CLEAR_TABLE sin la cuenta (TPV 2.10–2.20, iOS, ANDROID ≤2.25.44). La cuenta que
  // quisieron soltar es la cuenta aparte que ESE aparato abrió en esa mesa (nota MESA_SIN_RED_EN_CUENTA_APARTE con su deviceId). ──
  describe('D75b · app vieja (sin la cuenta)', () => {
    const notaDe = (orderId: string) =>
      prisma.activityLog.findFirstOrThrow({ where: { entityId: orderId, action: 'MESA_SIN_RED_EN_CUENTA_APARTE' } })

    it('propiedad apagada: su cuenta aparte ya está pagada y la mesa debe OTRA → ACK sin tocar nada', async () => {
      const t = await mesa(libre)
      const b = await otraCuenta(libre, t)
      const antesB = await huellaDe(b)
      const propia = await mesaSinRedCobrada(libre, t, randomUUID())
      expect((await notaDe(propia)).data).toMatchObject({ tableId: t, deviceId: `aparato-${libre.mesero}` })

      const [ack] = await replay(libre, [clear(t)])

      expect(ack).toMatchObject({ status: 'ACKED', result: { tableId: t, mesaSinCambios: true } })
      expect(ack.result).not.toHaveProperty('orderId')
      expect(await huellaDe(b)).toEqual(antesB)
      expect(await laMesa(t)).toEqual({ status: 'OCCUPIED', currentOrderId: b })
    })

    it('propiedad encendida: la otra cuenta es de María → ACK sin tocar nada, ya no TABLE_OWNED_BY_OTHER', async () => {
      const t = await mesa(conDueno)
      const deMaria = await otraCuenta(conDueno, t)
      const antes = await huellaDe(deMaria)
      await mesaSinRedCobrada(conDueno, t, randomUUID())

      const [ack] = await replay(conDueno, [clear(t)])

      expect(ack).toMatchObject({ status: 'ACKED', result: { tableId: t, mesaSinCambios: true } })
      expect(await huellaDe(deMaria)).toEqual(antes)
      expect(await laMesa(t)).toEqual({ status: 'OCCUPIED', currentOrderId: deMaria })
    })

    it('en el MISMO lote que la apertura sin red (el replay de siempre) → ACK sin cambios', async () => {
      const t = await mesa(libre)
      const b = await otraCuenta(libre, t)
      const local = randomUUID()

      const acks = await replay(libre, [open(t, Date.now() - 60_000, local), add(libre, local), pay(local, 24000), clear(t)])

      expect(acks.map(a => a.status)).toEqual(['ACKED', 'ACKED', 'ACKED', 'ACKED'])
      expect(acks[3].result).toMatchObject({ mesaSinCambios: true })
      expect(await laMesa(t)).toEqual({ status: 'OCCUPIED', currentOrderId: b })
    })

    it('la TPV (su deviceId es la serie) entra por el mismo camino → ACK sin cambios', async () => {
      const t = await mesa(libre)
      await otraCuenta(libre, t)
      const local = randomUUID()
      const tpv = `PAX-A910S-${randomUUID().slice(0, 6)}`

      const acks = await replay(libre, [open(t, Date.now() - 60_000, local), add(libre, local), pay(local, 24000), clear(t)], libre.mesero, tpv)

      expect(acks[3]).toMatchObject({ status: 'ACKED', result: { mesaSinCambios: true } })
    })

    it('control · su cuenta aparte TODAVÍA debe → el rechazo de hoy (propiedad apagada y encendida)', async () => {
      const t1 = await mesa(libre)
      await otraCuenta(libre, t1)
      const l1 = randomUUID()
      await replay(libre, [open(t1, Date.now() - 60_000, l1), add(libre, l1), pay(l1, 10000)])
      const [r1] = await replay(libre, [clear(t1)])
      expect(r1).toMatchObject({ status: 'REJECTED', errorCode: 'BUSINESS_RULE' })

      const t2 = await mesa(conDueno)
      await otraCuenta(conDueno, t2)
      const l2 = randomUUID()
      await replay(conDueno, [open(t2, Date.now() - 60_000, l2), add(conDueno, l2), pay(l2, 10000)])
      const [r2] = await replay(conDueno, [clear(t2)])
      expect(r2).toMatchObject({ status: 'REJECTED', errorCode: 'TABLE_OWNED_BY_OTHER' })
    })

    it('control · OTRO aparato sin cuenta aparte en esa mesa → el rechazo de hoy', async () => {
      const t = await mesa(libre)
      const b = await otraCuenta(libre, t)
      await mesaSinRedCobrada(libre, t, randomUUID())
      const numeroB = (await prisma.order.findUniqueOrThrow({ where: { id: b }, select: { orderNumber: true } })).orderNumber

      const [ack] = await replay(libre, [clear(t)], libre.mesero, `otro-aparato-${randomUUID().slice(0, 6)}`)

      expect(ack).toMatchObject({ status: 'REJECTED', errorCode: 'BUSINESS_RULE', message: `Cannot clear table with unpaid order ${numeroB}` })
    })

    it('control · mesa con una sola cuenta (la suya, pagada, sin cuenta aparte) → se libera como hoy', async () => {
      const t = await mesa(libre)
      await mesaSinRedCobrada(libre, t, randomUUID())

      const [ack] = await replay(libre, [clear(t)])

      expect(ack).toMatchObject({ status: 'ACKED', result: { tableId: t } })
      expect(ack.result).not.toHaveProperty('mesaSinCambios')
      expect(await laMesa(t)).toEqual({ status: 'AVAILABLE', currentOrderId: null })
    })

    it('control · una cuenta que nació DESPUÉS de la cuenta aparte también debe → el rechazo de hoy', async () => {
      const t = await mesa(libre)
      await otraCuenta(libre, t)
      await mesaSinRedCobrada(libre, t, randomUUID())
      // Otro aparato abre la mesa sin red: nace una tercera cuenta que la cuenta aparte no conocía.
      const [tercera] = await replay(libre, [open(t, Date.now() - 60_000)], libre.otro)
      expect(tercera).toMatchObject({ status: 'ACKED', result: { isNewOrder: true } })

      const [ack] = await replay(libre, [clear(t)])

      expect(ack).toMatchObject({ status: 'REJECTED', errorCode: 'BUSINESS_RULE' })
    })

    it('control · la nota de la cuenta aparte tiene más de 24 h → el rechazo de hoy', async () => {
      const t = await mesa(libre)
      await otraCuenta(libre, t)
      const propia = await mesaSinRedCobrada(libre, t, randomUUID())
      await prisma.activityLog.updateMany({
        where: { entityId: propia, action: 'MESA_SIN_RED_EN_CUENTA_APARTE' },
        data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
      })

      const [ack] = await replay(libre, [clear(t)])

      expect(ack).toMatchObject({ status: 'REJECTED', errorCode: 'BUSINESS_RULE' })
    })
  })

  it('control · su cuenta TODAVÍA debe: el rechazo de hoy (propiedad apagada y encendida)', async () => {
    const t1 = await mesa(libre)
    await otraCuenta(libre, t1)
    const l1 = randomUUID()
    const acks1 = await replay(libre, [open(t1, Date.now() - 60_000, l1), add(libre, l1), pay(l1, 10000)])
    expect(await huellaDe(String(acks1[0].result!.orderId))).toMatchObject({ paymentStatus: 'PARTIAL' })
    const [r1] = await replay(libre, [clear(t1, { localOrderId: l1 })])
    expect(r1).toMatchObject({ status: 'REJECTED', errorCode: 'BUSINESS_RULE' })
    expect(r1.message).toMatch(/^Cannot clear table with unpaid order /)

    const t2 = await mesa(conDueno)
    await otraCuenta(conDueno, t2)
    const l2 = randomUUID()
    await replay(conDueno, [open(t2, Date.now() - 60_000, l2), add(conDueno, l2), pay(l2, 10000)])
    const [r2] = await replay(conDueno, [clear(t2, { localOrderId: l2 })])
    expect(r2).toMatchObject({ status: 'REJECTED', errorCode: 'TABLE_OWNED_BY_OTHER' })
  })

  it('la cuenta de OTRO no abre la puerta: con la cuenta de María (que debe) → TABLE_OWNED_BY_OTHER; con una cuenta pagada de otra mesa → ACK sin tocar nada', async () => {
    const t = await mesa(conDueno)
    const deMaria = await otraCuenta(conDueno, t)
    const antes = await huellaDe(deMaria)

    const [ajena] = await replay(conDueno, [clear(t, { orderId: deMaria })])
    expect(ajena).toMatchObject({ status: 'REJECTED', errorCode: 'TABLE_OWNED_BY_OTHER' })

    const otraMesa = await mesa(conDueno)
    const local = randomUUID()
    const pagadaEnOtraMesa = await mesaSinRedCobrada(conDueno, otraMesa, local)
    const [ack] = await replay(conDueno, [clear(t, { orderId: pagadaEnOtraMesa })])
    expect(ack).toMatchObject({ status: 'ACKED', result: { mesaSinCambios: true } })

    expect(await huellaDe(deMaria)).toEqual(antes)
    expect(await laMesa(t)).toEqual({ status: 'OCCUPIED', currentOrderId: deMaria })
  })

  it('Codex r1 #1: la sesión ascendió mientras /clear esperaba y el id LOCAL llegó como orderId → se encuentra igual: ACK sin cambios', async () => {
    const t = await mesa(libre)
    const abiertaSinRed = Date.now() - 60_000
    const b = await otraCuenta(libre, t)
    const local = randomUUID()
    await mesaSinRedCobrada(libre, t, local, abiertaSinRed)

    const [ack] = await replay(libre, [clear(t, { orderId: local })])

    expect(ack).toMatchObject({ status: 'ACKED', result: { tableId: t, mesaSinCambios: true } })
    expect(await laMesa(t)).toEqual({ status: 'OCCUPIED', currentOrderId: b })
  })

  it('un orderId que no es de nadie ni id local de nadie: como hoy (el rechazo por la otra cuenta)', async () => {
    const t = await mesa(libre)
    await otraCuenta(libre, t)
    await mesaSinRedCobrada(libre, t, randomUUID())

    const [ack] = await replay(libre, [clear(t, { orderId: randomUUID() })])

    expect(ack).toMatchObject({ status: 'REJECTED', errorCode: 'BUSINESS_RULE' })
  })

  it('un CLEAR_TABLE confirmado con la cuenta local no tapa esa cuenta para lo que llega después en otra petición', async () => {
    const t = await mesa(libre)
    const local = randomUUID()
    const propia = await mesaSinRedCobrada(libre, t, local)
    const [liberada] = await replay(libre, [clear(t, { localOrderId: local })])
    expect(liberada.status).toBe('ACKED')

    // Otra petición con la misma cuenta local (p. ej. el cliente que se le pone a la venta ya cobrada): tiene que encontrarla.
    const [despues] = await replay(libre, [
      { id: randomUUID(), seq: ++seq, type: 'UPDATE_DETAILS' as const, payload: { localOrderId: local, notes: 'D75' } },
    ])
    expect(despues.errorCode).not.toBe('INVALID_PAYLOAD')
    // La cuenta pagada ya está cerrada: el servicio la encontró y contesta su propia regla.
    expect(despues).toMatchObject({ status: 'REJECTED', message: 'La cuenta ya está cerrada' })
    expect(await huellaDe(propia)).toMatchObject({ status: 'COMPLETED' })
  })
})
