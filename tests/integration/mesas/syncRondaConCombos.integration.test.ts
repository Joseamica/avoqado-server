/**
 * hz:5bda0b30:D3 — la ronda con combos que llega SIN RED se guarda ENTERA o nada (PostgreSQL real, servicios reales).
 *
 * Antes cada combo se guardaba en su propia transacción y los productos en otra: si el SERVIDOR moría a la mitad, quedaba un
 * combo guardado sin aviso a cocina, la ronda terminaba en `OUTCOME_UNKNOWN` (no se retomaba) y lo que faltaba nunca llegaba
 * a la cuenta (Codex r4 F1); y cualquiera de fuera (el barrido de cocina, otra caja) veía media ronda que la compensación
 * podía borrar después (F3/F4). Ahora la ronda entera es UNA transacción, como la ronda con red, y se retoma por su huella.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { processIntents } from '@/services/mobile/sync.mobile.service'
import { BadRequestError } from '@/errors/AppError'
import { addItemsToOrder } from '@/services/tpv/order.tpv.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
jest.setTimeout(60_000)

const fixture = `combos-${randomUUID().slice(0, 8)}`
let venueId: string
let staffId: string
let productId: string
let promotionId: string
let selections: Array<{ groupId: string; optionId: string }>
const device = 'device-combos'
let seq = 0

const params = (intents: any[]) => ({ venueId, staffId, deviceId: device, intents, authorizeIntent: () => true })

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: fixture, email: `${fixture}@example.test`, phone: '' } })
  // TRIAL = negocio de prueba: sin candados de plan (mesas, combos y pantalla de cocina).
  const venue = await prisma.venue.create({
    data: { organizationId: org.id, name: fixture, slug: fixture, type: 'RESTAURANT', status: 'TRIAL' },
  })
  venueId = venue.id
  await prisma.venueSettings.create({ data: { venueId, enableShifts: false, requirePinLogin: false } })
  const staff = await prisma.staff.create({ data: { email: `${fixture}@staff.test`, firstName: 'Combos', lastName: 'QA', active: true } })
  staffId = staff.id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: 'OWNER' } })
  // Una estación con pantalla de cocina: la ronda de mesa deja su marca y arma su comanda.
  await prisma.printStation.create({
    data: { venueId, name: 'Cocina', isDefault: true, hasKitchenDisplay: true, kitchenDisplaySince: new Date(Date.now() - 3_600_000) },
  })
  const cat = await prisma.menuCategory.create({ data: { venueId, name: 'Cocina', slug: 'cocina' } })
  const plato = await prisma.product.create({ data: { venueId, categoryId: cat.id, name: 'Plato', sku: `${fixture}-A`, price: 100 } })
  const bebida = await prisma.product.create({ data: { venueId, categoryId: cat.id, name: 'Bebida', sku: `${fixture}-B`, price: 50 } })
  productId = plato.id
  const combo = await prisma.promotion.create({
    data: {
      venueId,
      name: 'Combo comida',
      type: 'BUNDLE',
      pricingMode: 'FIXED_TOTAL',
      priceCents: 9000,
      status: 'PUBLISHED',
      daysOfWeek: [],
      groups: {
        create: [
          { name: 'Plato', displayOrder: 0, options: { create: [{ productId: plato.id }] } },
          { name: 'Bebida', displayOrder: 1, options: { create: [{ productId: bebida.id }] } },
        ],
      },
    },
    include: { groups: { include: { options: true }, orderBy: { displayOrder: 'asc' } } },
  })
  promotionId = combo.id
  selections = combo.groups.map(g => ({ groupId: g.id, optionId: g.options[0].id }))
})
afterAll(async () => {
  await prisma.$disconnect()
}) // Se conservan las filas únicas de esta corrida como evidencia.

/** Una cuenta de mesa abierta por la cola sin red (servicio real de mesas). */
async function cuentaDeMesa(): Promise<{ orderId: string; localOrderId: string }> {
  const table = await prisma.table.create({ data: { venueId, number: randomUUID().slice(0, 6), capacity: 4, qrCode: randomUUID() } })
  const localOrderId = randomUUID()
  const [ack] = await processIntents(
    params([{ id: randomUUID(), seq: ++seq, type: 'OPEN_TABLE', payload: { tableId: table.id, covers: 2, localOrderId } }]),
  )
  expect(ack.status).toBe('ACKED')
  return { orderId: String(ack.result!.orderId), localOrderId }
}

