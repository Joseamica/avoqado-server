import {
  AreaTicketInventoryReservationMode,
  AreaTicketInventoryReservationStatus,
  AreaTicketStatus,
  InventoryMethod,
  Prisma,
  StaffRole,
  TerminalStatus,
  TerminalType,
  Unit,
} from '@prisma/client'

import { createStockBatch } from '@/services/dashboard/fifoBatch.service'
import {
  addTicketToCheckout,
  createAreaTicketCheckout,
  issueAreaTicket,
  materializeAreaTicketCheckout,
} from '@/services/mobile/areaTicketV7.mobile.service'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import prisma from '@/utils/prismaClient'
import { encenderIvaPorProducto } from '@tests/__helpers__/iva-por-producto'

/**
 * D5 (pizarrón hz:0555ee15:D5, 20-nov), contra Postgres: lo que ningún vale apartó (un producto suelto, su receta, extras y rellenos) se
 * revisaba por primera vez al LIQUIDAR; con tarjeta (POS → TPV), el cobro ya había pasado y la sesión quedaba en conciliación. Ahora se
 * revisa al ARMAR la venta —antes de mandar la tarjeta o de recibir el efectivo— con la misma cuenta y el mismo 409 que la liquidación:
 * la venta no se arma y los vales siguen en la caja. La liquidación sigue igual (red de seguridad para lo que cambie después).
 */
