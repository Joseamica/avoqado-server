/**
 * D15 (Flautas, hz:0555ee15): anular UN producto ya enviado deja su renglón en la pantalla de cocina marcado «ANULADO · » (y con
 * `removedAt`), no pendiente; deja de contar como trabajo y la comanda se recalcula. Promesa:
 * docs/audit/2026-11-20-renglon-anulado-en-cocina/promesa.md (workspace).
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { authorKitchenTickets, tomarCandadoDeComandas } from '@/services/kds/kitchenTicketAuthoring.service'
import { aTiempo, aparcarLaSiguienteTransaccion, esperarBloqueado } from '../../__helpers__/candadosDePostgres'
import { initialPreparation, parsePreparation, PREPARATION_VERSION } from '@/services/kds/kitchenPreparation'
import { listKdsOrders } from '@/services/mobile/kds.mobile.service'
import { splitOrderItems } from '@/services/mobile/order.mobile.service'
import { voidItems } from '@/services/tpv/order.tpv.service'
import { voidOrderItem } from '@/services/mobile/void-item.mobile.service'

const SUF = `kdsanulado-${Date.now()}`
const haceUnaHora = new Date(Date.now() - 60 * 60 * 1000)
let orgId: string
let venueId: string
let staffId: string
let cocina: string
let barra: string
let taco: string
let limonada: string
let agua: string
let n = 0

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Anulado ${SUF}`, email: `${SUF}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `V ${SUF}`, slug: `v-${SUF}` } })).id
  staffId = (await prisma.staff.create({ data: { email: `${SUF}@staff.test`, firstName: 'Mesero', lastName: 'D15' } })).id
  const pantalla = { hasKitchenDisplay: true, kitchenDisplaySince: haceUnaHora }
  cocina = (await prisma.printStation.create({ data: { venueId, name: 'Cocina', isDefault: true, ...pantalla } })).id
  barra = (await prisma.printStation.create({ data: { venueId, name: 'Barra', ...pantalla } })).id
  const categoria = (await prisma.menuCategory.create({ data: { venueId, name: 'Comida', slug: `comida-${SUF}` } })).id
  const producto = async (name: string, printStationId?: string) =>
    (
      await prisma.product.create({
        data: { venueId, sku: `${name}-${SUF}`, name, categoryId: categoria, price: new Prisma.Decimal(50), printStationId },
      })
    ).id
  taco = await producto('Taco')
  limonada = await producto('Limonada', barra)
  agua = await producto('Agua')
})

afterAll(async () => {
  if (venueId) {
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.kdsOrder.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.table.deleteMany({ where: { venueId } })
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.printStation.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
  }
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
})

/** Una cuenta de MESA con su ronda ya enviada (`sentToKitchenAt`). */
async function cuenta(productos: Array<[string, string]>, extra: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  n += 1
  const tableId = (await prisma.table.create({ data: { venueId, number: `${n}`, capacity: 4, qrCode: randomUUID() } })).id
  const o = await prisma.order.create({
    data: {
      venueId,
      tableId,
      orderNumber: `M${n}-${SUF}`,
      subtotal: 50 * productos.length,
      taxAmount: 0,
      total: 50 * productos.length,
      remainingBalance: 50 * productos.length,
      items: {
        create: productos.map(([productId, productName], i) => ({
          productId,
          productName,
          quantity: 1,
          unitPrice: new Prisma.Decimal(50),
          taxAmount: new Prisma.Decimal(0),
          total: new Prisma.Decimal(50),
          sentToKitchenAt: new Date(),
          externalId: `sync:rk-${n}-${SUF}:${i}`,
          sequence: i,
        })),
      },
      ...extra,
    },
    select: { id: true, version: true, items: { select: { id: true, productId: true } } },
  })
  const idDe = (productId: string) => o.items.find(i => i.productId === productId)!.id
  return { id: o.id, version: o.version, idDe }
}

const anularEnLaTpv = async (orderId: string, itemId: string) => {
  const { version } = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { version: true } })
  return voidItems(venueId, orderId, { itemIds: [itemId], reason: 'El cliente cambió de parecer', staffId, expectedVersion: version })
}

/** La fila de comanda de un renglón, con su cabecera. */
const filaDe = (orderItemId: string) =>
  prisma.kdsOrderItem.findFirst({ where: { orderItemId, kdsOrder: { venueId } }, include: { kdsOrder: true } })

