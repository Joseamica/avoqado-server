import {
  AreaSettlementRoute,
  AreaTicketExternalSettlementStatus,
  AreaTicketInventoryReservationMode,
  FulfillmentMode,
  InventoryMethod,
  Prisma,
  StaffRole,
  TerminalStatus,
  TerminalType,
  Unit,
} from '@prisma/client'

import { createStockBatch } from '@/services/dashboard/fifoBatch.service'
import { confirmExternalSettlement, markExternalNotCharged } from '@/services/mobile/areaTicketExternal.mobile.service'
import { cancelAreaTicket, issueAreaTicket } from '@/services/mobile/areaTicketV7.mobile.service'
import prisma from '@/utils/prismaClient'

/**
 * Task 5 — reversa de inventario al cancelar un vale EXTERNAL ya consumido.
 *
 * Task 4 consume el inventario AL EMITIR (no al pagar): la reserva nace CONSUMED
 * con su `inventoryMovementId`. Este archivo prueba lo que pasa cuando ese vale
 * se cancela — el producto ya salió del área, así que hay que decidir si vuelve
 * a existencia o se registra como merma.
 *
 * El caso "no se puede cancelar un cobro ya CONFIRMED" se completa en Task 7
 * (necesita `confirmExternalSettlement`, que nace ahí, para poder confirmar un
 * cobro y luego intentar cancelar) — el guard `AREA_TICKET_EXTERNAL_ALREADY_CHARGED`
 * SÍ se implementa en esta tarea (ver Task 5 brief, Step 3).
 */
