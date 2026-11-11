/**
 * hz:ce654971:D25 (Codex r4 del D1 de cocina, B1–B5): al dividir, unir o anular una cuenta, la pantalla de cocina no pierde la
 * pieza que estaba por mandarse, y anular sólo retira lo que es de la cuenta anulada. Promesa:
 * docs/audit/2026-11-10-cocina-dueno-al-mover/promesa.md (workspace).
 */
import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { authorKitchenTickets, tomarCandadoDeComandas } from '@/services/kds/kitchenTicketAuthoring.service'
import { initialPreparation, parsePreparation, PREPARATION_VERSION } from '@/services/kds/kitchenPreparation'
import { cancelOrder, mergeOrders, splitOrderBySeat, splitOrderItems } from '@/services/mobile/order.mobile.service'
import { deleteOrder } from '@/services/dashboard/order.dashboard.service'
import { aTiempo, aparcarLaSiguienteTransaccion, esperarBloqueado } from '../../__helpers__/candadosDePostgres'

const SUF = `kdsdueno-${Date.now()}`
const haceUnaHora = new Date(Date.now() - 60 * 60 * 1000)
let orgId: string
let venueId: string
let cocina: string
let taco: string
let limonada: string
let n = 0

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Dueño ${SUF}`, email: `${SUF}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `V ${SUF}`, slug: `v-${SUF}` } })).id
  cocina = (
    await prisma.printStation.create({
      data: { venueId, name: 'Cocina', isDefault: true, hasKitchenDisplay: true, kitchenDisplaySince: haceUnaHora },
    })
  ).id
  const categoria = (await prisma.menuCategory.create({ data: { venueId, name: 'Comida', slug: `comida-${SUF}` } })).id
  const producto = async (name: string) =>
    (await prisma.product.create({ data: { venueId, sku: `${name}-${SUF}`, name, categoryId: categoria, price: new Prisma.Decimal(50) } }))
      .id
  taco = await producto('Taco')
  limonada = await producto('Limonada')
})

afterAll(async () => {
  // Sin venue no se limpia nada por venue: un `venueId` indefinido borraría las comandas de todas las pruebas (Codex r1 #8).
  if (venueId) {
    await prisma.kdsOrder.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.printStation.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
  }
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
})

/** Una cuenta con su ronda ya enviada (`sentToKitchenAt`): un taco y una limonada, cada uno en su asiento. */
async function cuenta(extra: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  n += 1
  const renglon = (productId: string, productName: string, seat: number, i: number) => ({
    productId,
    productName,
    quantity: 1,
    seat,
    unitPrice: new Prisma.Decimal(50),
    taxAmount: new Prisma.Decimal(0),
    total: new Prisma.Decimal(50),
    sentToKitchenAt: new Date(),
    externalId: `sync:rk-${n}-${SUF}:${i}`,
  })
  const o = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `C${n}-${SUF}`,
      subtotal: 100,
      taxAmount: 0,
      total: 100,
      items: { create: [renglon(taco, 'Taco', 1, 0), renglon(limonada, 'Limonada', 2, 1)] },
      ...extra,
    },
    select: { id: true, items: { select: { id: true, productId: true } } },
  })
  const idDe = (productId: string) => o.items.find(i => i.productId === productId)!.id
  return { id: o.id, tacoId: idDe(taco), limonadaId: idDe(limonada) }
}

/** La marca heredada lleva la hora del movimiento (no la vieja): el barrido no se rinde antes de armarla (Codex r1 #6). */
const marcaNueva = (marca: Date | null, antes: Date) => expect(marca?.getTime()).toBeGreaterThanOrEqual(antes.getTime())

const marcaDe = async (orderId: string) =>
  (await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { kitchenPendingAt: true } })).kitchenPendingAt

/** La fila de comanda de un renglón, con su cabecera. */
const filaDe = (orderItemId: string) =>
  prisma.kdsOrderItem.findFirst({ where: { orderItemId, kdsOrder: { venueId } }, include: { kdsOrder: true } })

