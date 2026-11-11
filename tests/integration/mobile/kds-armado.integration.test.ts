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
import { addItemsToOrder } from '@/services/tpv/order.tpv.service'

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

  // 🔴 hz:dcc49fe5:D1 · Codex r4 B10 y r5: una marca que llegó ANTES del armado no dice qué cubría (la pantalla la recibió por la red
  // local; la caja pudo cambiar la cuenta después). Se queda terminada y vacía, y lo de la venta sale en una comanda nueva y visible,
  // aunque repita lo que la pantalla ya hizo («en duda, manda»). Antes se metía en la marca y lo cambiado quedaba escondido.
  it('una marca LISTO que llegó ANTES del armado se queda terminada; lo de la venta sale en una comanda nueva y visible', async () => {
    const v = await nuevaVenta()
    const sourceKey = `sale:${v.externalId}:${barra}`
    await markKitchenTicket({ venueId, sourceKey, stationId: barra, action: 'BUMP', label: '47-001', at: new Date() })
    await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'PAID' })
    const marca = await prisma.kdsOrder.findUniqueOrThrow({
      where: { venueId_sourceKey: { venueId, sourceKey } },
      include: { items: true },
    })
    expect([marca.status, marca.orderId, marca.items]).toEqual(['COMPLETED', v.id, []])
    const enBarra = (await comandasDe(v.id)).filter(c => c.printStationId === barra && c.id !== marca.id)
    expect(enBarra.map(c => [c.status, c.items.map(i => i.productName)])).toEqual([['NEW', ['Limonada']]])
    expect(enBarra[0].sourceKey).toMatch(new RegExp(`^order:${v.id}:mas:\\d+:${barra}$`))
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

  it('un renglón de tarjeta de regalo no se arma en cocina, y la marca se limpia igual', async () => {
    const sobre = await prisma.giftCard.create({
      data: {
        venueId,
        organizationId: orgId,
        codeHash: `kds-${SUF}`,
        codeEnc: 'cifrado-de-prueba',
        codeLast4: 'ABCD',
        pageToken: `kds-pt-${SUF}`,
        initialAmount: new Prisma.Decimal(500),
        balance: new Prisma.Decimal(0),
        status: 'PENDING',
        termsVersion: '2026-10-14',
        deliveryChannel: 'PRINTED',
      },
      select: { id: true },
    })
    const v = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `TR-${SUF}`,
        subtotal: 500,
        taxAmount: 0,
        total: 500,
        kitchenPendingAt: new Date(),
        items: {
          create: [
            {
              productName: 'Tarjeta de regalo',
              quantity: 1,
              unitPrice: new Prisma.Decimal(500),
              taxAmount: new Prisma.Decimal(0),
              total: new Prisma.Decimal(500),
              ivaTratamiento: 'NO_OBJETO',
              giftCardId: sobre.id,
            },
          ],
        },
      },
      select: { id: true },
    })
    try {
      expect((await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'PAID' })).ticketIds).toEqual([])
      expect(await comandasDe(v.id)).toHaveLength(0)
      expect((await prisma.order.findUniqueOrThrow({ where: { id: v.id } })).kitchenPendingAt).toBeNull()
    } finally {
      // El `afterAll` borra el negocio: el sobre (Restrict hacia Venue) se va antes, junto con su cuenta.
      await prisma.order.delete({ where: { id: v.id } })
      await prisma.giftCard.delete({ where: { id: sobre.id } })
    }
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