const combo = (instanceId = randomUUID()) => ({ promotionRef: { promotionId, promotionInstanceId: instanceId, selections } })
const ronda = (localOrderId: string, items: any[]) => ({
  id: randomUUID(),
  seq: ++seq,
  type: 'ADD_ITEMS' as const,
  payload: { localOrderId, items },
})

/**
 * Intercepta el N-ésimo `orderPromotion.create` de cualquier transacción y corre `alLlegar` en ese instante (con la transacción
 * todavía abierta). Lo que `alLlegar` lance sale de la transacción como saldría un error real.
 */
function alGuardarElCombo(n: number, alLlegar: () => Promise<void>) {
  let vistos = 0
  const original = prisma.$transaction.bind(prisma)
  return jest.spyOn(prisma, '$transaction').mockImplementation(((cb: any, opts: any) =>
    typeof cb !== 'function'
      ? original(cb, opts)
      : original(
          async (tx: any) =>
            cb(
              new Proxy(tx, {
                get(target, key) {
                  if (key !== 'orderPromotion') return Reflect.get(target, key)
                  return new Proxy(target.orderPromotion, {
                    get(model, method) {
                      if (method !== 'create') return Reflect.get(model, method)
                      return async (args: any) => {
                        if (++vistos === n) await alLlegar()
                        return model.create(args)
                      }
                    },
                  })
                },
              }),
            ),
          opts,
        )) as any)
}

const combosDeLaRonda = (orderId: string, instanceIds: string[]) =>
  prisma.orderPromotion.count({ where: { orderId, instanceId: { in: instanceIds } } })
const comandaDeCombos = (orderId: string) =>
  prisma.kdsOrderItem.count({ where: { kdsOrder: { orderId }, orderPromotionId: { not: null } } })
const reservaDe = (id: string) => prisma.posSyncIntent.findUnique({ where: { venueId_idempotencyKey: { venueId, idempotencyKey: id } } })