/** Lo que lee la pantalla (nueva: pide `kitchenDoneVersion=1`): la comanda del tablero que trae ese renglón. */
async function enElTablero(orderItemId: string, nueva = true) {
  const tablero = await listKdsOrders(venueId, undefined, undefined, undefined, nueva)
  const comanda = tablero.find(c => c.items.some(i => i.orderItemId === orderItemId))
  return { comanda, renglon: comanda?.items.find(i => i.orderItemId === orderItemId) }
}

/** Comanda con tiempos (v1) armada a mano para los renglones dados, con su progreso. */
async function comandaV1(orderId: string, filas: Array<{ orderItemId: string; productName: string; preparation: object }>) {
  return prisma.kdsOrder.create({
    data: {
      venueId,
      orderId,
      orderNumber: `C-${orderId}`,
      sourceKey: `order:${orderId}:${cocina}`,
      printStationId: cocina,
      preparationVersion: PREPARATION_VERSION,
      status: 'NEW',
      items: {
        create: filas.map(f => ({
          productName: f.productName,
          quantity: 1,
          orderItemId: f.orderItemId,
          preparation: f.preparation as any,
        })),
      },
    },
  })
}

const cuenta0 = { HELD: 0, PENDING: 0, PREPARING: 0, READY: 0, DELIVERED: 0, CANCELLED: 0 }

describe('comanda sencilla (v0)', () => {
  it('anular uno de dos productos de la misma comanda: sigue en el tablero, marcado ANULADO; el otro no cambia', async () => {
    const c = await cuenta([
      [taco, 'Taco'],
      [agua, 'Agua'],
    ])
    await authorKitchenTickets({ venueId, orderId: c.id, trigger: 'ROUND' })

    await anularEnLaTpv(c.id, c.idDe(agua))

    const { comanda, renglon } = await enElTablero(c.idDe(agua))
    expect(comanda?.status).toBe('NEW')
    expect(renglon?.productName).toBe('ANULADO · Agua')
    expect(renglon?.removedAt).toEqual(expect.any(String))
    const otro = comanda?.items.find(i => i.orderItemId === c.idDe(taco))
    expect(otro?.productName).toBe('Taco')
    expect(otro?.removedAt ?? null).toBeNull()
  })

  it('si el anulado era lo único de su comanda (otra estación), la comanda NO desaparece: se queda tachada hasta «Listo» (Codex r1 #3–#5)', async () => {
    const c = await cuenta([
      [taco, 'Taco'],
      [limonada, 'Limonada'],
    ])
    await authorKitchenTickets({ venueId, orderId: c.id, trigger: 'ROUND' })
    const deBarra = (await filaDe(c.idDe(limonada)))!.kdsOrder
    expect(deBarra.printStationId).toBe(barra)
    const antes = new Date()

    await anularEnLaTpv(c.id, c.idDe(limonada))

    const { comanda, renglon } = await enElTablero(c.idDe(limonada))
    expect(comanda?.id).toBe(deBarra.id)
    expect(comanda?.status).toBe('NEW')
    expect(renglon?.productName).toBe('ANULADO · Limonada')
    // El archivo del día cuenta desde la anulación, no desde que se armó (Codex r1 #7).
    const cabecera = await prisma.kdsOrder.findUniqueOrThrow({ where: { id: deBarra.id } })
    expect(cabecera.updatedAt.getTime()).toBeGreaterThanOrEqual(antes.getTime())
    expect(cabecera.archivedAt).toBeNull()
    // La del taco (cocina) sigue igual.
    expect((await enElTablero(c.idDe(taco))).renglon?.productName).toBe('Taco')
  })

  it('un renglón que ya traía marca (retiro de una plataforma) no recibe otra etiqueta', async () => {
    const c = await cuenta([
      [taco, 'Taco'],
      [agua, 'Agua'],
    ])
    await authorKitchenTickets({ venueId, orderId: c.id, trigger: 'ROUND' })
    await prisma.kdsOrderItem.updateMany({
      where: { orderItemId: c.idDe(agua) },
      data: { removedAt: haceUnaHora, productName: 'RETIRADO · Agua' },
    })

    await anularEnLaTpv(c.id, c.idDe(agua))

    const fila = (await filaDe(c.idDe(agua)))!
    expect(fila.productName).toBe('RETIRADO · Agua')
    expect(fila.removedAt).toEqual(haceUnaHora)
  })

  it('si la anulación se rechaza después (dejaría la cuenta debajo de lo cobrado), la comanda no se marca', async () => {
    const c = await cuenta(
      [
        [taco, 'Taco'],
        [agua, 'Agua'],
      ],
      { paymentStatus: 'PARTIAL', paidAmount: 80, remainingBalance: 20 },
    )
    await authorKitchenTickets({ venueId, orderId: c.id, trigger: 'ROUND' })

    await expect(anularEnLaTpv(c.id, c.idDe(agua))).rejects.toThrow()

    const fila = (await filaDe(c.idDe(agua)))!
    expect(fila.productName).toBe('Agua')
    expect(fila.removedAt).toBeNull()
  })

  it('dividir y anular en la cuenta nueva: se marca aunque la comanda siga a nombre de la original', async () => {
    const a = await cuenta([
      [taco, 'Taco'],
      [agua, 'Agua'],
      [taco, 'Taco'],
    ])
    await authorKitchenTickets({ venueId, orderId: a.id, trigger: 'ROUND' })
    const [, segundoTaco] = (
      await prisma.orderItem.findMany({ where: { orderId: a.id, productId: taco }, orderBy: { sequence: 'asc' } })
    ).map(i => i.id)
    const { created } = await splitOrderItems(venueId, a.id, [a.idDe(agua), segundoTaco])
    expect((await filaDe(a.idDe(agua)))!.kdsOrder.orderId).toBe(a.id)

    await anularEnLaTpv(created.id, a.idDe(agua))

    const { renglon } = await enElTablero(a.idDe(agua))
    expect(renglon?.productName).toBe('ANULADO · Agua')
    expect((await filaDe(segundoTaco))!.productName).toBe('Taco')
  })
})