// 🔴 hz:dcc49fe5:D1 — la TPV funde la pieza nueva en el mismo renglón (cambia `quantity`, conserva el id). Antes la cobertura era por
// renglón entero y el tercer café nunca llegaba a la pantalla; ahora la pantalla recibe sólo la diferencia, en su propia comanda.
describe('cantidad que sube en un renglón que ya está en la pantalla', () => {
  const tacosEnPantalla = async (orderId: string) =>
    (await comandasDe(orderId)).map(c => [c.status, c.items.filter(i => i.productName === 'Taco').map(i => i.quantity)])

  it('mostrador: 2 tacos en una comanda, la caja sube a 3 y cobra ⇒ una comanda nueva de 1; repetir no la duplica', async () => {
    folio += 1
    const v = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `SUBE-${folio}-${SUF}`,
        externalId: `ext-sube-${folio}-${SUF}`,
        subtotal: 100,
        taxAmount: 0,
        total: 100,
      },
      select: { id: true, externalId: true, version: true },
    })
    await addItemsToOrder(venueId, v.id, [{ productId: taco, quantity: 2 }], v.version)
    // Mostrador: lo arma un ROUND (aceptar un folio) — la TPV en mostrador no arma al agregar.
    expect((await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'ROUND' })).ticketIds).toHaveLength(1)
    await prisma.kdsOrder.updateMany({ where: { venueId, orderId: v.id }, data: { status: 'COMPLETED', completedAt: new Date() } })

    const { version } = await prisma.order.findUniqueOrThrow({ where: { id: v.id }, select: { version: true } })
    await addItemsToOrder(venueId, v.id, [{ productId: taco, quantity: 3 }], version) // carrito completo: reemplaza 2 → 3
    expect(await prisma.orderItem.count({ where: { orderId: v.id } })).toBe(1)

    expect((await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'PAID' })).ticketIds).toHaveLength(1)
    expect((await tacosEnPantalla(v.id)).sort()).toEqual([
      ['COMPLETED', [2]],
      ['NEW', [1]],
    ])
    const nueva = (await comandasDe(v.id)).find(c => c.status === 'NEW')!
    expect(nueva.sourceKey).toMatch(new RegExp(`^order:${v.id}:mas:\\d+:${cocina}$`))
    // Su LISTO sin red se acepta y la termina (Codex r3 #2).
    await markKitchenTicket({ venueId, sourceKey: nueva.sourceKey!, stationId: cocina, action: 'BUMP', label: null, at: new Date() })
    expect((await prisma.kdsOrder.findUniqueOrThrow({ where: { id: nueva.id } })).status).toBe('COMPLETED')

    expect((await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'SWEEP' })).ticketIds).toEqual([])
    expect((await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'LEGACY_POST' })).ticketIds).toEqual([])
    expect(await comandasDe(v.id)).toHaveLength(2)
  })

  it('mesa por la ruta de la TPV: 2 → 3 manda 1; 3 → 2 → 3 no manda nada; 3 → 4 manda 1 más', async () => {
    folio += 1
    const tableId = (
      await prisma.table.create({ data: { venueId, number: `MS-${folio}-${SUF}`, capacity: 4, qrCode: `qrs-${folio}-${SUF}` } })
    ).id
    const o = await prisma.order.create({
      data: { venueId, orderNumber: `MESA-SUBE-${folio}-${SUF}`, tableId, subtotal: 0, taxAmount: 0, total: 0 },
      select: { id: true },
    })
    const carrito = async (quantity: number) => {
      const { version } = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, select: { version: true } })
      await addItemsToOrder(venueId, o.id, [{ productId: taco, quantity }], version)
    }

    await carrito(2) // la ronda de mesa arma su comanda al guardar
    expect(await tacosEnPantalla(o.id)).toEqual([['NEW', [2]]])

    await carrito(3)
    expect((await tacosEnPantalla(o.id)).map(([, q]) => q).sort()).toEqual([[1], [2]])

    await carrito(2)
    await carrito(3)
    expect(await comandasDe(o.id)).toHaveLength(2)

    await carrito(4)
    const tacos = (await comandasDe(o.id)).flatMap(c => c.items).filter(i => i.productName === 'Taco')
    expect(tacos.map(i => i.quantity).sort()).toEqual([1, 1, 2])
    expect(new Set(tacos.map(i => i.orderItemId)).size).toBe(1) // siempre el mismo renglón de la cuenta
  })

  // Codex r3 #1: el autor nunca le suma platillos a la comanda de OTRA cuenta (terminada, saldrían escondidos).
  it('si el folio ya es de otra cuenta, la comanda sale en uno propio; repetir no la duplica', async () => {
    const a = await nuevaVenta()
    const b = await nuevaVenta()
    const ajena = await prisma.kdsOrder.create({
      data: {
        venueId,
        sourceKey: `sale:${b.externalId}:${cocina}`,
        printStationId: cocina,
        orderId: a.id,
        orderNumber: 'A',
        orderType: 'DINE_IN',
        status: 'COMPLETED',
      },
    })
    await authorKitchenTickets({ venueId, orderId: b.id, trigger: 'PAID' })
    expect(await prisma.kdsOrderItem.count({ where: { kdsOrderId: ajena.id } })).toBe(0)
    const deB = await comandasDe(b.id)
    expect(deB.map(c => c.status)).toEqual(['NEW', 'NEW'])
    expect(deB.map(c => c.sourceKey)).toEqual(
      expect.arrayContaining([expect.stringMatching(new RegExp(`^order:${b.id}:otra:[0-9a-f]{16}$`))]),
    )
    await authorKitchenTickets({ venueId, orderId: b.id, trigger: 'SWEEP' })
    expect((await comandasDe(b.id)).flatMap(c => c.items)).toHaveLength(2)
  })

  // Codex r2 #2: una comanda con preparación por producto la lleva para TODOS sus renglones; partir la diferencia de uno dejaría el
  // mismo producto en dos mecanismos. Ahí la diferencia sigue como antes (anotado en la deuda).
  it('comanda mixta con preparación por producto: subir un renglón no la parte en otra comanda', async () => {
    folio += 1
    const tableId = (
      await prisma.table.create({ data: { venueId, number: `MX-${folio}-${SUF}`, capacity: 4, qrCode: `qrx-${folio}-${SUF}` } })
    ).id
    const conTiempos = { id: 'immediate', label: 'Inmediato', kind: 'IMMEDIATE', preparationVersion: 1 }
    const o = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `MIXTA-${folio}-${SUF}`,
        tableId,
        subtotal: 150,
        taxAmount: 0,
        total: 150,
        items: { create: [renglon(taco, 'Taco', 2), renglon(taco, 'Taco', 1, { notes: 'sin cebolla', serviceCourse: conTiempos })] },
      },
      select: { id: true },
    })
    expect((await authorKitchenTickets({ venueId, orderId: o.id, trigger: 'ROUND' })).ticketIds).toHaveLength(1)
    const [antes] = await comandasDe(o.id)
    expect(antes.preparationVersion).toBe(1)
    const simple = await prisma.orderItem.findFirstOrThrow({ where: { orderId: o.id, notes: null }, select: { id: true } })
    await prisma.orderItem.update({ where: { id: simple.id }, data: { quantity: 3 } }) // la TPV funde la pieza nueva

    expect((await authorKitchenTickets({ venueId, orderId: o.id, trigger: 'ROUND' })).ticketIds).toEqual([])
    expect((await comandasDe(o.id)).flatMap(c => c.items).filter(i => i.orderItemId === simple.id)).toHaveLength(1)
  })

  // Codex r4 B8 (regresión): el carrito completo con dos entradas iguales sin externalId SUMABA a la fila (2 + 1 + 1 = 4) y, con la
  // cocina por unidades, salían 2 tacos que nadie pidió. El carrito completo es estado absoluto: la suma de sus entradas reemplaza.
  it('🔴 B8: reenviar el carrito con dos entradas iguales (1 + 1) sobre 2 ya mandados no cobra de más ni manda nada', async () => {
    folio += 1
    const tableId = (
      await prisma.table.create({ data: { venueId, number: `MB8-${folio}-${SUF}`, capacity: 4, qrCode: `qrb8-${folio}-${SUF}` } })
    ).id
    const o = await prisma.order.create({
      data: { venueId, orderNumber: `MESA-B8-${folio}-${SUF}`, tableId, subtotal: 0, taxAmount: 0, total: 0 },
      select: { id: true },
    })
    const carrito = async (items: Array<{ productId: string; quantity: number }>) => {
      const { version } = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, select: { version: true } })
      await addItemsToOrder(venueId, o.id, items, version)
    }

    await carrito([{ productId: taco, quantity: 2 }])
    expect(await tacosEnPantalla(o.id)).toEqual([['NEW', [2]]])

    await carrito([
      { productId: taco, quantity: 1 },
      { productId: taco, quantity: 1 },
    ])
    const renglones = await prisma.orderItem.findMany({ where: { orderId: o.id }, select: { quantity: true, total: true }, take: 5 })
    expect(renglones.map(r => [r.quantity, Number(r.total)])).toEqual([[2, 100]])
    expect(await tacosEnPantalla(o.id)).toEqual([['NEW', [2]]])
  })

  // Codex r4 B13: lo nuevo de una venta de mostrador caía en la comanda de su folio aunque la cocina ya la hubiera TERMINADO (o la caja
  // la hubiera mandado en papel): quedaba escondido. Una comanda cerrada nunca absorbe contenido nuevo; sale en una comanda nueva.
  // Codex r5: también la ABIERTA. Una marca la cierra sin el candado del armado (y un LISTO sin red puede llegar tarde, después de que se
  // le sumó algo): lo de otro armado nunca entra en una comanda que ya existía.
  it.each([
    ['terminada (LISTO)', 'BUMP' as const, 'antes'],
    ['en papel', 'FALLBACK_PRINTED' as const, 'antes'],
    ['abierta, y su LISTO sin red llega tarde', 'BUMP' as const, 'después'],
  ])('🔴 B13: mostrador con su comanda %s; un taco nuevo al cobrar sale en una comanda nueva y visible', async (_como, action, marca) => {
    const v = await nuevaVenta()
    expect((await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'LEGACY_POST' })).ticketIds).toHaveLength(2)
    const enCocina = `sale:${v.externalId}:${cocina}`
    const marcar = () => markKitchenTicket({ venueId, sourceKey: enCocina, stationId: cocina, action, label: null, at: new Date() })
    if (marca === 'antes') await marcar()
    await prisma.orderItem.create({ data: { orderId: v.id, ...renglon(taco, 'Taco', 1, { notes: 'sin cebolla' }) } })

    expect((await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'PAID' })).ticketIds).toHaveLength(1)
    if (marca === 'después') await marcar()
    const cerrada = await prisma.kdsOrder.findUniqueOrThrow({
      where: { venueId_sourceKey: { venueId, sourceKey: enCocina } },
      include: { items: true },
    })
    expect(cerrada.items.map(i => [i.productName, i.quantity])).toEqual([['Taco', 2]])
    const nuevas = (await comandasDe(v.id)).filter(c => c.id !== cerrada.id && c.printStationId === cocina)
    expect(nuevas.map(c => [c.status, c.fallbackPrintedAt, c.items.map(i => [i.productName, i.quantity, i.notes])])).toEqual([
      ['NEW', null, [['Taco', 1, 'sin cebolla']]],
    ])
    expect(nuevas[0].sourceKey).toMatch(new RegExp(`^order:${v.id}:mas:\\d+:${cocina}$`))

    expect((await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'SWEEP' })).ticketIds).toEqual([])
    expect((await comandasDe(v.id)).flatMap(c => c.items)).toHaveLength(3)
  })

  // Codex r4 B10: la marca cubría 2 tacos (la pantalla los recibió por la red local); antes del primer armado la caja sube a 3. Ninguna
  // marca recibe platillos: los 3 salen en una comanda nueva y visible («en duda, manda»: repetir 2 es mejor que perder el tercero), y lo
  // que salió en papel también se vuelve a ver.
  it('🔴 B10: una marca sin platillos que llegó antes del armado no esconde lo que cambió después', async () => {
    const v = await nuevaVenta()
    const enCocina = `sale:${v.externalId}:${cocina}`
    const enBarra = `sale:${v.externalId}:${barra}`
    await markKitchenTicket({ venueId, sourceKey: enCocina, stationId: cocina, action: 'BUMP', label: null, at: new Date() })
    await markKitchenTicket({ venueId, sourceKey: enBarra, stationId: barra, action: 'FALLBACK_PRINTED', label: null, at: new Date() })
    const renglonTaco = await prisma.orderItem.findFirstOrThrow({ where: { orderId: v.id, productId: taco }, select: { id: true } })
    await prisma.orderItem.update({ where: { id: renglonTaco.id }, data: { quantity: 3 } }) // la caja funde la pieza nueva

    await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'PAID' })
    const marcas = await prisma.kdsOrder.findMany({ where: { venueId, sourceKey: { in: [enCocina, enBarra] } }, include: { items: true } })
    expect(marcas.map(m => m.items)).toEqual([[], []])
    const visibles = (await comandasDe(v.id)).filter(c => !marcas.some(m => m.id === c.id))
    expect(visibles.map(c => [c.status, c.fallbackPrintedAt, c.items.map(i => [i.productName, i.quantity])]).sort()).toEqual([
      ['NEW', null, [['Limonada', 1]]],
      ['NEW', null, [['Taco', 3]]],
    ])

    expect((await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'SWEEP' })).ticketIds).toEqual([])
    expect((await comandasDe(v.id)).flatMap(c => c.items)).toHaveLength(2)
  })
})