describe('ronda de combos sin red: entera o nada', () => {
  it('(1) el SERVIDOR muere a la mitad de una ronda de dos combos: la retoma la guarda ENTERA, una vez, con su comanda', async () => {
    const { orderId, localOrderId } = await cuentaDeMesa()
    const [a, b] = [randomUUID(), randomUUID()]
    const r = ronda(localOrderId, [combo(a), combo(b)])

    // El proceso «muere» justo al guardar el segundo combo: se fotografía la reserva en ese instante (es lo que queda en la base
    // tras una caída) y la transacción en curso se pierde.
    let reservaAlMorir: any
    const espia = alGuardarElCombo(2, async () => {
      reservaAlMorir = await reservaDe(r.id)
      throw Object.assign(new Error('el proceso murió'), { code: 'P2028' })
    })
    try {
      await processIntents(params([r]))
    } finally {
      espia.mockRestore()
    }
    expect(reservaAlMorir).toMatchObject({ status: 'PROCESSING' })
    // La base queda como la dejó la caída: la reserva (sin ACK), envejecida 6 min.
    await prisma.posSyncIntent.deleteMany({ where: { venueId, idempotencyKey: r.id } })
    await prisma.posSyncIntent.create({ data: { ...reservaAlMorir, id: undefined, createdAt: new Date(Date.now() - 6 * 60_000) } })

    const [retomado] = await processIntents(params([r]))

    expect(retomado).toMatchObject({ id: r.id, status: 'ACKED' })
    expect(await combosDeLaRonda(orderId, [a, b])).toBe(2)
    const cuenta = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(Number(cuenta.total)).toBe(180)
    // Los dos combos (dos componentes cada uno) llegaron a la pantalla de cocina.
    expect(await comandaDeCombos(orderId)).toBe(4)
    expect(await reservaDe(r.id)).toMatchObject({ status: 'ACKED' })
  })

  it('(2) mientras la ronda guarda su segundo combo, nadie de fuera ve el primero; un rechazo definitivo no deja nada', async () => {
    const { orderId, localOrderId } = await cuentaDeMesa()
    const [a, b] = [randomUUID(), randomUUID()]
    const r = ronda(localOrderId, [combo(a), combo(b)])

    let vistosDesdeFuera = -1
    const espia = alGuardarElCombo(2, async () => {
      // El barrido de cocina y las otras cajas leen con su propia conexión, fuera de esta transacción.
      vistosDesdeFuera = await combosDeLaRonda(orderId, [a])
      throw new BadRequestError('Esa promoción no está publicada.')
    })
    let ack: any
    try {
      ;[ack] = await processIntents(params([r]))
    } finally {
      espia.mockRestore()
    }

    expect(vistosDesdeFuera).toBe(0)
    expect(ack).toMatchObject({ id: r.id, status: 'REJECTED', message: 'Esa promoción no está publicada.' })
    expect(await combosDeLaRonda(orderId, [a, b])).toBe(0)
    expect(await comandaDeCombos(orderId)).toBe(0)
    const cuenta = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(Number(cuenta.total)).toBe(0)
  })

  it('(3) ronda MIXTA (combo + producto) en mesa con pantalla: todo en la cuenta, una sola comanda de la ronda, total exacto', async () => {
    const { orderId, localOrderId } = await cuentaDeMesa()
    const a = randomUUID()
    const r = ronda(localOrderId, [combo(a), { productId, quantity: 2 }])

    const [ack] = await processIntents(params([r]))

    expect(ack).toMatchObject({ id: r.id, status: 'ACKED' })
    expect(await combosDeLaRonda(orderId, [a])).toBe(1)
    const cuenta = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } })
    expect(Number(cuenta.total)).toBe(290) // combo $90 + 2 × $100
    expect(cuenta.items.map(i => i.externalId).sort()).toEqual(
      [`sync:${r.id}:0:g:${selections[0].groupId}`, `sync:${r.id}:0:g:${selections[1].groupId}`, `sync:${r.id}:0`].sort(),
    )
    expect(await comandaDeCombos(orderId)).toBe(2)
    expect(await prisma.kdsOrderItem.count({ where: { kdsOrder: { orderId }, orderPromotionId: null } })).toBe(1)
  })

  // Codex r1 #1: una retoma deja a dos ejecutores con la misma ronda. El lento NUNCA borra lo que guardó el que ganó.
  it('(4) ejecutor lento: otro retomó y guardó la ronda mientras el lento estaba parado; el lento no toca nada del ganador', async () => {
    const { orderId, localOrderId } = await cuentaDeMesa()
    const [a, b] = [randomUUID(), randomUUID()]
    const r = ronda(localOrderId, [combo(a), combo(b), { productId, quantity: 1 }])
    const versionAntes = (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).version

    // El lento ya reservó y se queda parado 2 min justo antes de leer la cuenta: otro request retoma la reserva y guarda la ronda.
    let ganador: any
    const leerCuenta = prisma.order.findFirst.bind(prisma.order)
    const espia = jest.spyOn(prisma.order, 'findFirst').mockImplementation((async (args: any) => {
      if (ganador === undefined && args?.where?.id === orderId && args?.select?.version) {
        ganador = null
        await prisma.posSyncIntent.update({
          where: { venueId_idempotencyKey: { venueId, idempotencyKey: r.id } },
          data: { createdAt: new Date(Date.now() - 120_000) },
        })
        ;[ganador] = await processIntents(params([r]))
      }
      return leerCuenta(args)
    }) as any)
    let lento: any
    try {
      ;[lento] = await processIntents(params([r]))
    } finally {
      espia.mockRestore()
    }

    expect(ganador).toMatchObject({ id: r.id, status: 'ACKED' })
    expect(lento).toMatchObject({ id: r.id, status: 'ACKED' })
    expect(await combosDeLaRonda(orderId, [a, b])).toBe(2)
    expect(await prisma.orderItem.count({ where: { orderId, orderPromotionId: null } })).toBe(1)
    const cuenta = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(Number(cuenta.total)).toBe(280) // 2 combos de $90 + $100
    expect(cuenta.version).toBe(versionAntes + 1)
    expect(await comandaDeCombos(orderId)).toBe(4)
    expect(await reservaDe(r.id)).toMatchObject({ status: 'ACKED' })
  })

  // Codex r1 #2: la ruta con red guardó la ronda y perdió la respuesta; la caja la tenía también en su cola. Mientras, la cuenta se
  // cobró (o se reembolsó). El reenvío se contesta sin tocarla, como cuando cada combo contestaba «ya estaba».
  it.each(['PAID', 'REFUNDED'] as const)(
    '(5) el reenvío de una ronda YA guardada entera sobre una cuenta %s: ACKED sin tocarla',
    async paymentStatus => {
      const { orderId, localOrderId } = await cuentaDeMesa()
      const a = randomUUID()
      const { version } = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
      await addItemsToOrder(venueId, orderId, [combo(a)] as any, version, true)
      await prisma.order.update({
        where: { id: orderId },
        data: { paymentStatus, status: 'COMPLETED', paidAmount: 90, remainingBalance: 0 },
      })
      const antes = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })

      const [ack] = await processIntents(params([ronda(localOrderId, [combo(a)])]))

      expect(ack).toMatchObject({ status: 'ACKED', result: { orderId, version: antes.version } })
      expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({
        version: antes.version,
        status: 'COMPLETED',
        paymentStatus,
      })
      expect(await combosDeLaRonda(orderId, [a])).toBe(1)
    },
  )

  // Codex r2 #1: dos importes libres iguales de la misma ronda se guardan FUSIONADOS en un renglón con la primera llave. El
  // reconocimiento no puede exigir las dos llaves: la reembolsada se reabría y la cobrada rechazaba su propia ronda.
  it('(6) ronda YA guardada con dos importes libres iguales (se fusionan) sobre una cuenta REFUNDED: ACKED sin reabrirla', async () => {
    const { orderId, localOrderId } = await cuentaDeMesa()
    const a = randomUUID()
    const libre = { customName: 'Servicio de mesa', customUnitPriceCents: 500, quantity: 1 }
    const r = ronda(localOrderId, [combo(a), libre, libre])
    const { version } = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    // La ruta con red la guardó con las mismas llaves de la cola y perdió la respuesta.
    await addItemsToOrder(
      venueId,
      orderId,
      [combo(a), { ...libre, externalId: `sync:${r.id}:0` }, { ...libre, externalId: `sync:${r.id}:1` }] as any,
      version,
      true,
    )
    expect(await prisma.orderItem.count({ where: { orderId, orderPromotionId: null } })).toBe(1)
    await prisma.order.update({
      where: { id: orderId },
      data: { paymentStatus: 'REFUNDED', status: 'COMPLETED', paidAmount: 100, remainingBalance: 0 },
    })
    const antes = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })

    const [ack] = await processIntents(params([r]))

    expect(ack).toMatchObject({ status: 'ACKED', result: { orderId, version: antes.version } })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({
      version: antes.version,
      status: 'COMPLETED',
      paymentStatus: 'REFUNDED',
    })
  })

  // Codex r2 #2: la cola lee la cuenta vacía; antes de reconocer la ronda, la ruta con red la guarda. El ACK no puede contestar el
  // total y la versión de ANTES de la ronda (la caja reemplazaría una versión nueva por una vieja).
  it('(7) la ruta con red guarda la ronda entre la lectura de la cola y su reconocimiento: el ACK trae el total y la versión de después', async () => {
    const { orderId, localOrderId } = await cuentaDeMesa()
    const a = randomUUID()
    const r = ronda(localOrderId, [combo(a)])
    let guardada = false
    const leerCuenta = prisma.order.findFirst.bind(prisma.order)
    const espia = jest.spyOn(prisma.order, 'findFirst').mockImplementation((async (args: any) => {
      const leida = await leerCuenta(args)
      if (!guardada && args?.where?.id === orderId && args?.select?.version) {
        guardada = true
        await addItemsToOrder(venueId, orderId, [combo(a)] as any, (leida as any).version, true)
      }
      return leida
    }) as any)
    let ack: any
    try {
      ;[ack] = await processIntents(params([r]))
    } finally {
      espia.mockRestore()
    }

    const cuenta = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(guardada).toBe(true)
    expect(Number(cuenta.total)).toBe(90)
    expect(ack).toMatchObject({ status: 'ACKED', result: { orderId, version: cuenta.version, total: 90 } })
    expect(await combosDeLaRonda(orderId, [a])).toBe(1)
  })
})
