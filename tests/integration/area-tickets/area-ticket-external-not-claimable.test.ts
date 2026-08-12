import {
  AreaSettlementRoute,
  FulfillmentMode,
  InventoryMethod,
  Prisma,
  StaffRole,
  TerminalStatus,
  TerminalType,
  Unit,
} from '@prisma/client'

import { addTicketToCheckout, createAreaTicketCheckout, issueAreaTicket } from '@/services/mobile/areaTicketV7.mobile.service'
import prisma from '@/utils/prismaClient'

/**
 * Task 5b — la puerta que le faltaba al circuito de caja Avoqado.
 *
 * Task 4 emite vales `EXTERNAL` (`issueAreaTicket`) y el CHECK
 * `area_ticket_external_no_avoqado_circuit` (migración de Task 2) impide que uno
 * de esos vales termine con `checkoutSessionId` o `status` `CLAIMED` en la base.
 * Pero antes de este cambio, `addTicketToCheckout` no seleccionaba
 * `settlementRoute` y dejaba pasar el vale hasta el `updateMany` que dispara ese
 * CHECK: el cajero veía un 500 crudo de Postgres (`23514`) en vez de un error
 * legible. Este archivo prueba la puerta, no la red — la red (el CHECK) ya
 * tiene su propia cobertura en `area-ticket-external-constraints.test.ts`.
 */