// Estación «No lleva comanda» (plan 2026-11-10, Task 2). Va al final: crea su estación y no cambia a las de arriba.
describe('estación «No lleva comanda»', () => {
  it('preparacion_v1_no_arma_kds_para_sin_comanda: con preparación por producto, lo de la tienda no arma comanda y la marca se limpia', async () => {
    const tienda = (await prisma.printStation.create({ data: { venueId, name: 'Tienda', sendsComanda: false } })).id
    const abarrotes = (
      await prisma.menuCategory.create({ data: { venueId, name: 'Abarrotes', slug: `abarrotes-${SUF}`, printStationId: tienda } })
    ).id
    const takis = (
      await prisma.product.create({
        data: { venueId, sku: `Takis-${SUF}`, name: 'Takis', categoryId: abarrotes, price: new Prisma.Decimal(25) },
      })
    ).id
    const preparacion = { serviceCourse: { id: 'immediate', label: 'Inmediato', kind: 'IMMEDIATE', preparationVersion: 1, sortOrder: 0 } }
    const v = await nuevaVenta({
      items: { create: [renglon(taco, 'Taco', 1, preparacion), renglon(takis, 'Takis', 2, preparacion)] },
    })

    await authorKitchenTickets({ venueId, orderId: v.id, trigger: 'PAID' })

    const comandas = await comandasDe(v.id)
    expect(comandas.map(c => [c.printStationId, c.preparationVersion, c.items.map(i => i.productName)])).toEqual([[cocina, 1, ['Taco']]])
    const renglonTakis = await prisma.orderItem.findFirstOrThrow({ where: { orderId: v.id, productId: takis } })
    expect(await prisma.kdsOrderItem.count({ where: { orderItemId: renglonTakis.id } })).toBe(0)
    expect(await prisma.kdsOrder.count({ where: { venueId, printStationId: tienda } })).toBe(0)
    // La marca se limpia: lo que no lleva comanda no deja la venta «pendiente de cocina» para el barrido.
    expect((await prisma.order.findUniqueOrThrow({ where: { id: v.id } })).kitchenPendingAt).toBeNull()
  })
})