describe('comanda con tiempos (v1)', () => {
  it('«Anular producto» del POS: lo pendiente pasa a Cancelado, con bitácora; la comanda sigue por lo demás', async () => {
    const c = await cuenta([
      [taco, 'Taco'],
      [agua, 'Agua'],
    ])
    const cabecera = await comandaV1(c.id, [
      { orderItemId: c.idDe(taco), productName: 'Taco', preparation: initialPreparation(1, 'IMMEDIATE') },
      { orderItemId: c.idDe(agua), productName: 'Agua', preparation: initialPreparation(1, 'IMMEDIATE') },
    ])

    await voidOrderItem({ venueId, orderId: c.id, itemId: c.idDe(agua), reason: 'El cliente cambió de parecer', actorId: staffId })

    const fila = (await filaDe(c.idDe(agua)))!
    expect(fila.productName).toBe('ANULADO · Agua')
    expect(fila.removedAt).not.toBeNull()
    expect(parsePreparation(fila.preparation, 1)).toEqual({ ...cuenta0, CANCELLED: 1 })
    expect(fila.preparationRevision).toBe(1)
    const bitacora = await prisma.activityLog.findFirst({ where: { venueId, action: 'KITCHEN_ORDER_CANCEL', entityId: fila.id } })
    expect(bitacora?.data).toMatchObject({ reason: 'El cliente cambió de parecer', before: { PENDING: 1 }, after: { CANCELLED: 1 } })
    expect(bitacora?.staffId).toBe(staffId)
    const { comanda } = await enElTablero(c.idDe(taco))
    expect(comanda?.id).toBe(cabecera.id)
    expect(comanda?.status).toBe('NEW')
  })

  it('si lo demás ya está listo, la comanda sale sola del tablero (cocina terminó) con lo ya preparado en la bitácora', async () => {
    const c = await cuenta([
      [taco, 'Taco'],
      [agua, 'Agua'],
    ])
    const cabecera = await comandaV1(c.id, [
      { orderItemId: c.idDe(taco), productName: 'Taco', preparation: { ...cuenta0, READY: 1 } },
      { orderItemId: c.idDe(agua), productName: 'Agua', preparation: { ...cuenta0, PREPARING: 1 } },
    ])

    await anularEnLaTpv(c.id, c.idDe(agua))

    const despues = await prisma.kdsOrder.findUniqueOrThrow({ where: { id: cabecera.id } })
    expect(despues.status).toBe('READY') // falta que la caja entregue el taco
    expect(despues.kitchenDoneAt).not.toBeNull()
    expect((await enElTablero(c.idDe(taco))).comanda).toBeUndefined()
    expect((await enElTablero(c.idDe(taco), false)).comanda?.status).toBe('READY') // la pantalla vieja la sigue recibiendo
    const fila = (await filaDe(c.idDe(agua)))!
    const bitacora = await prisma.activityLog.findFirst({ where: { venueId, action: 'KITCHEN_ORDER_CANCEL', entityId: fila.id } })
    expect(bitacora?.data).toMatchObject({ before: { PREPARING: 1 }, after: { CANCELLED: 1 } })
  })

  it('lo ya listo también se cancela (no se sirve) y lo ya entregado se queda entregado', async () => {
    const c = await cuenta([
      [taco, 'Taco'],
      [agua, 'Agua'],
      [limonada, 'Limonada'],
    ])
    await comandaV1(c.id, [
      { orderItemId: c.idDe(taco), productName: 'Taco', preparation: initialPreparation(1, 'IMMEDIATE') },
      { orderItemId: c.idDe(agua), productName: 'Agua', preparation: { ...cuenta0, READY: 1 } },
      { orderItemId: c.idDe(limonada), productName: 'Limonada', preparation: { ...cuenta0, DELIVERED: 1 } },
    ])

    await anularEnLaTpv(c.id, c.idDe(agua))
    await anularEnLaTpv(c.id, c.idDe(limonada))

    expect(parsePreparation((await filaDe(c.idDe(agua)))!.preparation, 1)).toEqual({ ...cuenta0, CANCELLED: 1 })
    const entregada = (await filaDe(c.idDe(limonada)))!
    expect(parsePreparation(entregada.preparation, 1)).toEqual({ ...cuenta0, DELIVERED: 1 })
    expect(entregada.productName).toBe('ANULADO · Limonada')
    expect(entregada.preparationRevision).toBe(0)
  })
})

