import {
  AreaSettlementRoute,
  AreaTicketFulfillmentMethod,
  AreaTicketInventoryReservationMode,
  AreaTicketStatus,
  ExternalDeliveryTracking,
  FulfillmentMode,
  InventoryMethod,
  Prisma,
  StaffRole,
  TerminalStatus,
  TerminalType,
  Unit,
} from '@prisma/client'

import { getOperations, listExternalSettlements } from '@/services/dashboard/areaTicket.dashboard.service'
import { confirmExternalSettlement } from '@/services/mobile/areaTicketExternal.mobile.service'
import { cancelAreaTicket, fulfillAreaTicket, issueAreaTicket } from '@/services/mobile/areaTicketV7.mobile.service'
import prisma from '@/utils/prismaClient'

/**
 * Colas de oficina del dashboard para la ruta EXTERNAL, contra Postgres real.
 *
 * El resto de la fase probó las superficies del PISO (`listPendingExternalConfirmation`)
 * y el job; estas dos funciones —`listExternalSettlements` y `getOperations`— viven en
 * `areaTicket.dashboard.service.ts` y sólo tenían cobertura con prisma mockeado, que por
 * construcción no puede detectar un `where` equivocado: el mock devuelve lo que se le
 * guionó sin mirar el filtro. Todo lo que se prueba aquí es exactamente eso — qué filas
 * devuelve Postgres para un `where` dado — así que tiene que correr contra la base.
 */
