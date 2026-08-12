import {
  AreaSettlementRoute,
  AreaTicketFulfillmentMethod,
  AreaTicketStatus,
  FulfillmentMode,
  InventoryMethod,
  Prisma,
  StaffRole,
  TerminalStatus,
  TerminalType,
  Unit,
} from '@prisma/client'

import prisma from '@/utils/prismaClient'

/**
 * Los dos CHECK de la ruta externa (`area_ticket_external_no_avoqado_circuit` en
 * AreaTicket, `atf_order_required_for_avoqado_route` en AreaTicketFulfillment) son la
 * única defensa que sobrevive a un script de datos que no pase por la capa de
 * servicio — por eso se prueban con `prisma.*.create()` directo, sin pasar por
 * `areaTicketV7.mobile.service.ts`. Un test que solo probara el servicio no probaría
 * nada si alguien escribe con SQL crudo o con un script de mantenimiento.
 */
describe('CHECK constraints de la ruta externa', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let organizationId: string
  let venueId: string
  let staffId: string
  let areaId: string
  let terminalId: string
  let sessionId: string
  let seq = 0

  beforeAll(async () => {
    const organization = await prisma.organization.create({
      data: {
        name: `Caja externa constraints ${suffix}`,
        email: `caja-externa-${suffix}@example.com`,
        phone: '5555555555',
      },
    })
    organizationId = organization.id

    const venue = await prisma.venue.create({
      data: {
        organizationId,
        name: `Caja externa venue ${suffix}`,
        slug: `caja-externa-${suffix}`,
        seatCapExempt: true,
      },
    })
    venueId = venue.id

    const staff = await prisma.staff.create({
      data: {
        email: `caja-externa-staff-${suffix}@example.com`,
        firstName: 'Caja',
        lastName: 'Externa',
      },
    })
    staffId = staff.id
    await prisma.staffVenue.create({
      data: { staffId, venueId, role: StaffRole.MANAGER },
    })

    const area = await prisma.fulfillmentArea.create({
      data: {
        venueId,
        name: `Área externa ${suffix}`,
        fulfillmentMode: FulfillmentMode.HOLD_UNTIL_PAID,
      },
    })
    areaId = area.id

    const terminal = await prisma.terminal.create({
      data: {
        venueId,
        name: `Terminal externa ${suffix}`,
        type: TerminalType.POS_ANDROID,
        status: TerminalStatus.ACTIVE,
        deviceUid: `caja-externa-${suffix}`,
        fulfillmentAreaId: areaId,
        canIssueAreaTickets: true,
        canCheckoutAreaTickets: true,
        canDeliverAreaTickets: true,
      },
    })
    terminalId = terminal.id

    // Sigue el patrón de area-ticket-v7-flow.test.ts: categoría + producto, aunque
    // ningún CHECK de esta tarea los consulta — los CHECK sólo miran columnas de
    // AreaTicket/AreaTicketFulfillment. Se crean para no divergir del fixture base.
    const category = await prisma.menuCategory.create({
      data: { venueId, name: 'Externa', slug: `externa-${suffix}`, availableDays: [] },
    })
    await prisma.product.create({
      data: {
        venueId,
        categoryId: category.id,
        sku: `EXT-SKU-${suffix}`,
        name: 'Producto externo',
        price: new Prisma.Decimal('10.00'),
        taxRate: new Prisma.Decimal(0),
        tags: [],
        allergens: [],
        soldByWeight: false,
        trackInventory: false,
        inventoryMethod: InventoryMethod.QUANTITY,
        unit: Unit.PIECE,
      },
    })

    // Sesión de checkout REAL: el primer caso prueba que un vale EXTERNAL no puede
    // traer un checkoutSessionId válido. Si `sessionId` no existiera, el `create`
    // fallaría por la FK antes de llegar al CHECK, y el test pasaría por el motivo
    // equivocado.
    const session = await prisma.areaTicketCheckoutSession.create({
      data: {
        venueId,
        terminalId,
        idempotencyKey: `session-${suffix}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    })
    sessionId = session.id
  })

  afterAll(async () => {
    if (!venueId) return
    await prisma.areaTicketFulfillment.deleteMany({ where: { fulfillmentArea: { venueId } } })
    await prisma.areaTicket.deleteMany({ where: { venueId } })
    await prisma.areaTicketCheckoutSession.deleteMany({ where: { venueId } })
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.terminal.deleteMany({ where: { venueId } })
    await prisma.fulfillmentArea.deleteMany({ where: { venueId } })
    await prisma.staffVenue.deleteMany({ where: { venueId } })
    await prisma.venue.delete({ where: { id: venueId } })
    if (staffId) await prisma.staff.delete({ where: { id: staffId } })
    if (organizationId) await prisma.organization.delete({ where: { id: organizationId } })
    await prisma.$disconnect()
  })

  /** Cada llamada trae code/idempotencyKey/hash únicos — nunca truena por un choque de @@unique ajeno al CHECK que se está probando. */
  function nextUnique(): string {
    seq += 1
    return `${suffix}-${seq}`
  }

  function baseTicketData() {
    const unique = nextUnique()
    return {
      venueId,
      fulfillmentAreaId: areaId,
      fulfillmentModeSnapshot: FulfillmentMode.HOLD_UNTIL_PAID,
      code: `EXT-${unique}`,
      idempotencyKey: `ext-idem-${unique}`,
      sourceTerminalId: terminalId,
      subtotal: new Prisma.Decimal('10.00'),
      taxAmount: new Prisma.Decimal('1.60'),
      total: new Prisma.Decimal('11.60'),
      pricingSnapshotHash: `hash-${unique}`,
    }
  }

  /**
   * AreaTicketFulfillment.areaTicketId es @unique (una entrega por vale), así que
   * cada caso necesita su PROPIO vale — reusar uno solo entre dos `it()` chocaría por
   * esa unicidad, no por el CHECK bajo prueba. El vale nace en la ruta que se le pida
   * para que el fixture sea internamente consistente incluso aunque hoy ningún CHECK
   * cruce ambas tablas.
   */
  async function baseFulfillmentData(ticketSettlementRoute: AreaSettlementRoute) {
    const ticket = await prisma.areaTicket.create({
      data: { ...baseTicketData(), settlementRoute: ticketSettlementRoute },
    })
    const unique = nextUnique()
    return {
      areaTicketId: ticket.id,
      fulfillmentAreaId: areaId,
      method: AreaTicketFulfillmentMethod.PAPER_CONFIRMATION,
      idempotencyKey: `fulfill-idem-${unique}`,
      terminalId,
    }
  }

  it('rechaza un vale EXTERNAL que traiga checkoutSessionId — no puede entrar al carril de caja Avoqado', async () => {
    await expect(
      prisma.areaTicket.create({
        data: {
          ...baseTicketData(),
          settlementRoute: AreaSettlementRoute.EXTERNAL,
          checkoutSessionId: sessionId,
        },
      }),
    ).rejects.toThrow(/area_ticket_external_no_avoqado_circuit/)
  })

  it('rechaza un vale EXTERNAL en estado CLAIMED — en la ruta externa no hay claim', async () => {
    await expect(
      prisma.areaTicket.create({
        data: { ...baseTicketData(), settlementRoute: AreaSettlementRoute.EXTERNAL, status: AreaTicketStatus.CLAIMED },
      }),
    ).rejects.toThrow(/area_ticket_external_no_avoqado_circuit/)
  })

  it('rechaza una entrega de ruta AVOQADO sin orderId — la invariante nativa NO se debilitó', async () => {
    await expect(
      prisma.areaTicketFulfillment.create({
        data: {
          ...(await baseFulfillmentData(AreaSettlementRoute.AVOQADO)),
          settlementRoute: AreaSettlementRoute.AVOQADO,
          orderId: null,
        },
      }),
    ).rejects.toThrow(/atf_order_required_for_avoqado_route/)
  })

  it('SÍ acepta una entrega de ruta EXTERNAL sin orderId', async () => {
    const created = await prisma.areaTicketFulfillment.create({
      data: {
        ...(await baseFulfillmentData(AreaSettlementRoute.EXTERNAL)),
        settlementRoute: AreaSettlementRoute.EXTERNAL,
        orderId: null,
      },
    })
    expect(created.orderId).toBeNull()
  })
})
