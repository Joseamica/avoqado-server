/**
 * Etapa 3 del KDS (spec 2026-09-27 §1-§2): el servidor arma la comanda oficial por estación con pantalla, una
 * sola vez aunque lo pidan dos a la vez, y respeta lo que las marcas (LISTO sin red, «salió en papel») dijeron.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { buildPrintConfig, routingConfigFrom } from '@/services/printing/printConfig.service'
import { estacionesDelNegocio } from '@/services/kds/kitchenDisplayStations'
import { authorKitchenTickets, markKitchenTicket } from '@/services/kds/kitchenTicketAuthoring.service'
import { cancelOrder } from '@/services/mobile/order.mobile.service'
import { deleteOrder } from '@/services/dashboard/order.dashboard.service'

const SUF = `kdsarmado-${Date.now()}`
const haceUnaHora = new Date(Date.now() - 60 * 60 * 1000)
let orgId: string
let venueId: string
let cocina: string
let barra: string
let taco: string
let limonada: string
let papas: string
let folio = 0

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Armado ${SUF}`, email: `${SUF}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `V ${SUF}`, slug: `v-${SUF}` } })).id
  cocina = (
    await prisma.printStation.create({
      data: { venueId, name: 'Cocina', isDefault: true, hasKitchenDisplay: true, kitchenDisplaySince: haceUnaHora },
    })
  ).id
  barra = (
    await prisma.printStation.create({ data: { venueId, name: 'Barra', hasKitchenDisplay: true, kitchenDisplaySince: haceUnaHora } })
  ).id
  const soloPapel = (await prisma.printStation.create({ data: { venueId, name: 'Freidora' } })).id
  const categoria = (await prisma.menuCategory.create({ data: { venueId, name: 'Comida', slug: `comida-${SUF}` } })).id
  const producto = async (name: string, printStationId: string | null) =>
    (
      await prisma.product.create({
        data: { venueId, sku: `${name}-${SUF}`, name, categoryId: categoria, price: new Prisma.Decimal(50), printStationId },
      })
    ).id
  taco = await producto('Taco', null) // cae en la default (Cocina)
  limonada = await producto('Limonada', barra)
  papas = await producto('Papas', soloPapel)
})

afterAll(async () => {
  if (!orgId) return
  await prisma.kdsOrder.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.table.deleteMany({ where: { venueId } })
  // Cadena del vale de área (V7): AreaTicket restringe contra FulfillmentArea y Terminal, así que se borra
  // primero (cascada a AreaTicketLine) y luego sus padres.
  await prisma.areaTicket.deleteMany({ where: { venueId } })
  await prisma.fulfillmentArea.deleteMany({ where: { venueId } })
  await prisma.terminal.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.printStation.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

const renglon = (productId: string, productName: string, quantity: number, extra: Record<string, unknown> = {}) => ({
  productId,
  productName,
  quantity,
  unitPrice: new Prisma.Decimal(50),
  taxAmount: new Prisma.Decimal(0),
  total: new Prisma.Decimal(50 * quantity),
  ...extra,
})

/** Una venta de mostrador cobrada: 2 tacos, 1 limonada y papas (éstas sólo van a papel). */
async function nuevaVenta(extra: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  folio += 1
  return prisma.order.create({
    data: {
      venueId,
      orderNumber: `V-${folio}-${SUF}`,
      externalId: `ext-${folio}-${SUF}`,
      subtotal: 200,
      taxAmount: 0,
      total: 200,
      kitchenPendingAt: new Date(),
      items: { create: [renglon(taco, 'Taco', 2), renglon(limonada, 'Limonada', 1), renglon(papas, 'Papas', 1)] },
      ...extra,
    },
    select: { id: true, externalId: true },
  })
}

const comandasDe = (orderId: string) =>
  prisma.kdsOrder.findMany({ where: { venueId, orderId }, include: { items: true }, orderBy: { sourceKey: 'asc' }, take: 20 })