describe('candados y volumen (Codex r2)', () => {
  it('#1 · la comanda TERMINADA de otra cuenta: anular espera su candado («Reabrir» la revive) y no marca antes', async () => {
    const a = await cuenta([
      [taco, 'Taco'],
      [agua, 'Agua'],
      [taco, 'Taco'],
    ])
    await authorKitchenTickets({ venueId, orderId: a.id, trigger: 'ROUND' })
    const cabecera = (await filaDe(a.idDe(agua)))!.kdsOrder
    await prisma.kdsOrder.update({ where: { id: cabecera.id }, data: { status: 'COMPLETED', completedAt: new Date() } })
    const [, segundoTaco] = (
      await prisma.orderItem.findMany({ where: { orderId: a.id, productId: taco }, orderBy: { sequence: 'asc' } })
    ).map(i => i.id)
    const { created: b } = await splitOrderItems(venueId, a.id, [a.idDe(agua), segundoTaco])

    // Otra caja (p. ej. «Reabrir» desde «Servicio y entregas») tiene el candado de comandas de A y no ha terminado.
    const aparcada = aparcarLaSiguienteTransaccion(prisma)
    let anular: Promise<unknown> | undefined
    try {
      const otraCaja = prisma.$transaction(async tx => tomarCandadoDeComandas(tx, a.id))
      const pid = await aTiempo(aparcada.pid, 10_000, 'la otra caja no tomó el candado')
      anular = anularEnLaTpv(b.id, a.idDe(agua))
      expect(await esperarBloqueado(prisma, { bloqueadoPor: [pid], consulta: /pg_advisory_xact_lock/ })).not.toBeNull()
      expect((await filaDe(a.idDe(agua)))!.productName).toBe('Agua') // nada marcado todavía
      aparcada.soltar()
      await otraCaja
      await aTiempo(anular, 15_000, 'la anulación no terminó')
    } finally {
      aparcada.soltar()
      aparcada.restaurar()
      await anular?.catch(() => undefined)
    }
    expect((await filaDe(a.idDe(agua)))!.productName).toBe('ANULADO · Agua')
  })

  it('#3 · anular más de 500 renglones de una vez los marca todos', async () => {
    const total = 610
    const c = await cuenta(Array.from({ length: total }, (_, i) => [taco, `Taco ${i}`] as [string, string]))
    await authorKitchenTickets({ venueId, orderId: c.id, trigger: 'ROUND' })
    const ids = (await prisma.orderItem.findMany({ where: { orderId: c.id }, orderBy: { sequence: 'asc' }, select: { id: true } })).map(
      i => i.id,
    )
    const { version } = await prisma.order.findUniqueOrThrow({ where: { id: c.id }, select: { version: true } })

    await voidItems(venueId, c.id, { itemIds: ids.slice(1), reason: 'Mesa equivocada', staffId, expectedVersion: version })

    expect(await prisma.kdsOrderItem.count({ where: { orderItemId: { in: ids.slice(1) }, removedAt: null } })).toBe(0)
    expect(
      await prisma.kdsOrderItem.count({ where: { orderItemId: { in: ids.slice(1) }, productName: { startsWith: 'ANULADO · ' } } }),
    ).toBe(total - 1)
    expect((await filaDe(ids[0]))!.removedAt).toBeNull()
  }, 60_000)
})