describe('Cancelación de un vale externo ya consumido', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let organizationId: string
  let venueId: string
  let staffId: string
  let externalAreaId: string
  let productId: string
  let externalInventoryId: string
  let externalIssueDeviceUid: string
  let issueCounter = 0
  // Rama RAW_MATERIAL (releaseRawMaterialReservation) — fix round 1: sin esto
  // ningún test ejercitaba esa rama y el lost-update de Finding 1 quedaba
  // indetectable.
  let recipeProductId: string
  let rawMaterialId: string

  beforeAll(async () => {
    const organization = await prisma.organization.create({
      data: {
        name: `Caja externa cancel ${suffix}`,
        email: `caja-externa-cancel-${suffix}@example.com`,
        phone: '5555555555',
      },
    })
    organizationId = organization.id

    const venue = await prisma.venue.create({
      data: {
        organizationId,
        name: `Caja externa cancel venue ${suffix}`,
        slug: `caja-externa-cancel-${suffix}`,
        seatCapExempt: true,
      },
    })
    venueId = venue.id

    const staff = await prisma.staff.create({
      data: {
        email: `caja-externa-cancel-staff-${suffix}@example.com`,
        firstName: 'Cancelación',
        lastName: 'Externa',
      },
    })
    staffId = staff.id
    await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.MANAGER } })

    // Área externa: otro POS cobra en su propia caja. Es la única ruta que
    // importa para esta tarea — Task 5 sólo revierte reservas CONSUMED, que
    // Task 4 únicamente produce en esta ruta.
    const externalArea = await prisma.fulfillmentArea.create({
      data: {
        venueId,
        name: `Cremería externa cancel ${suffix}`,
        fulfillmentMode: FulfillmentMode.HOLD_UNTIL_PAID,
        settlementRoute: AreaSettlementRoute.EXTERNAL,
      },
    })
    externalAreaId = externalArea.id

    externalIssueDeviceUid = `issue-external-cancel-${suffix}`
    await prisma.terminal.create({
      data: {
        venueId,
        name: 'Emisión externa cancel',
        type: TerminalType.POS_ANDROID,
        status: TerminalStatus.ACTIVE,
        deviceUid: externalIssueDeviceUid,
        fulfillmentAreaId: externalAreaId,
        canIssueAreaTickets: true,
      },
    })

    // HOLD_AVAILABLE_STOCK: obligatorio para que issueAreaTicket construya
    // reservationSpecs — sin esto no hay nada que revertir.
    await prisma.venueAreaTicketSettings.create({
      data: {
        venueId,
        enabled: true,
        inventoryReservationMode: AreaTicketInventoryReservationMode.HOLD_AVAILABLE_STOCK,
      },
    })

    const category = await prisma.menuCategory.create({
      data: { venueId, name: 'Externa cancel', slug: `caja-externa-cancel-${suffix}`, availableDays: [] },
    })
    const product = await prisma.product.create({
      data: {
        venueId,
        categoryId: category.id,
        sku: `EXT-CANCEL-${suffix}`,
        name: 'Producto cancelación externa',
        price: new Prisma.Decimal('20.00'),
        taxRate: new Prisma.Decimal(0),
        tags: [],
        allergens: [],
        soldByWeight: false,
        trackInventory: true,
        inventoryMethod: InventoryMethod.QUANTITY,
        unit: Unit.PIECE,
      },
    })
    productId = product.id
    // Stock generoso: los 3 casos consumen como mucho 2+2+1 = 5 piezas en total.
    const inventory = await prisma.inventory.create({
      data: { venueId, productId, currentStock: new Prisma.Decimal('50.000') },
    })
    externalInventoryId = inventory.id

    // Insumo + receta — para ejercitar releaseRawMaterialReservation (rama
    // RAW_MATERIAL). Un solo ingrediente, 100g por porción, así el cálculo de
    // "antes/después" es directo.
    const rawMaterial = await prisma.rawMaterial.create({
      data: {
        venueId,
        name: `Queso insumo cancel ${suffix}`,
        sku: `EXT-CANCEL-RM-${suffix}`,
        category: 'OTHER',
        currentStock: new Prisma.Decimal('5000.000'),
        unit: Unit.GRAM,
        unitType: 'WEIGHT',
        minimumStock: new Prisma.Decimal('0'),
        reorderPoint: new Prisma.Decimal('0'),
        costPerUnit: new Prisma.Decimal('0.05'),
        avgCostPerUnit: new Prisma.Decimal('0.05'),
      },
    })
    rawMaterialId = rawMaterial.id
    // consumeRawMaterialReservation asigna por FIFO de StockBatch, no
    // directo contra RawMaterial.currentStock — sin un lote ACTIVE no hay de
    // dónde asignar y la emisión truena con "Los lotes FIFO no cubren la
    // reserva del vale" antes de llegar a nada de lo que prueba este archivo.
    await createStockBatch(venueId, rawMaterialId, { quantity: 5000, unit: Unit.GRAM, costPerUnit: 0.05, receivedDate: new Date() })

    const recipeProduct = await prisma.product.create({
      data: {
        venueId,
        categoryId: category.id,
        sku: `EXT-CANCEL-RECIPE-${suffix}`,
        name: 'Producto receta cancelación externa',
        price: new Prisma.Decimal('30.00'),
        taxRate: new Prisma.Decimal(0),
        tags: [],
        allergens: [],
        soldByWeight: false,
        trackInventory: true,
        inventoryMethod: InventoryMethod.RECIPE,
        unit: Unit.PIECE,
      },
    })
    recipeProductId = recipeProduct.id

    await prisma.recipe.create({
      data: {
        productId: recipeProductId,
        portionYield: 1,
        totalCost: new Prisma.Decimal('5.00'),
        lines: {
          create: [
            {
              rawMaterialId,
              quantity: new Prisma.Decimal('100.000'),
              unit: Unit.GRAM,
              isOptional: false,
            },
          ],
        },
      },
    })
  })

  afterAll(async () => {
    if (!venueId) return
    await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId } } })
    await prisma.rawMaterialMovement.deleteMany({ where: { venueId } })
    await prisma.stockBatch.deleteMany({ where: { venueId } })
    await prisma.areaTicketInventoryReservation.deleteMany({ where: { venueId } })
    await prisma.areaTicketExternalSettlement.deleteMany({ where: { venueId } })
    await prisma.areaTicket.deleteMany({ where: { venueId } })
    await prisma.inventory.deleteMany({ where: { venueId } })
    // product cascada a Recipe → RecipeLine; rawMaterial va DESPUÉS para que
    // esas RecipeLine ya no lo referencien (su FK no cascada desde RawMaterial).
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

  async function issueExternalTicket({ quantity }: { quantity: string }) {
    issueCounter += 1
    return issueAreaTicket(venueId, {
      idempotencyKey: `issue-${suffix}-${issueCounter}`,
      deviceUid: externalIssueDeviceUid,
      lines: [{ clientLineId: 'l1', productId, quantity }],
    })
  }

  async function stockOf(inventoryId: string): Promise<Prisma.Decimal> {
    const row = await prisma.inventory.findUniqueOrThrow({ where: { id: inventoryId } })
    return row.currentStock
  }

  /**
   * Task 8 (Step 4) — un vale cuyo cobro externo quedó ASSUMED ("se dio por
   * cobrado sin verificar"). Hoy ningún código de producción produce este
   * estado todavía (es el resultado de un "asumido automático" que este plan
   * deja para una tarea futura) — así que el helper lo fuerza directo en la
   * fila, igual que el resto de este archivo fuerza `recordWasteOnCancel` por
   * `prisma.venueAreaTicketSettings.update` para armar el escenario que quiere
   * probar en vez de esperar a que exista el camino que lo produce.
   */
  async function issueAssumedExternalTicket() {
    const ticket = await issueExternalTicket({ quantity: '1' })
    await prisma.areaTicketExternalSettlement.update({
      where: { areaTicketId: ticket.id },
      data: { status: AreaTicketExternalSettlementStatus.ASSUMED },
    })
    return ticket
  }

  async function issueExternalRecipeTicket({ quantity }: { quantity: string }) {
    issueCounter += 1
    return issueAreaTicket(venueId, {
      idempotencyKey: `issue-recipe-${suffix}-${issueCounter}`,
      deviceUid: externalIssueDeviceUid,
      lines: [{ clientLineId: 'l1', productId: recipeProductId, quantity }],
    })
  }

  async function rawMaterialStockOf(): Promise<Prisma.Decimal> {
    const row = await prisma.rawMaterial.findUniqueOrThrow({ where: { id: rawMaterialId } })
    return row.currentStock
  }

  it('devuelve el stock y marca la reserva RELEASED', async () => {
    const ticket = await issueExternalTicket({ quantity: '2' })
    const before = await stockOf(externalInventoryId)

    await cancelAreaTicket(venueId, ticket.id, {
      idempotencyKey: `cancel-${suffix}-1`,
      deviceUid: externalIssueDeviceUid,
      reason: 'El cliente se arrepintió',
    })

    // Comparar en Decimal (.toFixed), no en Number: `currentStock` es
    // Decimal(x,3) y colapsarlo a float invita a un falso verde el día que la
    // cantidad no sea redonda.
    expect((await stockOf(externalInventoryId)).toFixed(3)).toBe(before.plus(2).toFixed(3))
    const r = await prisma.areaTicketInventoryReservation.findFirst({ where: { areaTicketId: ticket.id } })
    expect(r!.status).toBe('RELEASED')
    expect(r!.reversalMovementId).not.toBeNull()
  })

  it('cancelar dos veces devuelve el stock UNA sola vez', async () => {
    const ticket = await issueExternalTicket({ quantity: '2' })
    const before = await stockOf(externalInventoryId)
    const input = { idempotencyKey: `cancel-${suffix}-2`, deviceUid: externalIssueDeviceUid, reason: 'x' }

    await cancelAreaTicket(venueId, ticket.id, input)
    await cancelAreaTicket(venueId, ticket.id, input)

    // NO +4: la segunda llamada tiene que ser un no-op total.
    expect((await stockOf(externalInventoryId)).toFixed(3)).toBe(before.plus(2).toFixed(3))
    const reservation = await prisma.areaTicketInventoryReservation.findFirst({ where: { areaTicketId: ticket.id } })
    expect(await prisma.inventoryMovement.count({ where: { reference: `area-ticket-cancel:${ticket.id}` } })).toBe(1)
    expect(reservation!.status).toBe('RELEASED')
  })

  it('con recordWasteOnCancel el stock NO vuelve: se registra merma', async () => {
    await prisma.venueAreaTicketSettings.update({ where: { venueId }, data: { recordWasteOnCancel: true } })
    const ticket = await issueExternalTicket({ quantity: '1' })
    const before = await stockOf(externalInventoryId)

    await cancelAreaTicket(venueId, ticket.id, {
      idempotencyKey: `cancel-${suffix}-3`,
      deviceUid: externalIssueDeviceUid,
      reason: 'Se echó a perder',
    })

    // El brief compara esto con `.toBe(before)` a secas (referencia, no valor) —
    // typo heredado de copiar el patrón antes de corregirlo en los otros dos
    // casos. Dos lecturas de Inventory.currentStock son instancias de Decimal
    // DISTINTAS aunque el valor sea idéntico, así que una comparación por
    // referencia con `toBe` fallaría siempre, tenga cambios o no. Se aplica
    // aquí el mismo patrón `.toFixed(3)` ya corregido en los dos casos previos.
    expect((await stockOf(externalInventoryId)).toFixed(3)).toBe(before.toFixed(3))
    const r = await prisma.areaTicketInventoryReservation.findFirst({ where: { areaTicketId: ticket.id } })
    expect(r!.status).toBe('WASTE')
    expect(r!.reversalMovementId).not.toBeNull()
  })

  // ---------------------------------------------------------------------
  // Fix round 1/5 — rama RAW_MATERIAL (releaseRawMaterialReservation).
  // Finding 2 de la revisión: ningún test commiteado ejercitaba esta rama,
  // así que su bug de Finding 1 (lost-update en RawMaterial.currentStock)
  // era indetectable. Los tres casos de abajo la cubren: devolución simple,
  // merma, y la concurrencia que expone el lost-update.
  // ---------------------------------------------------------------------

  it('RAW_MATERIAL: devuelve el insumo a existencia y marca la reserva RELEASED', async () => {
    await prisma.venueAreaTicketSettings.update({ where: { venueId }, data: { recordWasteOnCancel: false } })
    const ticket = await issueExternalRecipeTicket({ quantity: '1' })
    const before = await rawMaterialStockOf()

    await cancelAreaTicket(venueId, ticket.id, {
      idempotencyKey: `cancel-recipe-${suffix}-1`,
      deviceUid: externalIssueDeviceUid,
      reason: 'El cliente se arrepintió',
    })

    // 1 porción × 100g/porción = 100g. Comparar en Decimal, no en Number.
    expect((await rawMaterialStockOf()).toFixed(3)).toBe(before.plus(100).toFixed(3))
    const r = await prisma.areaTicketInventoryReservation.findFirst({
      where: { areaTicketId: ticket.id, inventoryKind: 'RAW_MATERIAL' },
    })
    expect(r!.status).toBe('RELEASED')
    expect(r!.reversalMovementId).not.toBeNull()
  })

  it('RAW_MATERIAL con recordWasteOnCancel: el insumo NO vuelve, se registra merma', async () => {
    await prisma.venueAreaTicketSettings.update({ where: { venueId }, data: { recordWasteOnCancel: true } })
    const ticket = await issueExternalRecipeTicket({ quantity: '1' })
    const before = await rawMaterialStockOf()

    await cancelAreaTicket(venueId, ticket.id, {
      idempotencyKey: `cancel-recipe-${suffix}-2`,
      deviceUid: externalIssueDeviceUid,
      reason: 'Se echó a perder',
    })

    expect((await rawMaterialStockOf()).toFixed(3)).toBe(before.toFixed(3))
    const r = await prisma.areaTicketInventoryReservation.findFirst({
      where: { areaTicketId: ticket.id, inventoryKind: 'RAW_MATERIAL' },
    })
    expect(r!.status).toBe('WASTE')
    expect(r!.reversalMovementId).not.toBeNull()
  })

  it('RAW_MATERIAL: dos cancelaciones concurrentes contra el MISMO insumo no se pisan (Finding 1 — lost update)', async () => {
    // Nada bloquea la fila de RawMaterial entre las dos cancelaciones — sólo
    // AreaTicket, y son vales DISTINTOS. Si releaseRawMaterialReservation lee
    // currentStock sin FOR UPDATE y escribe de vuelta un valor calculado en
    // JS, la segunda escritura puede pisar a la primera silenciosamente.
    await prisma.venueAreaTicketSettings.update({ where: { venueId }, data: { recordWasteOnCancel: false } })
    const ticketA = await issueExternalRecipeTicket({ quantity: '1' }) // -100g
    const ticketB = await issueExternalRecipeTicket({ quantity: '1' }) // -100g
    const before = await rawMaterialStockOf()

    const results = await Promise.allSettled([
      cancelAreaTicket(venueId, ticketA.id, {
        idempotencyKey: `cancel-race-${suffix}-a`,
        deviceUid: externalIssueDeviceUid,
        reason: 'race a',
      }),
      cancelAreaTicket(venueId, ticketB.id, {
        idempotencyKey: `cancel-race-${suffix}-b`,
        deviceUid: externalIssueDeviceUid,
        reason: 'race b',
      }),
    ])

    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (rejected.length > 0) {
      // Diagnóstico si alguna de las dos truena — no debería con el fix, pero
      // si pasa queremos ver POR QUÉ en vez de un "toBe fulfilled" mudo.

      console.error(
        'cancelAreaTicket concurrente rechazó:',
        rejected.map(r => r.reason?.message ?? r.reason),
      )
    }
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2)

    // Las DOS cantidades deben volver — si una se pierde por el lost-update,
    // esto da +100 en vez de +200.
    expect((await rawMaterialStockOf()).toFixed(3)).toBe(before.plus(200).toFixed(3))

    const reservations = await prisma.areaTicketInventoryReservation.findMany({
      where: { areaTicketId: { in: [ticketA.id, ticketB.id] }, inventoryKind: 'RAW_MATERIAL' },
    })
    expect(reservations).toHaveLength(2)
    for (const r of reservations) {
      expect(r.status).toBe('RELEASED')
      expect(r.reversalMovementId).not.toBeNull()
    }
  })

  // ---------------------------------------------------------------------
  // Task 7 — el caso que Task 5 dejó pendiente (ver docstring del archivo):
  // el guard `AREA_TICKET_EXTERNAL_ALREADY_CHARGED` ya vivía en `cancelAreaTicket`
  // desde Task 5, pero no se podía probar sin `confirmExternalSettlement`,
  // que nace en Task 7. Ahora sí.
  // ---------------------------------------------------------------------

  it('no se puede cancelar un vale con el cobro CONFIRMED — eso es una devolución, y ocurre en la otra caja', async () => {
    const ticket = await issueExternalTicket({ quantity: '1' })
    await confirmExternalSettlement(venueId, ticket.id, {
      idempotencyKey: `conf-${suffix}`,
      deviceUid: externalIssueDeviceUid,
      staffId,
    })

    await expect(
      cancelAreaTicket(venueId, ticket.id, {
        idempotencyKey: `cx-${suffix}`,
        deviceUid: externalIssueDeviceUid,
        reason: 'ya no',
      }),
    ).rejects.toMatchObject({ code: 'AREA_TICKET_EXTERNAL_ALREADY_CHARGED' })
  })

  // ---------------------------------------------------------------------
  // Task 8 (Step 4) — el hueco que encontró la revisión de Task 7: el guard
  // de arriba sólo bloqueaba CONFIRMED. DISCREPANCY (Task 7) y ASSUMED
  // también significan "la otra caja cobró, o se dio por cobrado" — cancelar
  // encima revierte inventario de una venta que probablemente ocurrió. El
  // tercer caso prueba que no es un callejón sin salida: `markExternalNotCharged`
  // es la puerta explícita para salir de ASSUMED y sí poder cancelar después.
  // ---------------------------------------------------------------------

  it('no se puede cancelar un vale con DISCREPANCY — la otra caja cobró, aunque por otro importe', async () => {
    const ticket = await issueExternalTicket({ quantity: '1' })
    await confirmExternalSettlement(venueId, ticket.id, {
      idempotencyKey: `d-${suffix}`,
      deviceUid: externalIssueDeviceUid,
      staffId,
      externalAmount: '999.00',
    })

    await expect(
      cancelAreaTicket(venueId, ticket.id, { idempotencyKey: `dx-${suffix}`, deviceUid: externalIssueDeviceUid, reason: 'x' }),
    ).rejects.toMatchObject({ code: 'AREA_TICKET_EXTERNAL_ALREADY_CHARGED' })
  })

  it('no se puede cancelar un vale ASSUMED sin declarar primero que no se cobró', async () => {
    const ticket = await issueAssumedExternalTicket()

    await expect(
      cancelAreaTicket(venueId, ticket.id, { idempotencyKey: `ax-${suffix}`, deviceUid: externalIssueDeviceUid, reason: 'x' }),
    ).rejects.toMatchObject({ code: 'AREA_TICKET_EXTERNAL_ALREADY_CHARGED' })
  })

  it('tras marcarlo NOT_CHARGED, el mismo vale SÍ se puede cancelar y el stock vuelve', async () => {
    const ticket = await issueAssumedExternalTicket()
    await markExternalNotCharged(venueId, ticket.id, {
      idempotencyKey: `nc-${suffix}`,
      deviceUid: externalIssueDeviceUid,
      staffId,
      reason: 'El cliente no pasó a caja',
    })
    const before = await stockOf(externalInventoryId)

    await cancelAreaTicket(venueId, ticket.id, { idempotencyKey: `ok-${suffix}`, deviceUid: externalIssueDeviceUid, reason: 'no pasó' })

    expect((await stockOf(externalInventoryId)).toFixed(3)).toBe(before.plus(1).toFixed(3))
  })
})