/** Una comanda de preparación por producto (v1) armada a mano para los dos renglones de la cuenta. */
async function comandaV1(c: Awaited<ReturnType<typeof cuenta>>) {
  return prisma.kdsOrder.create({
    data: {
      venueId,
      orderId: c.id,
      orderNumber: `C-${c.id}`,
      sourceKey: `order:${c.id}:${cocina}`,
      printStationId: cocina,
      preparationVersion: PREPARATION_VERSION,
      status: 'NEW',
      items: {
        create: [
          { productName: 'Taco', quantity: 1, orderItemId: c.tacoId, preparation: initialPreparation(1, 'IMMEDIATE') as any },
          { productName: 'Limonada', quantity: 1, orderItemId: c.limonadaId, preparation: initialPreparation(1, 'IMMEDIATE') as any },
        ],
      },
    },
  })
}

describe('la pieza por mandarse sigue a su renglón al dividir o unir (B1–B3)', () => {
  it('B1 · dividir por producto: la cuenta nueva hereda la marca y el barrido le arma la pieza', async () => {
    const marca = new Date(Date.now() - 60_000) // el gancho de la ronda falló
    const a = await cuenta({ kitchenPendingAt: marca })
    const antes = new Date()
    const { created } = await splitOrderItems(venueId, a.id, [a.tacoId])

    marcaNueva(await marcaDe(created.id), antes)
    expect((await authorKitchenTickets({ venueId, orderId: created.id, trigger: 'SWEEP' })).ticketIds).toHaveLength(1)
    expect((await filaDe(a.tacoId))?.kdsOrder.orderId).toBe(created.id)
    expect(await marcaDe(created.id)).toBeNull()
  })

  it('B2 · dividir por asiento: cada cuenta nueva hereda la marca', async () => {
    const marca = new Date(Date.now() - 60_000)
    const a = await cuenta({ kitchenPendingAt: marca })
    const antes = new Date()
    const { created } = await splitOrderBySeat(venueId, a.id)

    expect(created).toHaveLength(1)
    marcaNueva(await marcaDe(created[0].id), antes)
    await authorKitchenTickets({ venueId, orderId: created[0].id, trigger: 'SWEEP' })
    expect((await filaDe(a.limonadaId))?.kdsOrder.orderId).toBe(created[0].id)
  })

  it('B3 · unir A en B: B recibe la marca de A y el barrido le arma la pieza', async () => {
    const marca = new Date(Date.now() - 60_000)
    const a = await cuenta({ kitchenPendingAt: marca })
    const b = await cuenta()
    await authorKitchenTickets({ venueId, orderId: b.id, trigger: 'ROUND' }) // lo de B ya está en pantalla
    const antes = new Date()
    await mergeOrders(venueId, b.id, a.id)

    marcaNueva(await marcaDe(b.id), antes)
    await authorKitchenTickets({ venueId, orderId: b.id, trigger: 'SWEEP' })
    expect((await filaDe(a.tacoId))?.kdsOrder.orderId).toBe(b.id)
    expect((await filaDe(a.limonadaId))?.kdsOrder.orderId).toBe(b.id)
  })

  it('regresión · el origen sin marca no le toca la suya al destino', async () => {
    const marcaB = new Date(Date.now() - 30_000)
    const a = await cuenta()
    const b = await cuenta({ kitchenPendingAt: marcaB })
    await mergeOrders(venueId, b.id, a.id)
    expect(await marcaDe(b.id)).toEqual(marcaB)
  })

  it('regresión · sin marca en el origen, la cuenta nueva nace sin marca', async () => {
    const a = await cuenta()
    const { created } = await splitOrderItems(venueId, a.id, [a.tacoId])
    expect(await marcaDe(created.id)).toBeNull()
  })
})