describe('Colas de oficina (dashboard) de la ruta externa', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let organizationId: string
  let venueId: string
  let staffId: string
  let externalAreaId: string
  let nativeAreaId: string
  let terminalId: string
  let productId: string
  let externalIssueDeviceUid: string
  let issueCounter = 0

  beforeAll(async () => {
    const organization = await prisma.organization.create({
      data: {
        name: `Caja externa colas ${suffix}`,
        email: `caja-externa-colas-${suffix}@example.com`,
        phone: '5555555555',
      },
    })
    organizationId = organization.id

    const venue = await prisma.venue.create({
      data: {
        organizationId,
        name: `Caja externa colas venue ${suffix}`,
        slug: `caja-externa-colas-${suffix}`,
        seatCapExempt: true,
      },
    })
    venueId = venue.id

    const staff = await prisma.staff.create({
      data: {
        email: `caja-externa-colas-staff-${suffix}@example.com`,
        firstName: 'Colas',
        lastName: 'Externas',
      },
    })
    staffId = staff.id
    await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.MANAGER } })

    // Área externa TRACKED: la entrega se registra, así que sus vales sí forman cola.
    // (UNTRACKED entrega mirando el papel y por diseño no acumula cola — ver
    // `listPendingAreaTicketFulfillment`.)
    const externalArea = await prisma.fulfillmentArea.create({
      data: {
        venueId,
        name: `Cremería externa colas ${suffix}`,
        fulfillmentMode: FulfillmentMode.HOLD_UNTIL_PAID,
        settlementRoute: AreaSettlementRoute.EXTERNAL,
        externalDeliveryTracking: ExternalDeliveryTracking.TRACKED,
      },
    })
    externalAreaId = externalArea.id

    // Área nativa (ruta AVOQADO, el default): sostiene los casos de regresión del panel
    // — la rama nativa de `pendingDelivery` no debe cambiar de comportamiento.
    const nativeArea = await prisma.fulfillmentArea.create({
      data: {
        venueId,
        name: `Cremería nativa colas ${suffix}`,
        fulfillmentMode: FulfillmentMode.HOLD_UNTIL_PAID,
      },
    })
    nativeAreaId = nativeArea.id

    externalIssueDeviceUid = `issue-external-colas-${suffix}`
    const terminal = await prisma.terminal.create({
      data: {
        venueId,
        name: 'Emisión externa colas',
        type: TerminalType.POS_ANDROID,
        status: TerminalStatus.ACTIVE,
        deviceUid: externalIssueDeviceUid,
        fulfillmentAreaId: externalAreaId,
        canIssueAreaTickets: true,
        // La misma terminal emite y entrega — el caso "ya entregado" necesita
        // `canDeliverAreaTickets` y que el área de la terminal sea la del vale.
        canDeliverAreaTickets: true,
      },
    })
    terminalId = terminal.id

    await prisma.venueAreaTicketSettings.create({
      data: {
        venueId,
        enabled: true,
        inventoryReservationMode: AreaTicketInventoryReservationMode.HOLD_AVAILABLE_STOCK,
      },
    })

    const category = await prisma.menuCategory.create({
      data: { venueId, name: 'Externa colas', slug: `caja-externa-colas-${suffix}`, availableDays: [] },
    })
    const product = await prisma.product.create({
      data: {
        venueId,
        categoryId: category.id,
        sku: `EXT-COLAS-${suffix}`,
        name: 'Producto colas externas',
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
    await prisma.inventory.create({
      data: { venueId, productId, currentStock: new Prisma.Decimal('100.000') },
    })
  })

  afterAll(async () => {
    if (!venueId) return
    await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId } } })
    await prisma.areaTicketInventoryReservation.deleteMany({ where: { venueId } })
    await prisma.areaTicketFulfillment.deleteMany({ where: { areaTicket: { venueId } } })
    await prisma.areaTicketExternalSettlement.deleteMany({ where: { venueId } })
    await prisma.areaTicket.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
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

  async function issueExternalTicket(quantity = '1') {
    issueCounter += 1
    return issueAreaTicket(venueId, {
      idempotencyKey: `colas-${suffix}-${issueCounter}`,
      deviceUid: externalIssueDeviceUid,
      lines: [{ clientLineId: 'l1', productId, quantity }],
    })
  }

  describe('listExternalSettlements — "Cobros por confirmar"', () => {
    it('un vale vivo con el cobro en PENDING sí aparece', async () => {
      const ticket = await issueExternalTicket()

      const queue = await listExternalSettlements(venueId, { status: 'PENDING' })

      expect(queue.items.map(item => item.areaTicket.id)).toContain(ticket.id)
    })

    it('un vale CANCELADO desaparece de la cola — no deja una fila que nadie puede resolver', async () => {
      const ticket = await issueExternalTicket()
      const before = await listExternalSettlements(venueId, { status: 'PENDING' })
      expect(before.items.map(item => item.areaTicket.id)).toContain(ticket.id)

      await cancelAreaTicket(venueId, ticket.id, {
        idempotencyKey: `colas-cancel-${suffix}-1`,
        deviceUid: externalIssueDeviceUid,
        reason: 'El cliente se arrepintió',
      })

      const after = await listExternalSettlements(venueId, { status: 'PENDING' })
      expect(after.items.map(item => item.areaTicket.id)).not.toContain(ticket.id)

      // La fila del settlement NO se borra: es rastro de que ese vale nació en la ruta
      // externa y hay que poder auditarlo. Lo que cambia es que deja de contaminar la
      // cola de trabajo.
      //
      // ⚠️ Hoy esa fila sigue diciendo PENDING en la base — `cancelAreaTicket` todavía
      // no la cierra (hace falta un estado que se distinga de NOT_CHARGED, que
      // significa "una persona afirmó que la otra caja no cobró"). Este test NO fija
      // ese estado a propósito: cuando ese cierre se implemente, debe seguir pasando
      // tal cual.
      const row = await prisma.areaTicketExternalSettlement.findUnique({ where: { areaTicketId: ticket.id } })
      expect(row).not.toBeNull()
    })

    it('sin filtro de estado tampoco se cuela el vale muerto (el historial no resucita cancelados)', async () => {
      const ticket = await issueExternalTicket()
      await cancelAreaTicket(venueId, ticket.id, {
        idempotencyKey: `colas-cancel-${suffix}-2`,
        deviceUid: externalIssueDeviceUid,
        reason: 'Segundo arrepentimiento',
      })

      const queue = await listExternalSettlements(venueId, {})

      expect(queue.items.map(item => item.areaTicket.id)).not.toContain(ticket.id)
    })

    it('el filtro de área sigue funcionando junto al de vale vivo (las dos condiciones conviven)', async () => {
      const ticket = await issueExternalTicket()

      const matching = await listExternalSettlements(venueId, { status: 'PENDING', areaId: externalAreaId })
      expect(matching.items.map(item => item.areaTicket.id)).toContain(ticket.id)

      // Un área que existe pero no es la del vale: la cola queda vacía. Si el filtro de
      // vale vivo hubiera pisado al de área (dos claves `areaTicket` en el mismo
      // literal), este caso devolvería el vale igual.
      const otherArea = await prisma.fulfillmentArea.create({
        data: {
          venueId,
          name: `Otra área externa ${suffix}-${issueCounter}`,
          fulfillmentMode: FulfillmentMode.HOLD_UNTIL_PAID,
          settlementRoute: AreaSettlementRoute.EXTERNAL,
        },
      })
      const otherAreaQueue = await listExternalSettlements(venueId, { status: 'PENDING', areaId: otherArea.id })
      expect(otherAreaQueue.items.map(item => item.areaTicket.id)).not.toContain(ticket.id)
    })
  })

  describe('getOperations().pendingDelivery — panel de operación', () => {
    async function pendingDeliveryIds(): Promise<string[]> {
      const operations = await getOperations(venueId)
      return operations.pendingDelivery.map(ticket => ticket.id)
    }

    /**
     * Vale NATIVO pagado, construido directo en la base. Llegar a PAID por el camino
     * real exige materializar un checkout y finalizar un pago completo — tres servicios
     * y un montón de fixture que no prueban nada de lo que este archivo mira (qué filas
     * devuelve el `where`). Mismo atajo, y por la misma razón, que
     * `area-ticket-v7-fulfillment-modes.test.ts`.
     */
    async function createPaidNativeTicket({
      mode = FulfillmentMode.HOLD_UNTIL_PAID,
      orderStatus = 'CONFIRMED' as const,
    }: { mode?: FulfillmentMode; orderStatus?: 'CONFIRMED' | 'CANCELLED' } = {}) {
      issueCounter += 1
      const tag = `${suffix}-${issueCounter}`
      const order = await prisma.order.create({
        data: {
          venueId,
          orderNumber: `ord-${tag}`,
          status: orderStatus,
          paymentStatus: 'PAID',
          subtotal: new Prisma.Decimal('10.00'),
          taxAmount: new Prisma.Decimal(0),
          total: new Prisma.Decimal('10.00'),
          paidAmount: new Prisma.Decimal('10.00'),
          remainingBalance: new Prisma.Decimal(0),
        },
      })
      return prisma.areaTicket.create({
        data: {
          venueId,
          fulfillmentAreaId: nativeAreaId,
          fulfillmentModeSnapshot: mode,
          code: `NAT-${tag}`,
          idempotencyKey: `nat-${tag}`,
          status: AreaTicketStatus.PAID,
          sourceTerminalId: terminalId,
          orderId: order.id,
          subtotal: new Prisma.Decimal('10.00'),
          taxAmount: new Prisma.Decimal(0),
          total: new Prisma.Decimal('10.00'),
          pricingSnapshotHash: '0'.repeat(64),
          paidAt: new Date(),
        },
      })
    }

    it('un vale EXTERNAL con el cobro confirmado SÍ aparece — el panel dejó de ser ciego a esa ruta', async () => {
      const ticket = await issueExternalTicket()
      await confirmExternalSettlement(venueId, ticket.id, {
        idempotencyKey: `colas-confirm-${suffix}-1`,
        deviceUid: externalIssueDeviceUid,
        externalAmount: ticket.total,
      })

      expect(await pendingDeliveryIds()).toContain(ticket.id)
    })

    it('un vale EXTERNAL con el cobro todavía PENDING no aparece — nadie autorizó soltar el producto', async () => {
      const ticket = await issueExternalTicket()

      expect(await pendingDeliveryIds()).not.toContain(ticket.id)
    })

    it('un vale EXTERNAL ya entregado sale de la cola', async () => {
      const ticket = await issueExternalTicket()
      await confirmExternalSettlement(venueId, ticket.id, {
        idempotencyKey: `colas-confirm-${suffix}-2`,
        deviceUid: externalIssueDeviceUid,
        externalAmount: ticket.total,
      })
      expect(await pendingDeliveryIds()).toContain(ticket.id)

      await fulfillAreaTicket(venueId, ticket.id, {
        idempotencyKey: `colas-fulfill-${suffix}-1`,
        deviceUid: externalIssueDeviceUid,
        method: AreaTicketFulfillmentMethod.PAPER_CONFIRMATION,
      })

      expect(await pendingDeliveryIds()).not.toContain(ticket.id)
    })

    it('un vale NATIVO pagado con su orden viva sigue apareciendo — la ruta AVOQADO no se rompió', async () => {
      const ticket = await createPaidNativeTicket()

      expect(await pendingDeliveryIds()).toContain(ticket.id)
    })

    it('un vale NATIVO pagado cuya orden se canceló ya no aparece', async () => {
      const ticket = await createPaidNativeTicket({ orderStatus: 'CANCELLED' })

      expect(await pendingDeliveryIds()).not.toContain(ticket.id)
    })

    it('un vale NATIVO en modo IMMEDIATE no aparece — se entregó al momento, no hay cola que vaciar', async () => {
      const ticket = await createPaidNativeTicket({ mode: FulfillmentMode.IMMEDIATE })

      expect(await pendingDeliveryIds()).not.toContain(ticket.id)
    })
  })
})
