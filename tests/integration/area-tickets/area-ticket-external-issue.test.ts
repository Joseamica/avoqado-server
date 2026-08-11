import {
  AreaSettlementRoute,
  AreaTicketInventoryReservationMode,
  FulfillmentMode,
  InventoryMethod,
  Prisma,
  StaffRole,
  TerminalStatus,
  TerminalType,
  Unit,
} from '@prisma/client'

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
  })

  afterAll(async () => {
    if (!venueId) return
    await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId } } })
    await prisma.areaTicketInventoryReservation.deleteMany({ where: { venueId } })
    await prisma.areaTicketExternalSettlement.deleteMany({ where: { venueId } })
    await prisma.areaTicket.deleteMany({ where: { venueId } })
    await prisma.inventory.deleteMany({ where: { venueId } })
    await prisma.product.deleteMany({ where: { venueId } })
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
    const before = await prisma.inventory.findUnique({ where: { id: externalInventoryId } })
    await issueAreaTicket(venueId, {
      idempotencyKey: `ext-${suffix}-3`,
      deviceUid: externalIssueDeviceUid,
      lines: [{ clientLineId: 'l1', productId, quantity: '3' }],
    })
    const after = await prisma.inventory.findUnique({ where: { id: externalInventoryId } })
    expect(Number(after!.currentStock)).toBe(Number(before!.currentStock) - 3)

    const reservation = await prisma.areaTicketInventoryReservation.findFirst({
      where: { inventoryId: externalInventoryId },
      orderBy: { createdAt: 'desc' },
    })
    expect(reservation!.status).toBe('CONSUMED')
    expect(reservation!.inventoryMovementId).not.toBeNull()
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
