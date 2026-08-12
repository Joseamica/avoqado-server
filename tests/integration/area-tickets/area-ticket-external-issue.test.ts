import {
  AreaSettlementRoute,
  AreaTicketInventoryReservationMode,
  FulfillmentMode,
  InventoryMethod,
  MovementType,
  Prisma,
  RawMaterialMovementType,
  StaffRole,
  TerminalStatus,
  TerminalType,
  Unit,
} from '@prisma/client'

import { createStockBatch } from '@/services/dashboard/fifoBatch.service'
import { issueAreaTicket } from '@/services/mobile/areaTicketV7.mobile.service'
import prisma from '@/utils/prismaClient'

/**
 * Task 4 — la rama externa de `issueAreaTicket`. A diferencia de
 * `area-ticket-external-constraints.test.ts` (que prueba los CHECK con
 * `prisma.*.create()` directo), este archivo prueba el SERVICIO: que emitir en un
 * área EXTERNAL cree el settlement desde el vale y consuma inventario al emitir, no
 * al pagar (enmienda E3 — otro POS cobra en su caja y Avoqado nunca ve ese cobro).
 */
describe('Emisión en un área con ruta externa', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let organizationId: string
  let venueId: string
  let staffId: string
  let areaId: string
  let externalAreaId: string
  let productId: string
  let externalInventoryId: string
  let issueDeviceUid: string
  let externalIssueDeviceUid: string
  let rawMaterialId: string
  let recipeProductId: string
  let strandedRawMaterialId: string
  let strandedRecipeProductId: string

  beforeAll(async () => {
    const organization = await prisma.organization.create({
      data: {
        name: `Caja externa emisión ${suffix}`,
        email: `caja-externa-emision-${suffix}@example.com`,
        phone: '5555555555',
      },
    })
    organizationId = organization.id

    const venue = await prisma.venue.create({
      data: {
        organizationId,
        name: `Caja externa emisión venue ${suffix}`,
        slug: `caja-externa-emision-${suffix}`,
        seatCapExempt: true,
      },
    })
    venueId = venue.id

    const staff = await prisma.staff.create({
      data: {
        email: `caja-externa-emision-staff-${suffix}@example.com`,
        firstName: 'Emisión',
        lastName: 'Externa',
      },
    })
    staffId = staff.id
    await prisma.staffVenue.create({
      data: { staffId, venueId, role: StaffRole.MANAGER },
    })

    // Área nativa (ruta AVOQADO, el default de Task 1) — la necesita el caso 5, que
    // prueba que esta ruta sigue sin settlement externo.
    const area = await prisma.fulfillmentArea.create({
      data: {
        venueId,
        name: `Cremería nativa ${suffix}`,
        fulfillmentMode: FulfillmentMode.HOLD_UNTIL_PAID,
      },
    })
    areaId = area.id

    // Área externa: otro POS cobra en su propia caja. `externalConfirmationMode` se
    // deja en su default (MANUAL) a propósito — el caso 2 depende de que nazca así
    // para probar que congelarlo en el settlement funciona.
    const externalArea = await prisma.fulfillmentArea.create({
      data: {
        venueId,
        name: `Cremería externa ${suffix}`,
        fulfillmentMode: FulfillmentMode.HOLD_UNTIL_PAID,
        settlementRoute: AreaSettlementRoute.EXTERNAL,
      },
    })
    externalAreaId = externalArea.id

    issueDeviceUid = `issue-native-${suffix}`
    externalIssueDeviceUid = `issue-external-${suffix}`
    await prisma.terminal.createMany({
      data: [
        {
          venueId,
          name: 'Emisión nativa',
          type: TerminalType.POS_ANDROID,
          status: TerminalStatus.ACTIVE,
          deviceUid: issueDeviceUid,
          fulfillmentAreaId: areaId,
          canIssueAreaTickets: true,
        },
        {
          venueId,
          name: 'Emisión externa',
          type: TerminalType.POS_ANDROID,
          status: TerminalStatus.ACTIVE,
          deviceUid: externalIssueDeviceUid,
          fulfillmentAreaId: externalAreaId,
          canIssueAreaTickets: true,
        },
      ],
    })

    // HOLD_AVAILABLE_STOCK: obligatorio para que issueAreaTicket construya
    // reservationSpecs — sin esto ninguna de las dos rutas reserva ni consume nada.
    await prisma.venueAreaTicketSettings.create({
      data: {
        venueId,
        enabled: true,
        inventoryReservationMode: AreaTicketInventoryReservationMode.HOLD_AVAILABLE_STOCK,
      },
    })

    const category = await prisma.menuCategory.create({
      data: {
        venueId,
        name: 'Externa',
        slug: `caja-externa-emision-${suffix}`,
        availableDays: [],
      },
    })
    const product = await prisma.product.create({
      data: {
        venueId,
        categoryId: category.id,
        sku: `EXT-EMIT-${suffix}`,
        name: 'Producto emisión externa',
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
    // Stock generoso: los 5 casos consumen/reservan como mucho 8 piezas en total
    // entre todos (2+1+3+1 en la ruta externa, 1 de hold en la nativa).
    const inventory = await prisma.inventory.create({
      data: {
        venueId,
        productId,
        currentStock: new Prisma.Decimal('50.000'),
      },
    })
    externalInventoryId = inventory.id

    // ── Rama RAW_MATERIAL (receta) ────────────────────────────────────────────
    // La Task 5 cubrió la REVERSA de esta rama (cancelar); el CONSUMO al emitir se
    // quedó sin cobertura, y es donde la enmienda E3 abrió un modo de falla nuevo:
    // lo que antes tronaba al pagar ahora truena al EMITIR.
    const rawMaterial = await prisma.rawMaterial.create({
      data: {
        venueId,
        name: `Queso insumo emisión ${suffix}`,
        sku: `EXT-EMIT-RM-${suffix}`,
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
    // El consumo asigna por FIFO de `StockBatch`, no contra `RawMaterial.currentStock`:
    // sin un lote ACTIVE no hay de dónde asignar.
    await createStockBatch(venueId, rawMaterialId, { quantity: 5000, unit: Unit.GRAM, costPerUnit: 0.05, receivedDate: new Date() })

    const recipeProduct = await prisma.product.create({
      data: {
        venueId,
        categoryId: category.id,
        sku: `EXT-EMIT-RECIPE-${suffix}`,
        name: 'Producto receta emisión externa',
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
        lines: { create: [{ rawMaterialId, quantity: new Prisma.Decimal('100.000'), unit: Unit.GRAM, isOptional: false }] },
      },
    })

    // Insumo DESFASADO a propósito: `currentStock` alto pero SIN ningún lote. Es el
    // escenario que la revisión de la Task 4 nombró como modo de falla nuevo — la
    // validación de disponibilidad mira `currentStock` y pasa; el FIFO no encuentra de
    // dónde asignar y truena AL EMITIR, no al pagar.
    const strandedMaterial = await prisma.rawMaterial.create({
      data: {
        venueId,
        name: `Insumo sin lotes ${suffix}`,
        sku: `EXT-EMIT-RM-NOBATCH-${suffix}`,
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
    strandedRawMaterialId = strandedMaterial.id

    const strandedProduct = await prisma.product.create({
      data: {
        venueId,
        categoryId: category.id,
        sku: `EXT-EMIT-RECIPE-NOBATCH-${suffix}`,
        name: 'Producto receta sin lotes',
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
    strandedRecipeProductId = strandedProduct.id
    await prisma.recipe.create({
      data: {
        productId: strandedRecipeProductId,
        portionYield: 1,
        totalCost: new Prisma.Decimal('5.00'),
        lines: {
          create: [{ rawMaterialId: strandedRawMaterialId, quantity: new Prisma.Decimal('100.000'), unit: Unit.GRAM, isOptional: false }],
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
    // El product cascada a Recipe → RecipeLine; el rawMaterial va DESPUÉS para que esas
    // RecipeLine ya no lo referencien (su FK no cascada desde RawMaterial).
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

  it('crea el vale con settlementRoute EXTERNAL y su settlement en PENDING', async () => {
    const ticket = await issueAreaTicket(venueId, {
      idempotencyKey: `ext-${suffix}-1`,
      deviceUid: externalIssueDeviceUid,
      lines: [{ clientLineId: 'l1', productId, quantity: '2' }],
    })

    expect(ticket.settlementRoute).toBe('EXTERNAL')
    // externalSettlement es nullable en el tipo (null en la ruta AVOQADO) — el `!` es
    // sólo una aserción de compilador; este vale es EXTERNAL, así que existe siempre.
    expect(ticket.externalSettlement!.status).toBe('PENDING')
    expect(ticket.externalSettlement!.handoffState).toBe('PENDING')
    // El importe de referencia es el total del vale, al centavo.
    expect(ticket.externalSettlement!.referenceAmount).toBe(ticket.total)
  })

  it('congela el modo de confirmación vigente — cambiarlo después no reescribe la historia', async () => {
    const ticket = await issueAreaTicket(venueId, {
      idempotencyKey: `ext-${suffix}-2`,
      deviceUid: externalIssueDeviceUid,
      lines: [{ clientLineId: 'l1', productId, quantity: '1' }],
    })
    await prisma.fulfillmentArea.update({
      where: { id: externalAreaId },
      data: { externalConfirmationMode: 'ASSUME_ON_PRINT' },
    })
    const row = await prisma.areaTicketExternalSettlement.findUnique({
      where: { areaTicketId: ticket.id },
    })
    expect(row!.confirmationMode).toBe('MANUAL')
  })

  it('consume el inventario AL EMITIR, no al cobrar — el producto ya salió del área', async () => {
    const before = await prisma.inventory.findUniqueOrThrow({ where: { id: externalInventoryId } })
    await issueAreaTicket(venueId, {
      idempotencyKey: `ext-${suffix}-3`,
      deviceUid: externalIssueDeviceUid,
      lines: [{ clientLineId: 'l1', productId, quantity: '3' }],
    })
    const after = await prisma.inventory.findUniqueOrThrow({ where: { id: externalInventoryId } })
    // Comparación en Decimal, no en `Number()`: colapsar a float una cantidad es
    // justo lo que esta fase se propuso no hacer (minor de la revisión de Task 4).
    expect(after.currentStock.toFixed(3)).toBe(before.currentStock.sub(3).toFixed(3))

    const reservation = await prisma.areaTicketInventoryReservation.findFirst({
      where: { inventoryId: externalInventoryId },
      orderBy: { createdAt: 'desc' },
    })
    expect(reservation!.status).toBe('CONSUMED')
    expect(reservation!.inventoryMovementId).not.toBeNull()

    // 🔴 El SIGNO del movimiento, asertado sobre el movimiento mismo — no sobre
    // `Inventory.currentStock`, que es OTRA columna. Sin esto, un movimiento
    // registrado en POSITIVO pasaría el test igual (el descuento de `currentStock`
    // lo hace el `UPDATE`, no el `create` del movimiento), y el signo es EL riesgo
    // nombrado de la Task 4: un movimiento positivo convierte una salida de
    // producto en una entrada en todo reporte de inventario que sume movimientos.
    const movement = await prisma.inventoryMovement.findUniqueOrThrow({ where: { id: reservation!.inventoryMovementId! } })
    expect(movement.quantity.toFixed(3)).toBe('-3.000')
    expect(movement.type).toBe(MovementType.SALE)
    expect(movement.previousStock.toFixed(3)).toBe(before.currentStock.toFixed(3))
    expect(movement.newStock.toFixed(3)).toBe(after.currentStock.toFixed(3))
    // El vínculo con el vale es la reserva (`reference`), no un orderId — la ruta
    // externa no tiene Order.
    expect(movement.reference).toBe(reservation!.id)
  })

  it('la misma idempotencyKey no crea un segundo settlement ni un segundo movimiento', async () => {
    const key = `ext-${suffix}-4`
    const input = {
      idempotencyKey: key,
      deviceUid: externalIssueDeviceUid,
      lines: [{ clientLineId: 'l1', productId, quantity: '1' }],
    }
    const a = await issueAreaTicket(venueId, input)
    const b = await issueAreaTicket(venueId, input)

    expect(b.id).toBe(a.id)
    expect(await prisma.areaTicketExternalSettlement.count({ where: { areaTicketId: a.id } })).toBe(1)

    // El título de este caso promete también "ni un segundo movimiento" — la aserción
    // del brief se queda corta en el cuerpo, así que se extiende aquí: es exactamente
    // el riesgo de doble descuento que este task marca como el más peligroso.
    const reservation = await prisma.areaTicketInventoryReservation.findFirst({ where: { areaTicketId: a.id } })
    expect(reservation).not.toBeNull()
    expect(await prisma.areaTicketInventoryReservation.count({ where: { areaTicketId: a.id } })).toBe(1)
    expect(await prisma.inventoryMovement.count({ where: { reference: reservation!.id } })).toBe(1)
  })

  it('RAW_MATERIAL: consume el insumo por FIFO AL EMITIR, con el movimiento en negativo', async () => {
    const before = await prisma.rawMaterial.findUniqueOrThrow({ where: { id: rawMaterialId } })

    const ticket = await issueAreaTicket(venueId, {
      idempotencyKey: `ext-rm-${suffix}-1`,
      deviceUid: externalIssueDeviceUid,
      lines: [{ clientLineId: 'l1', productId: recipeProductId, quantity: '2' }],
    })

    // 2 porciones × 100 g de receta = 200 g.
    const after = await prisma.rawMaterial.findUniqueOrThrow({ where: { id: rawMaterialId } })
    expect(after.currentStock.toFixed(3)).toBe(before.currentStock.sub(200).toFixed(3))

    const reservation = await prisma.areaTicketInventoryReservation.findFirstOrThrow({
      where: { areaTicketId: ticket.id, inventoryKind: 'RAW_MATERIAL' },
    })
    expect(reservation.status).toBe('CONSUMED')
    expect(reservation.inventoryMovementId).not.toBeNull()

    // Mismo assert de signo que la rama QUANTITY, sobre el movimiento mismo: el
    // descuento de `RawMaterial.currentStock` lo hace un `update` aparte, así que
    // comparar sólo esa columna dejaría pasar un movimiento en positivo.
    const movements = await prisma.rawMaterialMovement.findMany({ where: { reference: reservation.id } })
    expect(movements).toHaveLength(1)
    expect(movements[0].type).toBe(RawMaterialMovementType.USAGE)
    expect(movements[0].quantity.toFixed(3)).toBe('-200.000')
    expect(movements[0].previousStock.toFixed(3)).toBe(before.currentStock.toFixed(3))
    expect(movements[0].newStock.toFixed(3)).toBe(after.currentStock.toFixed(3))
    expect(movements[0].batchId).not.toBeNull()

    // El lote FIFO también bajó — el consumo salió de existencias reales, no de un
    // ajuste al aire.
    const batch = await prisma.stockBatch.findUniqueOrThrow({ where: { id: movements[0].batchId! } })
    expect(batch.remainingQuantity.toFixed(3)).toBe('4800.000')
  })

  it('RAW_MATERIAL sin lotes FIFO: la emisión FALLA y no deja vale a medias — el modo de falla se movió del pago a la emisión', async () => {
    const before = await prisma.rawMaterial.findUniqueOrThrow({ where: { id: strandedRawMaterialId } })

    await expect(
      issueAreaTicket(venueId, {
        idempotencyKey: `ext-rm-stranded-${suffix}-1`,
        deviceUid: externalIssueDeviceUid,
        lines: [{ clientLineId: 'l1', productId: strandedRecipeProductId, quantity: '1' }],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'AREA_TICKET_INVENTORY_FINALIZATION_FAILED' })

    // Todo el trabajo de emisión vive en UNA transacción: si el consumo truena, no
    // queda ni vale, ni settlement, ni reserva, ni stock movido.
    const after = await prisma.rawMaterial.findUniqueOrThrow({ where: { id: strandedRawMaterialId } })
    expect(after.currentStock.toFixed(3)).toBe(before.currentStock.toFixed(3))
    expect(await prisma.areaTicket.count({ where: { venueId, idempotencyKey: `ext-rm-stranded-${suffix}-1` } })).toBe(0)
    expect(await prisma.areaTicketInventoryReservation.count({ where: { venueId, inventoryId: strandedRawMaterialId } })).toBe(0)
  })

  it('un área AVOQADO sigue sin settlement externo — la ruta nativa no cambió', async () => {
    const ticket = await issueAreaTicket(venueId, {
      idempotencyKey: `nat-${suffix}-1`,
      deviceUid: issueDeviceUid,
      lines: [{ clientLineId: 'l1', productId, quantity: '1' }],
    })
    expect(ticket.settlementRoute).toBe('AVOQADO')
    expect(await prisma.areaTicketExternalSettlement.count({ where: { areaTicketId: ticket.id } })).toBe(0)
  })
})
