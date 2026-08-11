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
})