describe('authorKitchenTickets', () => {
  it('F06: fallo en la segunda página revierte comandas y conserva la marca para reintentar', async () => {
    const v = await nuevaVenta({ items: { create: Array.from({ length: 501 }, () => renglon(taco, 'Taco', 1)) } })
    const originalTx = prisma.$transaction.bind(prisma) as any
    const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((callback: any, options: any) =>
      originalTx(async (tx: any) => {
        const create = tx.kdsOrderItem.createMany.bind(tx.kdsOrderItem)
        let pages = 0
        tx.kdsOrderItem.createMany = (args: any) => {
          if (++pages === 2) throw new Error('F06 page fault')
          return create(args)
        }
        return callback(tx)
      }, options)) as any)
    try {
      await expect(authorKitchenTickets({ venueId, orderId: v.id, trigger: 'PAID' })).rejects.toThrow('F06 page fault')
    } finally {
      spy.mockRestore()
    }
    expect(await comandasDe(v.id)).toHaveLength(0)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: v.id } })).kitchenPendingAt).not.toBeNull()
    expect(await prisma.orderItem.count({ where: { orderId: v.id, sentToKitchenAt: { not: null } } })).toBe(0)
    await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'SWEEP' })
    expect((await comandasDe(v.id)).flatMap(c => c.items)).toHaveLength(501)
  })

  it.each([501, 1001])('F06: %i renglones empatados llegan completos, sin duplicarse al repetir', async total => {
    const createdAt = new Date()
    const v = await nuevaVenta({
      items: { create: Array.from({ length: total }, (_, i) => renglon(taco, `Taco ${i}`, 1, { createdAt, sequence: 0 })) },
    })
    await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'PAID' })
    const ids = (await comandasDe(v.id)).flatMap(c => c.items.map(i => i.orderItemId))
    expect(ids).toHaveLength(total)
    expect(new Set(ids).size).toBe(total)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: v.id } })).kitchenPendingAt).toBeNull()
    await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'SWEEP' })
    expect((await comandasDe(v.id)).flatMap(c => c.items)).toHaveLength(total)
  })

  it('arma una comanda por estación con pantalla, con los ids para rutear, sella el envío y limpia la marca', async () => {
    const v = await nuevaVenta()
    const { ticketIds } = await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'PAID' })
    expect(ticketIds).toHaveLength(2)

    const comandas = await comandasDe(v.id)
    expect(comandas.map(c => [c.sourceKey, c.printStationId, c.items.map(i => i.productName)])).toEqual(
      expect.arrayContaining([
        [`sale:${v.externalId}:${cocina}`, cocina, ['Taco']],
        [`sale:${v.externalId}:${barra}`, barra, ['Limonada']],
      ]),
    )
    const itemTaco = comandas.flatMap(c => c.items).find(i => i.productName === 'Taco')!
    expect(itemTaco).toEqual(expect.objectContaining({ productId: taco, orderItemId: expect.any(String), quantity: 2 }))
    const renglones = await prisma.orderItem.findMany({ where: { orderId: v.id }, take: 10 })
    expect(renglones.filter(r => r.productId !== papas).every(r => r.sentToKitchenAt instanceof Date)).toBe(true)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: v.id } })).kitchenPendingAt).toBeNull()
  })

  it('repetir el armado no duplica nada', async () => {
    const v = await nuevaVenta()
    await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'PAID' })
    const segunda = await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'LEGACY_POST' })
    expect(segunda.ticketIds).toEqual([])
    const comandas = await comandasDe(v.id)
    expect(comandas).toHaveLength(2)
    expect(comandas.flatMap(c => c.items)).toHaveLength(2)
  })

  it('🔴 dos armados A LA VEZ (el gancho del cobro y el POST de una app vieja) dan los mismos platillos, sin duplicar', async () => {
    const v = await nuevaVenta()
    await Promise.all([
      authorKitchenTickets({ venueId, orderId: v.id, trigger: 'PAID' }),
      authorKitchenTickets({ venueId, orderId: v.id, trigger: 'LEGACY_POST' }),
    ])
    const comandas = await comandasDe(v.id)
    expect(comandas).toHaveLength(2)
    expect(comandas.flatMap(c => c.items)).toHaveLength(2)
  })

  it('una marca LISTO que llegó ANTES deja la comanda terminada aunque luego se arme (pegajosa)', async () => {
    const v = await nuevaVenta()
    const sourceKey = `sale:${v.externalId}:${barra}`
    await markKitchenTicket({ venueId, sourceKey, stationId: barra, action: 'BUMP', label: '47-001', at: new Date() })
    await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'PAID' })
    const comanda = await prisma.kdsOrder.findUniqueOrThrow({
      where: { venueId_sourceKey: { venueId, sourceKey } },
      include: { items: true },
    })
    expect(comanda.status).toBe('COMPLETED')
    expect(comanda.orderId).toBe(v.id)
    expect(comanda.items.map(i => i.productName)).toEqual(['Limonada'])
  })

  it('«salió en papel» después del armado la saca del tablero si seguía nueva, y nunca a una ya empezada', async () => {
    const v = await nuevaVenta()
    await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'PAID' })
    const enCocina = `sale:${v.externalId}:${cocina}`
    const enBarra = `sale:${v.externalId}:${barra}`
    await prisma.kdsOrder.update({ where: { venueId_sourceKey: { venueId, sourceKey: enBarra } }, data: { status: 'PREPARING' } })
    await markKitchenTicket({ venueId, sourceKey: enCocina, stationId: cocina, action: 'FALLBACK_PRINTED', label: null, at: new Date() })
    await markKitchenTicket({ venueId, sourceKey: enBarra, stationId: barra, action: 'FALLBACK_PRINTED', label: null, at: new Date() })
    const k = await prisma.kdsOrder.findUniqueOrThrow({ where: { venueId_sourceKey: { venueId, sourceKey: enCocina } } })
    const b = await prisma.kdsOrder.findUniqueOrThrow({ where: { venueId_sourceKey: { venueId, sourceKey: enBarra } } })
    expect(k.fallbackPrintedAt).toBeInstanceOf(Date)
    expect(b.fallbackPrintedAt).toBeNull()
  })

  it.each<[string, Partial<Prisma.OrderUncheckedCreateInput>]>([
    ['con vínculo de canal', { deliveryChannelLinkId: `link-${SUF}` }],
    ['inyectado por la plataforma', { originSystem: 'DELIVERY_PLATFORM' }],
    ['con origen de agregador', { source: 'UBER_EATS' }],
  ])('un pedido de reparto de agregador (%s) no se arma por aquí (Uber arma el suyo) y la marca se limpia', async (_caso, extra) => {
    const v = await nuevaVenta({ type: 'DELIVERY', ...extra })
    expect((await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'PAID' })).ticketIds).toEqual([])
    expect(await comandasDe(v.id)).toHaveLength(0)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: v.id } })).kitchenPendingAt).toBeNull()
  })

  it('una venta «Entrega» del propio POS (DELIVERY sin proveedor) SÍ llega a la pantalla', async () => {
    const v = await nuevaVenta({ type: 'DELIVERY' })
    expect((await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'PAID' })).ticketIds).toHaveLength(2)
    expect((await comandasDe(v.id)).every(c => c.orderType === 'DELIVERY')).toBe(true)
  })

  it.each(['CANCELLED', 'DELETED'] as const)('una venta %s no se arma (ni por el barrido) y la marca se limpia', async status => {
    const v = await nuevaVenta({ status })
    expect((await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'SWEEP' })).ticketIds).toEqual([])
    expect(await comandasDe(v.id)).toHaveLength(0)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: v.id } })).kitchenPendingAt).toBeNull()
  })

  it('reparte con la MISMA regla que la print-config de la caja', async () => {
    const { routing } = await estacionesDelNegocio(venueId)
    const deLaCaja = routingConfigFrom(await buildPrintConfig(venueId))
    expect(routing.defaultStationId).toBe(deLaCaja.defaultStationId)
    expect([...routing.activeStationIds].sort()).toEqual([...deLaCaja.activeStationIds].sort())
  })

  it('al PAGAR una mesa no se repite lo que ya se mandó en una ronda; la ronda sí lo arma', async () => {
    const tableId = (await prisma.table.create({ data: { venueId, number: `M-${SUF}`, capacity: 4, qrCode: `qr-${SUF}` } })).id
    const o = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `MESA-${SUF}`,
        tableId,
        subtotal: 50,
        taxAmount: 0,
        total: 50,
        items: { create: [renglon(taco, 'Taco', 1, { sentToKitchenAt: new Date(), externalId: 'sync:rk-pagada:0' })] },
      },
      select: { id: true },
    })
    expect((await authorKitchenTickets({ venueId, orderId: o.id, trigger: 'PAID' })).ticketIds).toEqual([])
    expect((await authorKitchenTickets({ venueId, orderId: o.id, trigger: 'ROUND' })).ticketIds).toHaveLength(1)
    expect((await comandasDe(o.id))[0].sourceKey).toBe(`round:rk-pagada:${cocina}`)
  })

  it('al PAGAR, una ronda que se quedó sin comanda (su gancho falló) conserva la marca y el barrido la arma (Codex 3.6)', async () => {
    const tableId = (await prisma.table.create({ data: { venueId, number: `M2-${SUF}`, capacity: 4, qrCode: `qr2-${SUF}` } })).id
    const o = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `MESA2-${SUF}`,
        tableId,
        subtotal: 50,
        taxAmount: 0,
        total: 50,
        kitchenPendingAt: new Date(Date.now() - 60_000),
        items: { create: [renglon(taco, 'Taco', 1, { sentToKitchenAt: new Date(), externalId: 'sync:rk-falla:0' })] },
      },
      select: { id: true },
    })
    expect((await authorKitchenTickets({ venueId, orderId: o.id, trigger: 'PAID' })).ticketIds).toEqual([])
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).kitchenPendingAt).not.toBeNull()

    expect((await authorKitchenTickets({ venueId, orderId: o.id, trigger: 'SWEEP' })).ticketIds).toHaveLength(1)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).kitchenPendingAt).toBeNull()
  })

  it.each([
    ['anular desde la app', (orderId: string) => cancelOrder(venueId, orderId, 'Mesa equivocada')],
    ['borrar desde el dashboard', (orderId: string) => deleteOrder(venueId, orderId)],
  ])('%s retira de la pantalla de cocina sus comandas pendientes (Codex 3.6)', async (_como, anular) => {
    const o = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `ANULA-${Math.random().toString(36).slice(2, 8)}-${SUF}`,
        subtotal: 50,
        taxAmount: 0,
        total: 50,
        items: { create: [renglon(taco, 'Taco', 1, { sentToKitchenAt: new Date(), externalId: `sync:rk-anula-${Math.random()}:0` })] },
      },
      select: { id: true },
    })
    expect((await authorKitchenTickets({ venueId, orderId: o.id, trigger: 'ROUND' })).ticketIds).toHaveLength(1)

    await anular(o.id)
    expect(await comandasDe(o.id)).toHaveLength(0)
  })

  it('los modificadores salen con la MISMA forma que el resto de comandas («2x Extra queso»)', async () => {
    const v = await nuevaVenta()
    const renglonTaco = await prisma.orderItem.findFirstOrThrow({ where: { orderId: v.id, productId: taco } })
    await prisma.orderItemModifier.create({
      data: { orderItemId: renglonTaco.id, name: 'Extra queso', quantity: 2, price: new Prisma.Decimal(10) },
    })
    await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'PAID' })
    const item = await prisma.kdsOrderItem.findFirstOrThrow({ where: { orderItemId: renglonTaco.id } })
    expect(JSON.parse(item.modifiers!)).toEqual(['2x Extra queso'])
  })

  // Codex 3.6 (S6): la venta por peso guarda `quantity = 1` y el peso aparte; la cocina leía «Taco ×1» sin saber cuánto.
  it('un renglón por peso lleva el peso en la comanda («0.750 kg»); los demás salen igual', async () => {
    const v = await nuevaVenta({
      items: {
        create: [
          renglon(taco, 'Arrachera', 1, { weightQuantity: new Prisma.Decimal('0.75'), weightUnit: 'KILOGRAM' }),
          renglon(limonada, 'Limonada', 1),
        ],
      },
    })
    await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'PAID' })

    const nombres = (await comandasDe(v.id)).flatMap(c => c.items.map(i => [i.productName, i.quantity]))
    expect(nombres).toEqual(
      expect.arrayContaining([
        ['Arrachera (0.750 kg)', 1],
        ['Limonada', 1],
      ]),
    )
  })

  it('un renglón de vale de área (V7) no se arma por aquí, y la marca se limpia igual', async () => {
    // Cadena mínima REAL que exige el esquema para `OrderItem.areaTicketLineId` — no se falsea el id.
    const terminalId = (await prisma.terminal.create({ data: { venueId, name: `Terminal ${SUF}`, type: 'TPV_ANDROID' } })).id
    const areaId = (await prisma.fulfillmentArea.create({ data: { venueId, name: `Área ${SUF}`, fulfillmentMode: 'IMMEDIATE' } })).id
    const areaTicket = await prisma.areaTicket.create({
      data: {
        venueId,
        fulfillmentAreaId: areaId,
        fulfillmentModeSnapshot: 'IMMEDIATE',
        code: `AT-${SUF}`,
        idempotencyKey: `idem-${SUF}`,
        sourceTerminalId: terminalId,
        subtotal: new Prisma.Decimal(50),
        taxAmount: new Prisma.Decimal(0),
        total: new Prisma.Decimal(50),
        pricingSnapshotHash: 'a'.repeat(64),
      },
      select: { id: true },
    })
    const linea = await prisma.areaTicketLine.create({
      data: {
        areaTicketId: areaTicket.id,
        clientLineId: `L-${SUF}`,
        productId: taco,
        productNameSnapshot: 'Taco',
        quantity: new Prisma.Decimal(1),
        unitPrice: new Prisma.Decimal(50),
        taxAmount: new Prisma.Decimal(0),
        total: new Prisma.Decimal(50),
      },
      select: { id: true },
    })
    const v = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `AT-${SUF}`,
        subtotal: 50,
        taxAmount: 0,
        total: 50,
        kitchenPendingAt: new Date(),
        items: { create: [renglon(taco, 'Taco', 1, { areaTicketLineId: linea.id })] },
      },
      select: { id: true },
    })
    expect((await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'PAID' })).ticketIds).toEqual([])
    expect(await comandasDe(v.id)).toHaveLength(0)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: v.id } })).kitchenPendingAt).toBeNull()
  })

  /** Crea una `AreaTicketLine` real (misma cadena que exige el schema) para marcar un renglón como vale de área. */
  async function nuevaLineaDeVale(productId: string) {
    const terminalId = (await prisma.terminal.create({ data: { venueId, name: `Terminal ${SUF}-${folio}`, type: 'TPV_ANDROID' } })).id
    const areaId = (await prisma.fulfillmentArea.create({ data: { venueId, name: `Área ${SUF}-${folio}`, fulfillmentMode: 'IMMEDIATE' } }))
      .id
    const areaTicket = await prisma.areaTicket.create({
      data: {
        venueId,
        fulfillmentAreaId: areaId,
        fulfillmentModeSnapshot: 'IMMEDIATE',
        code: `AT-${SUF}-${folio}`,
        idempotencyKey: `idem-${SUF}-${folio}`,
        sourceTerminalId: terminalId,
        subtotal: new Prisma.Decimal(50),
        taxAmount: new Prisma.Decimal(0),
        total: new Prisma.Decimal(50),
        pricingSnapshotHash: 'a'.repeat(64),
      },
      select: { id: true },
    })
    return (
      await prisma.areaTicketLine.create({
        data: {
          areaTicketId: areaTicket.id,
          clientLineId: `L-${SUF}-${folio}`,
          productId,
          productNameSnapshot: 'Limonada',
          quantity: new Prisma.Decimal(1),
          unitPrice: new Prisma.Decimal(50),
          taxAmount: new Prisma.Decimal(0),
          total: new Prisma.Decimal(50),
        },
        select: { id: true },
      })
    ).id
  }

  it('🔴 I1 · cuenta MIXTA (1 renglón de vale + 2 normales) arma UNA comanda sólo con los 2 normales', async () => {
    folio += 1
    const lineaDeVale = await nuevaLineaDeVale(limonada)
    const v = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `MIX-${folio}-${SUF}`,
        externalId: `ext-mix-${folio}-${SUF}`,
        subtotal: 150,
        taxAmount: 0,
        total: 150,
        kitchenPendingAt: new Date(),
        items: {
          create: [renglon(taco, 'Taco', 1), renglon(taco, 'Taco', 1), renglon(limonada, 'Limonada', 1, { areaTicketLineId: lineaDeVale })],
        },
      },
      select: { id: true, externalId: true },
    })

    const { ticketIds } = await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'PAID' })
    expect(ticketIds).toHaveLength(1)

    const comandas = await comandasDe(v.id)
    expect(comandas).toHaveLength(1)
    expect(comandas[0].sourceKey).toBe(`sale:${v.externalId}:${cocina}`)
    expect(comandas[0].items.map(i => i.productName)).toEqual(['Taco', 'Taco'])
    expect((await prisma.order.findUniqueOrThrow({ where: { id: v.id } })).kitchenPendingAt).toBeNull()
  })

  it('cuenta con `areaTicketCode` pero SÓLO renglones normales SÍ arma comanda (vale-orden dedicada, sin líneas de vale)', async () => {
    folio += 1
    const v = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `ATC-${folio}-${SUF}`,
        externalId: `ext-atc-${folio}-${SUF}`,
        areaTicketCode: `ATC-CODE-${folio}-${SUF}`,
        subtotal: 100,
        taxAmount: 0,
        total: 100,
        kitchenPendingAt: new Date(),
        items: { create: [renglon(taco, 'Taco', 2), renglon(limonada, 'Limonada', 1)] },
      },
      select: { id: true, externalId: true },
    })

    const { ticketIds } = await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'PAID' })
    expect(ticketIds).toHaveLength(2)

    const comandas = await comandasDe(v.id)
    expect(comandas.map(c => [c.sourceKey, c.items.map(i => i.productName)])).toEqual(
      expect.arrayContaining([
        [`sale:${v.externalId}:${cocina}`, ['Taco']],
        [`sale:${v.externalId}:${barra}`, ['Limonada']],
      ]),
    )
    expect((await prisma.order.findUniqueOrThrow({ where: { id: v.id } })).kitchenPendingAt).toBeNull()
  })
})