describe('anular sólo retira lo que es de la cuenta anulada (B4, B5)', () => {
  it('B4 · comanda de A; el taco se pasa a B y se anula A: el taco sigue en pantalla, ahora de B', async () => {
    const a = await cuenta()
    await authorKitchenTickets({ venueId, orderId: a.id, trigger: 'ROUND' })
    const original = (await filaDe(a.tacoId))!.kdsOrder
    const { created } = await splitOrderItems(venueId, a.id, [a.tacoId])

    await cancelOrder(venueId, a.id, 'Se fue')

    const taco = await filaDe(a.tacoId)
    expect(taco?.kdsOrder.orderId).toBe(created.id)
    expect(taco?.kdsOrder.status).toBe(original.status)
    expect(taco?.kdsOrder.printStationId).toBe(cocina)
    expect(taco?.kdsOrder.createdAt).toEqual(original.createdAt) // no se forma al final de la fila
    expect(await filaDe(a.limonadaId)).toBeNull() // lo de A sí sale
    // Re-armar B no repite el taco: ya está cubierto.
    await authorKitchenTickets({ venueId, orderId: created.id, trigger: 'SWEEP' })
    expect(await prisma.kdsOrderItem.count({ where: { orderItemId: a.tacoId } })).toBe(1)
  })

  it('B5 · preparación por producto: anular A no cancela el taco que ya vive en B, y su comanda es de B', async () => {
    const a = await cuenta()
    const cabecera = await comandaV1(a)
    const { created } = await splitOrderItems(venueId, a.id, [a.tacoId])

    await cancelOrder(venueId, a.id, 'Se fue')

    const taco = (await filaDe(a.tacoId))!
    expect(parsePreparation(taco.preparation, 1)).toMatchObject({ PENDING: 1, CANCELLED: 0 })
    expect(taco.kdsOrder.orderId).toBe(created.id)
    expect(taco.kdsOrder.preparationVersion).toBe(PREPARATION_VERSION)
    expect(taco.kdsOrder.status).toBe('NEW')
    const limonada = (await filaDe(a.limonadaId))!
    expect(parsePreparation(limonada.preparation, 1)).toMatchObject({ PENDING: 0, CANCELLED: 1 })
    expect((await prisma.kdsOrder.findUniqueOrThrow({ where: { id: cabecera.id } })).status).toBe('COMPLETED')
  })

  it('espejo · se anula la cuenta HIJA: sale sólo lo de la hija y lo de A se queda', async () => {
    const a = await cuenta()
    await authorKitchenTickets({ venueId, orderId: a.id, trigger: 'ROUND' })
    const { created } = await splitOrderItems(venueId, a.id, [a.tacoId])

    await cancelOrder(venueId, created.id, 'Se fue')

    expect(await filaDe(a.tacoId)).toBeNull()
    const limonada = await filaDe(a.limonadaId)
    expect(limonada?.kdsOrder.orderId).toBe(a.id)
    expect(limonada?.kdsOrder.status).not.toBe('COMPLETED')
  })

  it('unir A en B pasa la comanda de A a B (mismo folio); anular B la retira', async () => {
    const a = await cuenta()
    await authorKitchenTickets({ venueId, orderId: a.id, trigger: 'ROUND' })
    const cabecera = (await filaDe(a.tacoId))!.kdsOrder
    const b = await cuenta()
    await mergeOrders(venueId, b.id, a.id)

    const movida = await prisma.kdsOrder.findUniqueOrThrow({ where: { id: cabecera.id } })
    expect(movida.orderId).toBe(b.id)
    expect(movida.sourceKey).toBe(cabecera.sourceKey)

    await cancelOrder(venueId, b.id, 'Se fueron')
    expect(await filaDe(a.tacoId)).toBeNull()
    expect(await filaDe(a.limonadaId)).toBeNull()
  })

  it('regresión · anular una cuenta con todo suyo retira su comanda como siempre', async () => {
    const a = await cuenta()
    await authorKitchenTickets({ venueId, orderId: a.id, trigger: 'ROUND' })
    await cancelOrder(venueId, a.id, 'Mesa equivocada')
    expect(await prisma.kdsOrder.count({ where: { venueId, orderId: a.id, status: { not: 'COMPLETED' } } })).toBe(0)
    expect(await filaDe(a.tacoId)).toBeNull()
  })

  it('dividir y luego unir la hija en otra cuenta: su comanda sigue a la que queda (Codex r1 #5)', async () => {
    const a = await cuenta()
    await authorKitchenTickets({ venueId, orderId: a.id, trigger: 'ROUND' })
    const { created: b } = await splitOrderItems(venueId, a.id, [a.tacoId])
    const c = await cuenta()
    await mergeOrders(venueId, c.id, b.id)

    expect((await filaDe(a.tacoId))?.kdsOrder.orderId).toBe(c.id)
    await cancelOrder(venueId, a.id, 'Se fue')
    expect((await filaDe(a.tacoId))?.kdsOrder.orderId).toBe(c.id)
    expect(await filaDe(a.limonadaId)).toBeNull()
  })

  it('anular la hija recalcula, con el candado de la original, su comanda (Codex r1 #1 y r3)', async () => {
    const a = await cuenta()
    const cabecera = await comandaV1(a)
    const entregada = { HELD: 0, PENDING: 0, PREPARING: 0, READY: 0, DELIVERED: 1, CANCELLED: 0 }
    await prisma.kdsOrderItem.updateMany({ where: { orderItemId: a.limonadaId }, data: { preparation: entregada } })
    const { created } = await splitOrderItems(venueId, a.id, [a.tacoId])

    await cancelOrder(venueId, created.id, 'Se fue')

    expect(parsePreparation((await filaDe(a.tacoId))!.preparation, 1)).toMatchObject({ PENDING: 0, CANCELLED: 1 })
    // A sólo conserva la limonada ya entregada: su comanda queda terminada, calculada bajo el candado de A.
    const deA = await prisma.kdsOrder.findUniqueOrThrow({ where: { id: cabecera.id }, include: { items: true } })
    expect(deA.orderId).toBe(a.id)
    expect(deA.items.map(i => i.orderItemId)).toEqual([a.limonadaId])
    expect(deA.status).toBe('COMPLETED')
  })

  it('más de 1,000 platillos que viven en otra cuenta no se pierden al anular (Codex r1 #7)', async () => {
    n += 1
    const total = 1500
    const o = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `MIL-${SUF}`,
        subtotal: 50 * total,
        taxAmount: 0,
        total: 50 * total,
        items: {
          create: Array.from({ length: total }, (_, i) => ({
            productId: taco,
            productName: `Taco ${i}`,
            quantity: 1,
            unitPrice: new Prisma.Decimal(50),
            taxAmount: new Prisma.Decimal(0),
            total: new Prisma.Decimal(50),
            sentToKitchenAt: new Date(),
            externalId: `sync:rk-mil-${SUF}:${i}`,
          })),
        },
      },
      select: { id: true, items: { select: { id: true }, orderBy: { id: 'asc' } } },
    })
    await authorKitchenTickets({ venueId, orderId: o.id, trigger: 'ROUND' })
    const aMover = o.items.slice(1).map(i => i.id)
    const { created } = await splitOrderItems(venueId, o.id, aMover)

    await cancelOrder(venueId, o.id, 'Se fue')

    expect(await prisma.kdsOrderItem.count({ where: { orderItemId: { in: aMover }, kdsOrder: { venueId, orderId: created.id } } })).toBe(
      total - 1,
    )
    expect(await prisma.kdsOrderItem.count({ where: { orderItemId: o.items[0].id } })).toBe(0)
  })

  it('anular A espera el candado de comandas de B antes de moverle la pieza (Codex r3, contra Postgres)', async () => {
    const a = await cuenta()
    await authorKitchenTickets({ venueId, orderId: a.id, trigger: 'ROUND' })
    const { created: b } = await splitOrderItems(venueId, a.id, [a.tacoId])

    // Otra caja tiene tomado el candado de comandas de B (como al unir B en otra cuenta) y no ha terminado.
    const aparcada = aparcarLaSiguienteTransaccion(prisma)
    let anular: Promise<unknown> | undefined
    try {
      const otraCaja = prisma.$transaction(async tx => tomarCandadoDeComandas(tx, b.id))
      const pidOtraCaja = await aTiempo(aparcada.pid, 10_000, 'la otra caja no tomó el candado')
      anular = cancelOrder(venueId, a.id, 'Se fue')
      const espera = await esperarBloqueado(prisma, { bloqueadoPor: [pidOtraCaja], consulta: /pg_advisory_xact_lock/ })
      expect(espera).not.toBeNull() // la anulación espera ese candado…
      expect((await filaDe(a.tacoId))?.kdsOrder.orderId).toBe(a.id) // …sin haber movido nada todavía
      aparcada.soltar()
      await otraCaja
      await aTiempo(anular, 15_000, 'la anulación no terminó')
    } finally {
      aparcada.soltar()
      aparcada.restaurar()
      await anular?.catch(() => undefined)
    }
    expect((await filaDe(a.tacoId))?.kdsOrder.orderId).toBe(b.id)
    expect(await filaDe(a.limonadaId)).toBeNull()
  })

  it('dividir espera el candado de comandas de la cuenta, como el borrado del panel (Codex r4 #1, contra Postgres)', async () => {
    const a = await cuenta()
    await authorKitchenTickets({ venueId, orderId: a.id, trigger: 'ROUND' })

    // El panel empezó a borrar A: ya tiene su candado de comandas y todavía no termina.
    const aparcada = aparcarLaSiguienteTransaccion(prisma)
    let dividir: Promise<unknown> | undefined
    try {
      const panel = prisma.$transaction(async tx => tomarCandadoDeComandas(tx, a.id))
      const pidPanel = await aTiempo(aparcada.pid, 10_000, 'el panel no tomó el candado')
      dividir = splitOrderItems(venueId, a.id, [a.tacoId])
      expect(await esperarBloqueado(prisma, { bloqueadoPor: [pidPanel], consulta: /pg_advisory_xact_lock/ })).not.toBeNull()
      expect(await prisma.orderItem.count({ where: { id: a.tacoId, orderId: a.id } })).toBe(1) // todavía no movió nada
      aparcada.soltar()
      await panel
      await aTiempo(dividir, 15_000, 'la división no terminó')
    } finally {
      aparcada.soltar()
      aparcada.restaurar()
      await dividir?.catch(() => undefined)
    }
    expect(await prisma.orderItem.count({ where: { id: a.tacoId, orderId: a.id } })).toBe(0)
  })

  it('regresión · una comanda ya TERMINADA no se mueve ni se borra', async () => {
    const a = await cuenta()
    await authorKitchenTickets({ venueId, orderId: a.id, trigger: 'ROUND' })
    const cabecera = (await filaDe(a.tacoId))!.kdsOrder
    await prisma.kdsOrder.update({ where: { id: cabecera.id }, data: { status: 'COMPLETED', completedAt: new Date() } })
    await splitOrderItems(venueId, a.id, [a.tacoId])
    await cancelOrder(venueId, a.id, 'Se fue')
    expect((await filaDe(a.tacoId))?.kdsOrder.id).toBe(cabecera.id)
    expect((await filaDe(a.limonadaId))?.kdsOrder.id).toBe(cabecera.id)
  })
})