describe('Un vale externo no se puede cobrar en una caja Avoqado', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let organizationId: string
  let venueId: string
  let staffId: string
  let externalAreaId: string
  let nativeAreaId: string
  let productId: string
  let externalIssueDeviceUid: string
  let nativeIssueDeviceUid: string
  let checkoutDeviceUid: string
  let issueCounter = 0

  beforeAll(async () => {
    const organization = await prisma.organization.create({
      data: {
        name: `Caja externa no claim ${suffix}`,
        email: `caja-externa-no-claim-${suffix}@example.com`,
        phone: '5555555555',
      },
    })
    organizationId = organization.id

    const venue = await prisma.venue.create({
      data: {
        organizationId,
        name: `Caja externa no claim venue ${suffix}`,
        slug: `caja-externa-no-claim-${suffix}`,
        seatCapExempt: true,
      },
    })
    venueId = venue.id

    const staff = await prisma.staff.create({
      data: {
        email: `caja-externa-no-claim-staff-${suffix}@example.com`,
        firstName: 'Guardia',
        lastName: 'ValeExterno',
      },
    })
    staffId = staff.id
    await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.MANAGER } })

    // Área externa: otro POS cobra en su propia caja — la ruta que este archivo
    // prueba que NUNCA llega a una caja Avoqado.
    const externalArea = await prisma.fulfillmentArea.create({
      data: {
        venueId,
        name: `Cremería externa no-claim ${suffix}`,
        fulfillmentMode: FulfillmentMode.HOLD_UNTIL_PAID,
        settlementRoute: AreaSettlementRoute.EXTERNAL,
      },
    })
    externalAreaId = externalArea.id

    // Área nativa (ruta AVOQADO, el default) — el cuarto caso prueba que esta
    // ruta se sigue agregando a la sesión exactamente igual que antes del guard.
    const nativeArea = await prisma.fulfillmentArea.create({
      data: {
        venueId,
        name: `Cremería nativa no-claim ${suffix}`,
        fulfillmentMode: FulfillmentMode.HOLD_UNTIL_PAID,
      },
    })
    nativeAreaId = nativeArea.id

    externalIssueDeviceUid = `issue-external-no-claim-${suffix}`
    nativeIssueDeviceUid = `issue-native-no-claim-${suffix}`
    checkoutDeviceUid = `checkout-no-claim-${suffix}`
    await prisma.terminal.createMany({
      data: [
        {
          venueId,
          name: 'Emisión externa',
          type: TerminalType.POS_ANDROID,
          status: TerminalStatus.ACTIVE,
          deviceUid: externalIssueDeviceUid,
          fulfillmentAreaId: externalAreaId,
          canIssueAreaTickets: true,
        },
        {
          venueId,
          name: 'Emisión nativa',
          type: TerminalType.POS_ANDROID,
          status: TerminalStatus.ACTIVE,
          deviceUid: nativeIssueDeviceUid,
          fulfillmentAreaId: nativeAreaId,
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
      data: { venueId, enabled: true },
    })

    const category = await prisma.menuCategory.create({
      data: { venueId, name: 'No claim', slug: `caja-externa-no-claim-${suffix}`, availableDays: [] },
    })
    const product = await prisma.product.create({
      data: {
        venueId,
        categoryId: category.id,
        sku: `EXT-NOCLAIM-${suffix}`,
        name: 'Producto no claim',
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
    // inventoryReservationMode se deja en su default (NONE): este archivo prueba
    // el guard de claim, no inventario — Task 4/5 ya cubren la reserva/reversa.
    await prisma.inventory.create({
      data: { venueId, productId, currentStock: new Prisma.Decimal('50.000') },
    })
  })

  afterAll(async () => {
    if (!venueId) return
    await prisma.areaTicketExternalSettlement.deleteMany({ where: { venueId } })
    await prisma.areaTicket.deleteMany({ where: { venueId } })
    await prisma.areaTicketCheckoutSession.deleteMany({ where: { venueId } })
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
      idempotencyKey: `issue-ext-${suffix}-${issueCounter}`,
      deviceUid: externalIssueDeviceUid,
      lines: [{ clientLineId: 'l1', productId, quantity }],
    })
  }

  async function issueNativeTicket({ quantity }: { quantity: string }) {
    issueCounter += 1
    return issueAreaTicket(venueId, {
      idempotencyKey: `issue-nat-${suffix}-${issueCounter}`,
      deviceUid: nativeIssueDeviceUid,
      lines: [{ clientLineId: 'l1', productId, quantity }],
    })
  }

  it('addTicketToCheckout lo rechaza con AREA_TICKET_IS_EXTERNAL, no con un 500 de Postgres', async () => {
    const ticket = await issueExternalTicket({ quantity: '1' })
    const session = await createAreaTicketCheckout(venueId, { idempotencyKey: `s-${suffix}`, deviceUid: checkoutDeviceUid })

    await expect(
      addTicketToCheckout(venueId, session.id, ticket.code, { idempotencyKey: `a-${suffix}`, deviceUid: checkoutDeviceUid }),
    ).rejects.toMatchObject({ code: 'AREA_TICKET_IS_EXTERNAL' })
  })

  it('el mensaje le dice al cajero qué hacer, no qué falló', async () => {
    const ticket = await issueExternalTicket({ quantity: '1' })
    const session = await createAreaTicketCheckout(venueId, { idempotencyKey: `s2-${suffix}`, deviceUid: checkoutDeviceUid })
    try {
      await addTicketToCheckout(venueId, session.id, ticket.code, { idempotencyKey: `a2-${suffix}`, deviceUid: checkoutDeviceUid })
      throw new Error('debió rechazar')
    } catch (e: any) {
      expect(e.code).toBe('AREA_TICKET_IS_EXTERNAL')
      expect(e.message).toMatch(/caja externa/i)
      expect(e.message).not.toMatch(/constraint|violat|23514/i)
    }
  })

  it('el vale externo queda intacto: sigue ISSUED, sin sesión y sin orden', async () => {
    const ticket = await issueExternalTicket({ quantity: '1' })
    const session = await createAreaTicketCheckout(venueId, { idempotencyKey: `s3-${suffix}`, deviceUid: checkoutDeviceUid })
    await expect(
      addTicketToCheckout(venueId, session.id, ticket.code, { idempotencyKey: `a3-${suffix}`, deviceUid: checkoutDeviceUid }),
    ).rejects.toThrow()

    const after = await prisma.areaTicket.findUnique({ where: { id: ticket.id } })
    expect(after!.status).toBe('ISSUED')
    expect(after!.checkoutSessionId).toBeNull()
    expect(after!.orderId).toBeNull()
  })

  it('un vale NATIVO se sigue agregando a la sesión igual que antes', async () => {
    const ticket = await issueNativeTicket({ quantity: '1' })
    const session = await createAreaTicketCheckout(venueId, { idempotencyKey: `s4-${suffix}`, deviceUid: checkoutDeviceUid })
    const result = await addTicketToCheckout(venueId, session.id, ticket.code, {
      idempotencyKey: `a4-${suffix}`,
      deviceUid: checkoutDeviceUid,
    })
    expect(result.tickets.map((t: any) => t.id)).toContain(ticket.id)
  })
})