describe('Vales V7 — D5: la existencia de lo suelto se revisa al armar la venta, antes de cobrar', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let organizationId: string
  let venueId: string
  let staffId: string
  let jamonId: string
  let papasId: string
  let papasInventoryId: string
  let quesadillaId: string
  let quesoId: string
  const issueDeviceUid = `d5-issue-${suffix}`
  const checkoutDeviceUid = `d5-caja-${suffix}`

  beforeAll(async () => {
    organizationId = (
      await prisma.organization.create({
        data: { name: `Vales D5 ${suffix}`, email: `vales-d5-${suffix}@example.com`, phone: '5555555555' },
      })
    ).id
    venueId = (
      await prisma.venue.create({ data: { organizationId, name: `Vales D5 ${suffix}`, slug: `vales-d5-${suffix}`, seatCapExempt: true } })
    ).id
    await encenderIvaPorProducto(venueId)
    staffId = (await prisma.staff.create({ data: { email: `vales-d5-staff-${suffix}@example.com`, firstName: 'Caja', lastName: 'D5' } })).id
    await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.MANAGER } })

    const area = await prisma.fulfillmentArea.create({ data: { venueId, name: `Cocina ${suffix}`, fulfillmentMode: 'HOLD_UNTIL_PAID' } })
    await prisma.terminal.createMany({
      data: [
        {
          venueId,
          name: 'Cocina',
          type: TerminalType.POS_ANDROID,
          status: TerminalStatus.ACTIVE,
          deviceUid: issueDeviceUid,
          fulfillmentAreaId: area.id,
          canIssueAreaTickets: true,
        },
        {
          venueId,
          name: 'Caja',
          type: TerminalType.POS_ANDROID,
          status: TerminalStatus.ACTIVE,
          deviceUid: checkoutDeviceUid,
          canCheckoutAreaTickets: true,
        },
      ],
    })
    await prisma.venueAreaTicketSettings.create({
      data: { venueId, enabled: true, inventoryReservationMode: AreaTicketInventoryReservationMode.HOLD_AVAILABLE_STOCK },
    })

    const category = await prisma.menuCategory.create({ data: { venueId, name: 'Comida', slug: `comida-${suffix}`, availableDays: [] } })
    const producto = (name: string, price: string, inventoryMethod: InventoryMethod) =>
      prisma.product.create({
        data: {
          venueId,
          categoryId: category.id,
          sku: `${name.toUpperCase()}-${suffix}`,
          name,
          price: new Prisma.Decimal(price),
          taxRate: new Prisma.Decimal(0),
          tags: [],
          allergens: [],
          trackInventory: true,
          inventoryMethod,
          unit: Unit.PIECE,
        },
      })
    jamonId = (await producto('Jamon', '100.00', InventoryMethod.QUANTITY)).id
    papasId = (await producto('Papas', '50.00', InventoryMethod.QUANTITY)).id
    quesadillaId = (await producto('Quesadilla', '40.00', InventoryMethod.RECIPE)).id
    await prisma.inventory.create({ data: { venueId, productId: jamonId, currentStock: new Prisma.Decimal('10.000') } })
    papasInventoryId = (await prisma.inventory.create({ data: { venueId, productId: papasId, currentStock: new Prisma.Decimal('1.000') } }))
      .id

    quesoId = (
      await prisma.rawMaterial.create({
        data: {
          venueId,
          name: `Queso ${suffix}`,
          sku: `QUESO-${suffix}`,
          category: 'OTHER',
          currentStock: new Prisma.Decimal('300.000'),
          unit: Unit.GRAM,
          unitType: 'WEIGHT',
          minimumStock: new Prisma.Decimal('0'),
          reorderPoint: new Prisma.Decimal('0'),
          costPerUnit: new Prisma.Decimal('0.05'),
          avgCostPerUnit: new Prisma.Decimal('0.05'),
        },
      })
    ).id
    await prisma.recipe.create({
      data: {
        productId: quesadillaId,
        portionYield: 1,
        totalCost: new Prisma.Decimal('5.00'),
        lines: { create: [{ rawMaterialId: quesoId, quantity: new Prisma.Decimal('100.000'), unit: Unit.GRAM, isOptional: false }] },
      },
    })
  })

  afterAll(async () => {
    if (!venueId) return
    await prisma.areaTicketFulfillment.deleteMany({ where: { fulfillmentArea: { venueId } } })
    await prisma.areaTicketPrintAttempt.deleteMany({ where: { areaTicket: { venueId } } })
    await prisma.areaTicketPaymentAttempt.deleteMany({ where: { checkoutSession: { venueId } } })
    await prisma.paymentAllocation.deleteMany({ where: { payment: { venueId } } })
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.inventoryPosting.deleteMany({ where: { venueId } })
    await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId } } })
    await prisma.rawMaterialMovement.deleteMany({ where: { venueId } })
    await prisma.areaTicketInventoryReservation.deleteMany({ where: { venueId } })
    await prisma.stockBatch.deleteMany({ where: { venueId } })
    await prisma.orderDiscount.deleteMany({ where: { order: { venueId } } })
    await prisma.orderItemModifier.deleteMany({ where: { orderItem: { order: { venueId } } } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.areaTicket.deleteMany({ where: { venueId } })
    await prisma.areaTicketCheckoutSession.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.inventory.deleteMany({ where: { venueId } })
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.rawMaterial.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.terminal.deleteMany({ where: { venueId } })
    await prisma.fulfillmentArea.deleteMany({ where: { venueId } })
    await prisma.venueAreaTicketSettings.deleteMany({ where: { venueId } })
    await prisma.staffVenue.deleteMany({ where: { venueId } })
    await prisma.venue.delete({ where: { id: venueId } })
    if (staffId) await prisma.staff.delete({ where: { id: staffId } })
    if (organizationId) await prisma.organization.delete({ where: { id: organizationId } })
    await prisma.$disconnect()
  })

  /** Un vale de `productId` en una sesión de caja propia, listo para armar. */
  const valeEnCaja = async (llave: string, productId: string) => {
    const vale = await issueAreaTicket(venueId, {
      idempotencyKey: `${llave}-vale-${suffix}`,
      deviceUid: issueDeviceUid,
      staffId,
      lines: [{ clientLineId: `${llave}-l1-${suffix}`, productId, quantity: '1' }],
    })
    const caja = await createAreaTicketCheckout(venueId, {
      idempotencyKey: `${llave}-caja-${suffix}`,
      deviceUid: checkoutDeviceUid,
      staffId,
    })
    await addTicketToCheckout(venueId, caja.id, vale.code, {
      idempotencyKey: `${llave}-claim-${suffix}`,
      deviceUid: checkoutDeviceUid,
      staffId,
    })
    return { vale, caja }
  }
  const armar = (sessionId: string, llave: string, productId: string, quantity: number) =>
    materializeAreaTicketCheckout(venueId, sessionId, {
      idempotencyKey: `${llave}-armar-${suffix}`,
      deviceUid: checkoutDeviceUid,
      staffId,
      source: 'AVOQADO_ANDROID',
      normalItems: [{ productId, quantity }],
    })
  const stockDePapas = async () => (await prisma.inventory.findUniqueOrThrow({ where: { id: papasInventoryId } })).currentStock.toFixed(3)

  it('🔴 un suelto sin existencia ⇒ el 409 de la liquidación AL ARMAR: sin orden, la sesión abierta y su vale en la caja', async () => {
    const { vale, caja } = await valeEnCaja('papas', jamonId)
    const reservasAntes = await prisma.areaTicketInventoryReservation.findMany({
      where: { areaTicketId: vale.id },
      select: { status: true, quantityBaseUnits: true },
    })

    await expect(armar(caja.id, 'papas', papasId, 2)).rejects.toMatchObject({
      statusCode: 409,
      code: 'AREA_TICKET_INSUFFICIENT_STOCK',
      message: 'No hay existencia libre suficiente de "Papas". Disponible: 1.000; requerida: 2.000.',
    })

    // Nada se armó: ni orden (no hay qué mandar a la terminal), ni movimientos; la sesión sigue abierta con su vale apartado.
    expect(await prisma.order.count({ where: { venueId } })).toBe(0)
    expect(
      await prisma.areaTicketCheckoutSession.findUniqueOrThrow({ where: { id: caja.id }, select: { status: true, orderId: true } }),
    ).toEqual({
      status: 'OPEN',
      orderId: null,
    })
    expect((await prisma.areaTicket.findUniqueOrThrow({ where: { id: vale.id } })).status).toBe(AreaTicketStatus.CLAIMED)
    expect(
      await prisma.areaTicketInventoryReservation.findMany({
        where: { areaTicketId: vale.id },
        select: { status: true, quantityBaseUnits: true },
      }),
    ).toEqual(reservasAntes)
    expect(await stockDePapas()).toBe('1.000')

    // Con existencia, la MISMA llave arma (el 409 no dejó nada guardado) y el efectivo cobra y descuenta como siempre.
    await prisma.inventory.update({ where: { id: papasInventoryId }, data: { currentStock: new Prisma.Decimal('5.000') } })
    const armada = await armar(caja.id, 'papas', papasId, 2)
    expect(armada.order?.total).toBe('200.00')
    const pago = await payCashOrder(venueId, armada.order!.id, { amount: 20000, tip: 0, staffId, idempotencyKey: `papas-pago-${suffix}` })
    expect(pago.status).toBe('COMPLETED')
    expect(await stockDePapas()).toBe('3.000')
    expect((await prisma.areaTicketInventoryReservation.findFirstOrThrow({ where: { areaTicketId: vale.id } })).status).toBe(
      AreaTicketInventoryReservationStatus.CONSUMED,
    )
  })

  it('lo que cambie DESPUÉS de armar lo sigue frenando la liquidación, con el mismo texto (la red de hoy)', async () => {
    await prisma.inventory.update({ where: { id: papasInventoryId }, data: { currentStock: new Prisma.Decimal('2.000') } })
    const { caja } = await valeEnCaja('despues', jamonId)
    const armada = await armar(caja.id, 'despues', papasId, 2)
    await prisma.inventory.update({ where: { id: papasInventoryId }, data: { currentStock: new Prisma.Decimal('1.000') } })

    await expect(
      payCashOrder(venueId, armada.order!.id, { amount: 20000, tip: 0, staffId, idempotencyKey: `despues-pago-${suffix}` }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'AREA_TICKET_INSUFFICIENT_STOCK',
      message: 'No hay existencia libre suficiente de "Papas". Disponible: 1.000; requerida: 2.000.',
    })
    expect(await stockDePapas()).toBe('1.000')
  })

  it('🔴 receta con lotes: cuenta lo que el vale consume primero de los lotes, ni un gramo más estricta que la liquidación', async () => {
    // 300 g en existencia pero sólo 190 g en lotes. El vale aparta 100 g; la liquidación los toma PRIMERO de los lotes (quedan 90 g) y
    // el suelto pide 100 g: no alcanza. Sin restar lo propio, la revisión diría «190 ≥ 100» y la tarjeta pasaría para nada.
    await createStockBatch(venueId, quesoId, { quantity: 190, unit: Unit.GRAM, costPerUnit: 0.05, receivedDate: new Date() })
    const { caja } = await valeEnCaja('queso', quesadillaId)

    await expect(armar(caja.id, 'queso', quesadillaId, 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'AREA_TICKET_INSUFFICIENT_STOCK',
      message: `Los lotes FIFO de "Queso ${suffix}" no cubren la venta. Disponible: 90.000; requerida: 100.000.`,
    })
    expect(await prisma.areaTicketCheckoutSession.findUniqueOrThrow({ where: { id: caja.id }, select: { orderId: true } })).toEqual({
      orderId: null,
    })

    // Justo lo que la liquidación necesita (200 g en lotes): se arma y el efectivo cobra, dejando los lotes en cero.
    await createStockBatch(venueId, quesoId, { quantity: 10, unit: Unit.GRAM, costPerUnit: 0.05, receivedDate: new Date() })
    const armada = await armar(caja.id, 'queso', quesadillaId, 1)
    const pago = await payCashOrder(venueId, armada.order!.id, { amount: 8000, tip: 0, staffId, idempotencyKey: `queso-pago-${suffix}` })
    expect(pago.status).toBe('COMPLETED')
    const lotes = await prisma.stockBatch.aggregate({
      where: { venueId, rawMaterialId: quesoId, status: 'ACTIVE' },
      _sum: { remainingQuantity: true },
    })
    expect(new Prisma.Decimal(lotes._sum.remainingQuantity ?? 0).toFixed(3)).toBe('0.000')
    expect((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: quesoId } })).currentStock.toFixed(3)).toBe('100.000')
  })

  it('negocio SIN apartado (NONE): lo del propio vale tampoco está apartado ⇒ la misma revisión al armar, aunque no haya sueltos', async () => {
    // La liquidación de hoy ya lo revisaba (efectivo 409, tarjeta → conciliación); ahora sale antes de cobrar. Papas: 1 en existencia.
    await prisma.venueAreaTicketSettings.update({
      where: { venueId },
      data: { inventoryReservationMode: AreaTicketInventoryReservationMode.NONE },
    })
    try {
      const vale = await issueAreaTicket(venueId, {
        idempotencyKey: `none-vale-${suffix}`,
        deviceUid: issueDeviceUid,
        staffId,
        lines: [{ clientLineId: `none-l1-${suffix}`, productId: papasId, quantity: '2' }],
      })
      const caja = await createAreaTicketCheckout(venueId, { idempotencyKey: `none-caja-${suffix}`, deviceUid: checkoutDeviceUid, staffId })
      await addTicketToCheckout(venueId, caja.id, vale.code, {
        idempotencyKey: `none-claim-${suffix}`,
        deviceUid: checkoutDeviceUid,
        staffId,
      })
      await expect(
        materializeAreaTicketCheckout(venueId, caja.id, {
          idempotencyKey: `none-armar-${suffix}`,
          deviceUid: checkoutDeviceUid,
          staffId,
          source: 'AVOQADO_ANDROID',
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'AREA_TICKET_INSUFFICIENT_STOCK',
        message: 'No hay existencia libre suficiente de "Papas". Disponible: 1.000; requerida: 2.000.',
      })
      expect((await prisma.areaTicket.findUniqueOrThrow({ where: { id: vale.id } })).status).toBe(AreaTicketStatus.CLAIMED)
    } finally {
      await prisma.venueAreaTicketSettings.update({
        where: { venueId },
        data: { inventoryReservationMode: AreaTicketInventoryReservationMode.HOLD_AVAILABLE_STOCK },
      })
    }
  })

  it('🔴 Codex r2 #1/#4: el apartado del propio vale que perdió su respaldo (lote retenido) ⇒ el rechazo de la liquidación al armar', async () => {
    // Tras la prueba de lotes: el queso tiene 100 g en existencia y 0 g en lotes. Llegan 50 g; el vale aparta 100 g (al emitir sólo se
    // mira la existencia). La liquidación consumiría ese apartado de los lotes y no alcanza: «Los lotes FIFO no cubren la reserva del
    // vale.». Antes eso salía DESPUÉS de cobrar; ahora sale al armar, sin sueltos de por medio.
    await createStockBatch(venueId, quesoId, { quantity: 50, unit: Unit.GRAM, costPerUnit: 0.05, receivedDate: new Date() })
    const vale = await issueAreaTicket(venueId, {
      idempotencyKey: `respaldo-vale-${suffix}`,
      deviceUid: issueDeviceUid,
      staffId,
      lines: [{ clientLineId: `respaldo-l1-${suffix}`, productId: quesadillaId, quantity: '1' }],
    })
    const caja = await createAreaTicketCheckout(venueId, {
      idempotencyKey: `respaldo-caja-${suffix}`,
      deviceUid: checkoutDeviceUid,
      staffId,
    })
    await addTicketToCheckout(venueId, caja.id, vale.code, {
      idempotencyKey: `respaldo-claim-${suffix}`,
      deviceUid: checkoutDeviceUid,
      staffId,
    })
    const armarSinSueltos = () =>
      materializeAreaTicketCheckout(venueId, caja.id, {
        idempotencyKey: `respaldo-armar-${suffix}`,
        deviceUid: checkoutDeviceUid,
        staffId,
        source: 'AVOQADO_ANDROID',
      })

    await expect(armarSinSueltos()).rejects.toMatchObject({
      statusCode: 409,
      code: 'AREA_TICKET_INVENTORY_FINALIZATION_FAILED',
      message: 'Los lotes FIFO no cubren la reserva del vale.',
    })
    expect(await prisma.areaTicketCheckoutSession.findUniqueOrThrow({ where: { id: caja.id }, select: { orderId: true } })).toEqual({
      orderId: null,
    })

    await createStockBatch(venueId, quesoId, { quantity: 50, unit: Unit.GRAM, costPerUnit: 0.05, receivedDate: new Date() })
    const armada = await armarSinSueltos()
    const pago = await payCashOrder(venueId, armada.order!.id, { amount: 4000, tip: 0, staffId, idempotencyKey: `respaldo-pago-${suffix}` })
    expect(pago.status).toBe('COMPLETED')
    expect((await prisma.areaTicketInventoryReservation.findFirstOrThrow({ where: { areaTicketId: vale.id } })).status).toBe(
      AreaTicketInventoryReservationStatus.CONSUMED,
    )
  })
})