/**
 * hz:381780f0:D3: unir y anular la misma cuenta a la vez ya no se interbloquea. Antes unir tomaba el candado de comandas del
 * destino A MEDIA transacción (ya con las cuentas tomadas) y anular el de sus cuentas ligadas también; Postgres cortaba una (40P01)
 * y `withDeadlockRetry` la repetía. Promesa: docs/audit/2026-11-10-unir-sin-interbloqueo/promesa.md (workspace).
 */
describe('unir y anular a la vez, sin interbloqueo (hz:381780f0:D3, contra Postgres)', () => {
  /** Cuántas veces `withDeadlockRetry` repitió por 40P01 (se cuenta ANTES de `mockRestore`, que borra las llamadas). */
  const interbloqueos = (avisos: jest.SpyInstance) => avisos.mock.calls.filter(([m]) => String(m).includes('40P01')).length

  it('unir A en B mientras se anula B: la anulación se forma detrás de la unión y las dos terminan', async () => {
    const a = await cuenta()
    await authorKitchenTickets({ venueId, orderId: a.id, trigger: 'ROUND' })
    const b = await cuenta()
    const avisos = jest.spyOn(logger, 'warn')
    let repetidas = -1

    // Otra caja tiene apartado el taco de A: la unión se detiene al mover los renglones, ya con las dos cuentas tomadas.
    const aparcada = aparcarLaSiguienteTransaccion(prisma)
    let unir: Promise<unknown> | undefined
    let anular: Promise<unknown> | undefined
    try {
      const otraCaja = prisma.$transaction(tx => tx.$queryRaw`SELECT id FROM "OrderItem" WHERE id = ${a.tacoId} FOR NO KEY UPDATE`)
      const pidOtraCaja = await aTiempo(aparcada.pid, 10_000, 'la otra caja no apartó el taco')
      unir = mergeOrders(venueId, b.id, a.id)
      const unirEspera = await esperarBloqueado(prisma, { bloqueadoPor: [pidOtraCaja], consulta: /OrderItem/ })
      expect(unirEspera).not.toBeNull()
      anular = cancelOrder(venueId, b.id, 'Se fueron')
      expect(await esperarBloqueado(prisma, { bloqueadoPor: [unirEspera!.pid], consulta: /./, excepto: [pidOtraCaja] })).not.toBeNull()
      aparcada.soltar()
      await otraCaja
      const [u, c] = await aTiempo(Promise.allSettled([unir, anular]), 20_000, 'unir o anular no terminó')
      expect(u.status).toBe('fulfilled')
      expect(c.status).toBe('fulfilled')
    } finally {
      aparcada.soltar()
      aparcada.restaurar()
      await Promise.allSettled([unir, anular])
      repetidas = interbloqueos(avisos)
      avisos.mockRestore()
    }
    expect(repetidas).toBe(0)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('CANCELLED')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('CANCELLED')
    expect(await filaDe(a.tacoId)).toBeNull()
    expect(await filaDe(a.limonadaId)).toBeNull()
  })

  it('anular la hija mientras se une de vuelta en la original: sin ciclo nuevo cuando la original va primero', async () => {
    const a = await cuenta()
    await authorKitchenTickets({ venueId, orderId: a.id, trigger: 'ROUND' })
    const { created } = await splitOrderItems(venueId, a.id, [a.tacoId]) // el taco de la hija sigue en la comanda de A
    const hija = created.id
    expect(a.id < hija).toBe(true) // la original va primero en el orden de los candados (cuid crece con el tiempo)
    const avisos = jest.spyOn(logger, 'warn')
    let repetidas = -1

    // Otra caja tiene tomada la fila de la hija: la anulación se detiene ahí, ya con sus candados de comandas.
    const aparcada = aparcarLaSiguienteTransaccion(prisma)
    let unir: Promise<unknown> | undefined
    let anular: Promise<unknown> | undefined
    try {
      const otraCaja = prisma.$transaction(tx => tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${hija} FOR UPDATE`)
      const pidOtraCaja = await aTiempo(aparcada.pid, 10_000, 'la otra caja no tomó la hija')
      anular = cancelOrder(venueId, hija, 'Se fue')
      const anularEspera = await esperarBloqueado(prisma, { bloqueadoPor: [pidOtraCaja], consulta: /"Order"/ })
      expect(anularEspera).not.toBeNull()
      unir = mergeOrders(venueId, a.id, hija)
      expect(
        await esperarBloqueado(prisma, { bloqueadoPor: [anularEspera!.pid], consulta: /pg_advisory_xact_lock/, excepto: [pidOtraCaja] }),
      ).not.toBeNull()
      aparcada.soltar()
      await otraCaja
      const [u, c] = await aTiempo(Promise.allSettled([unir, anular]), 20_000, 'unir o anular no terminó')
      expect(c.status).toBe('fulfilled')
      // La hija ya está anulada cuando le toca a unir: lo de siempre (503 «la cuenta cambió» o 400 «cuenta anulada»), no un interbloqueo.
      expect(u.status).toBe('rejected')
      expect([400, 503]).toContain((u as PromiseRejectedResult).reason?.statusCode)
    } finally {
      aparcada.soltar()
      aparcada.restaurar()
      await Promise.allSettled([unir, anular])
      repetidas = interbloqueos(avisos)
      avisos.mockRestore()
    }
    expect(repetidas).toBe(0)
    expect(await filaDe(a.tacoId)).toBeNull() // lo de la hija sale de cocina
    expect((await filaDe(a.limonadaId))?.kdsOrder.orderId).toBe(a.id) // lo de la original se queda
  })

  it('borrar la hija desde el panel mientras se une en otra cuenta: el borrado toma sus candados de comandas en orden (Codex r1 #1)', async () => {
    const a = await cuenta()
    await authorKitchenTickets({ venueId, orderId: a.id, trigger: 'ROUND' })
    const t = await cuenta() // la cuenta que recibe; su id queda entre la original y la hija
    const { created } = await splitOrderItems(venueId, a.id, [a.tacoId]) // el taco de la hija sigue en la comanda de A
    const hija = created.id
    expect(a.id < t.id && t.id < hija).toBe(true) // unir toma comandas:A, comandas:T y comandas:hija, en ese orden
    const avisos = jest.spyOn(logger, 'warn')
    let repetidas = -1

    // Otra caja tiene el candado de comandas de T: la unión se detiene ahí, ya con el de A.
    const aparcada = aparcarLaSiguienteTransaccion(prisma)
    let unir: Promise<unknown> | undefined
    let borrar: Promise<unknown> | undefined
    try {
      const otraCaja = prisma.$transaction(async tx => tomarCandadoDeComandas(tx, t.id))
      const pidOtraCaja = await aTiempo(aparcada.pid, 10_000, 'la otra caja no tomó el candado de T')
      unir = mergeOrders(venueId, t.id, hija)
      const unirEspera = await esperarBloqueado(prisma, { bloqueadoPor: [pidOtraCaja], consulta: /pg_advisory_xact_lock/ })
      expect(unirEspera).not.toBeNull()
      borrar = deleteOrder(venueId, hija)
      // El borrado espera a la unión (en el candado de comandas de A); antes tomaba el de la hija y después pedía el de A.
      expect(
        await esperarBloqueado(prisma, { bloqueadoPor: [unirEspera!.pid], consulta: /pg_advisory_xact_lock/, excepto: [pidOtraCaja] }),
      ).not.toBeNull()
      aparcada.soltar()
      await otraCaja
      const [u, b] = await aTiempo(Promise.allSettled([unir, borrar]), 20_000, 'unir o borrar no terminó')
      expect(u.status).toBe('fulfilled')
      expect(b.status).toBe('fulfilled') // la hija ya quedó anulada por la unión: borrarla otra vez es idempotente (Codex r2 #1)
    } finally {
      aparcada.soltar()
      aparcada.restaurar()
      await Promise.allSettled([unir, borrar])
      repetidas = interbloqueos(avisos)
      avisos.mockRestore()
    }
    expect(repetidas).toBe(0)
    expect((await filaDe(a.tacoId))?.kdsOrder.orderId).toBe(t.id) // el taco se fue con la unión
    expect((await filaDe(a.limonadaId))?.kdsOrder.orderId).toBe(a.id)
  })
})
