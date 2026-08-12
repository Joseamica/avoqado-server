import {
  AreaSettlementRoute,
  AreaTicketExternalSettlementStatus,
  AreaTicketFulfillmentMethod,
  AreaTicketStatus,
  ExternalDeliveryTracking,
  FulfillmentMode,
  Prisma,
  StaffRole,
  TerminalStatus,
  TerminalType,
} from '@prisma/client'

import { confirmExternalSettlement, markExternalNotCharged } from '@/services/mobile/areaTicketExternal.mobile.service'
import { fulfillAreaTicket, issueAreaTicket, listPendingAreaTicketFulfillment } from '@/services/mobile/areaTicketV7.mobile.service'
import prisma from '@/utils/prismaClient'

/**
 * Task 10 — el predicado externo de entrega. `fulfillAreaTicket` (la MISMA
 * función y la MISMA entidad `AreaTicketFulfillment` que usa la ruta nativa)
 * ahora también acepta vales `EXTERNAL`, pero con un predicado de elegibilidad
 * distinto: en vez de "¿hay una Order pagada?", "¿alguien afirmó que la caja
 * externa cobró (CONFIRMED/ASSUMED/DISCREPANCY)?". La ruta nativa NO cambia —
 * sigue exigiendo Order pagada — y ese es justo el caso que este archivo
 * también regresiona explícitamente.
 */
describe('Entrega de un vale externo', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let organizationId: string
  let venueId: string
  let staffId: string
  let externalAreaId: string
  let nativeAreaId: string
  let productId: string
  let externalIssueDeviceUid: string
  let externalDeliveryDeviceUid: string
  let nativeDeliveryDeviceUid: string
  let issueCounter = 0
  let fulfillCounter = 0

  beforeAll(async () => {
    const organization = await prisma.organization.create({
      data: {
        name: `Caja externa entrega ${suffix}`,
        email: `caja-externa-entrega-${suffix}@example.com`,
        phone: '5555555555',
      },
    })
    organizationId = organization.id

    const venue = await prisma.venue.create({
      data: {
        organizationId,
        name: `Caja externa entrega venue ${suffix}`,
        slug: `caja-externa-entrega-${suffix}`,
        seatCapExempt: true,
      },
    })
    venueId = venue.id

    const staff = await prisma.staff.create({
      data: {
        email: `caja-externa-entrega-staff-${suffix}@example.com`,
        firstName: 'Entrega',
        lastName: 'Externa',
      },
    })
    staffId = staff.id
    await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.MANAGER } })

    // Área externa: otro POS cobra en su propia caja. Es la ruta que prueba
    // este archivo.
    const externalArea = await prisma.fulfillmentArea.create({
      data: {
        venueId,
        name: `Cremería externa entrega ${suffix}`,
        fulfillmentMode: FulfillmentMode.HOLD_UNTIL_PAID,
        settlementRoute: AreaSettlementRoute.EXTERNAL,
      },
    })
    externalAreaId = externalArea.id

    // Área nativa (ruta AVOQADO, default) — sólo para el caso de regresión:
    // "la ruta nativa sigue exigiendo Order pagada".
    const nativeArea = await prisma.fulfillmentArea.create({
      data: {
        venueId,
        name: `Cremería nativa entrega ${suffix}`,
        fulfillmentMode: FulfillmentMode.HOLD_UNTIL_PAID,
      },
    })
    nativeAreaId = nativeArea.id

    externalIssueDeviceUid = `issue-external-fulfill-${suffix}`
    externalDeliveryDeviceUid = `delivery-external-fulfill-${suffix}`
    nativeDeliveryDeviceUid = `delivery-native-fulfill-${suffix}`
    await prisma.terminal.createMany({
      data: [
        {
          venueId,
          name: 'Emisión externa (entrega)',
          type: TerminalType.POS_ANDROID,
          status: TerminalStatus.ACTIVE,
          deviceUid: externalIssueDeviceUid,
          fulfillmentAreaId: externalAreaId,
          canIssueAreaTickets: true,
        },
        {
          venueId,
          name: 'Entrega externa',
          type: TerminalType.POS_ANDROID,
          status: TerminalStatus.ACTIVE,
          deviceUid: externalDeliveryDeviceUid,
          fulfillmentAreaId: externalAreaId,
          canDeliverAreaTickets: true,
        },
        {
          venueId,
          name: 'Entrega nativa',
          type: TerminalType.POS_ANDROID,
          status: TerminalStatus.ACTIVE,
          deviceUid: nativeDeliveryDeviceUid,
          fulfillmentAreaId: nativeAreaId,
          canDeliverAreaTickets: true,
        },
      ],
    })

    // inventoryReservationMode se deja en su default (NONE): este archivo
    // prueba el predicado de entrega, no inventario — Tasks 4/5 ya lo cubren.
    await prisma.venueAreaTicketSettings.create({ data: { venueId, enabled: true } })

    const category = await prisma.menuCategory.create({
      data: { venueId, name: 'Entrega externa', slug: `caja-externa-entrega-${suffix}`, availableDays: [] },
    })
    const product = await prisma.product.create({
      data: {
        venueId,
        categoryId: category.id,
        sku: `EXT-FULFILL-${suffix}`,
        name: 'Producto entrega externa',
        price: new Prisma.Decimal('20.00'),
        taxRate: new Prisma.Decimal(0),
        tags: [],
        allergens: [],
        soldByWeight: false,
        trackInventory: false,
      },
    })
    productId = product.id
  })

  afterAll(async () => {
    if (!venueId) return
    await prisma.areaTicketFulfillment.deleteMany({ where: { fulfillmentArea: { venueId } } })
    await prisma.areaTicketExternalSettlement.deleteMany({ where: { venueId } })
    await prisma.areaTicket.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
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

  async function issueExternalTicket({ quantity = '1' }: { quantity?: string } = {}) {
    issueCounter += 1
    return issueAreaTicket(venueId, {
      idempotencyKey: `fulfill-issue-${suffix}-${issueCounter}`,
      deviceUid: externalIssueDeviceUid,
      staffId,
      lines: [{ clientLineId: 'l1', productId, quantity }],
    })
  }

  async function issueAndConfirmExternal() {
    const ticket = await issueExternalTicket()
    issueCounter += 1
    await confirmExternalSettlement(venueId, ticket.id, {
      idempotencyKey: `fulfill-confirm-${suffix}-${issueCounter}`,
      deviceUid: externalIssueDeviceUid,
      staffId,
    })
    return ticket
  }

  // ASSUMED: hoy ningún código de producción lo produce todavía (nace de un
  // "asumido automático" al imprimir, trabajo futuro de este mismo plan —
  // confirmado en el reporte de Task 9). Se fuerza directo en la fila, mismo
  // patrón que ya usan `area-ticket-external-cancel.test.ts` y
  // `area-ticket-external-queue.test.ts`.
  async function issueAndAssumeExternal() {
    const ticket = await issueExternalTicket()
    await prisma.areaTicketExternalSettlement.update({
      where: { areaTicketId: ticket.id },
      data: { status: AreaTicketExternalSettlementStatus.ASSUMED },
    })
    return ticket
  }

  async function issueAndDiscrepancyExternal() {
    const ticket = await issueExternalTicket()
    issueCounter += 1
    await confirmExternalSettlement(venueId, ticket.id, {
      idempotencyKey: `fulfill-disc-${suffix}-${issueCounter}`,
      deviceUid: externalIssueDeviceUid,
      staffId,
      externalAmount: '999.00', // distinto del total (20.00) => DISCREPANCY
    })
    return ticket
  }

  function fulfillInput(
    overrides: Partial<{
      idempotencyKey: string
      deviceUid: string
      staffId: string | null
      method: AreaTicketFulfillmentMethod
    }> = {},
  ) {
    fulfillCounter += 1
    return {
      idempotencyKey: `fulfill-${suffix}-${fulfillCounter}`,
      deviceUid: externalDeliveryDeviceUid,
      staffId,
      method: AreaTicketFulfillmentMethod.PAPER_CONFIRMATION,
      ...overrides,
    }
  }

  it('entrega con el cobro CONFIRMED, sin orderId y sin tocar el status del vale', async () => {
    const t = await issueAndConfirmExternal()

    const r = await fulfillAreaTicket(venueId, t.id, fulfillInput())

    expect(r.alreadyFulfilled).toBe(false)
    expect(r.fulfillment.id).toBeTruthy()
    const row = await prisma.areaTicketFulfillment.findUnique({ where: { areaTicketId: t.id } })
    expect(row!.orderId).toBeNull()
    expect(row!.settlementRoute).toBe(AreaSettlementRoute.EXTERNAL)
    // El CHECK `area_ticket_external_no_avoqado_circuit` (Task 2) prohíbe que
    // un vale EXTERNAL llegue a CLAIMED/PAID/DELIVERED: la entrega se lee de
    // la EXISTENCIA del fulfillment, nunca de `AreaTicket.status`.
    const ticketRow = await prisma.areaTicket.findUniqueOrThrow({ where: { id: t.id } })
    expect(ticketRow.status).toBe(AreaTicketStatus.ISSUED)
  })

  it('entrega con el cobro ASSUMED', async () => {
    const t = await issueAndAssumeExternal()

    const r = await fulfillAreaTicket(venueId, t.id, fulfillInput())

    expect(r.alreadyFulfilled).toBe(false)
    expect(r.fulfillment.id).toBeTruthy()
  })

  it('entrega con DISCREPANCY — el producto ya está pagado en la otra caja', async () => {
    const t = await issueAndDiscrepancyExternal()

    const r = await fulfillAreaTicket(venueId, t.id, fulfillInput())

    expect(r.alreadyFulfilled).toBe(false)
    expect(r.fulfillment.id).toBeTruthy()
  })

  it('NO entrega con el cobro PENDING', async () => {
    const t = await issueExternalTicket()

    await expect(fulfillAreaTicket(venueId, t.id, fulfillInput())).rejects.toMatchObject({
      statusCode: 409,
      code: 'AREA_TICKET_EXTERNAL_NOT_CONFIRMED',
    })
    expect(await prisma.areaTicketFulfillment.count({ where: { areaTicketId: t.id } })).toBe(0)
  })

  it('NO entrega con NOT_CHARGED', async () => {
    const t = await issueExternalTicket()
    issueCounter += 1
    await markExternalNotCharged(venueId, t.id, {
      idempotencyKey: `fulfill-nc-${suffix}-${issueCounter}`,
      deviceUid: externalIssueDeviceUid,
      staffId,
      reason: 'Cliente no pasó a la caja externa',
    })

    await expect(fulfillAreaTicket(venueId, t.id, fulfillInput())).rejects.toMatchObject({
      statusCode: 409,
      code: 'AREA_TICKET_EXTERNAL_NOT_CONFIRMED',
    })
    expect(await prisma.areaTicketFulfillment.count({ where: { areaTicketId: t.id } })).toBe(0)
  })

  it('entregar dos veces crea UN solo evento y devuelve actor y hora del primero', async () => {
    const t = await issueAndConfirmExternal()

    const first = await fulfillAreaTicket(venueId, t.id, fulfillInput())
    // Segunda llamada con OTRA idempotencyKey y SIN staffId: la idempotencia
    // de `fulfillAreaTicket` es por ESTADO (ya existe `ticket.fulfillment`),
    // nunca por comparar la llave recibida — un reintento tiene que ver el
    // actor y la hora del PRIMERO, jamás los suyos propios.
    const second = await fulfillAreaTicket(venueId, t.id, fulfillInput({ staffId: null }))

    expect(second.alreadyFulfilled).toBe(true)
    expect(second.fulfillment.id).toBe(first.fulfillment.id)
    expect(second.fulfillment.deliveredAt).toEqual(first.fulfillment.deliveredAt)
    expect(second.fulfillment.deliveredBy).toBe(first.fulfillment.deliveredBy)
    expect(await prisma.areaTicketFulfillment.count({ where: { areaTicketId: t.id } })).toBe(1)
  })

  it('un vale externo elegible SÍ aparece en pendientes — la lista es la unión con los nativos', async () => {
    const eligible = await issueAndConfirmExternal()
    const stillPending = await issueExternalTicket()

    const pending = await listPendingAreaTicketFulfillment(venueId, { deviceUid: externalDeliveryDeviceUid })
    const ids = pending.tickets.map((ticket: any) => ticket.id)

    expect(ids).toContain(eligible.id)
    expect(ids).not.toContain(stillPending.id)
  })

  it('un área UNTRACKED no aparece en pendientes', async () => {
    await prisma.fulfillmentArea.update({
      where: { id: externalAreaId },
      data: { externalDeliveryTracking: ExternalDeliveryTracking.UNTRACKED },
    })
    try {
      await issueAndConfirmExternal()

      const p = await listPendingAreaTicketFulfillment(venueId, { deviceUid: externalDeliveryDeviceUid })
      // Nota: el brief de esta tarea escribe `p.items` en el pseudocódigo,
      // pero `listPendingAreaTicketFulfillment` (a diferencia de
      // `listPendingExternalConfirmation` de la Task 9) devuelve
      // `{ fulfillmentArea, tickets, nextCursor }` — verificado en el código
      // fuente (`areaTicketV7.mobile.service.ts`). `p.items` sería
      // `undefined` y `toHaveLength` fallaría por la razón equivocada.
      expect(p.tickets).toHaveLength(0)
    } finally {
      await prisma.fulfillmentArea.update({
        where: { id: externalAreaId },
        data: { externalDeliveryTracking: ExternalDeliveryTracking.TRACKED },
      })
    }
  })

  it('la ruta nativa sigue exigiendo Order pagada — la bifurcación no debilitó lo existente', async () => {
    // Regresión: un vale nativo PAID cuya Order NO está pagada (estado
    // inconsistente, forzado a mano — exactamente el escenario que
    // AREA_TICKET_NOT_PAID existe para atajar). Si la nueva bifurcación por
    // ruta alguna vez colapsara al "si no hay orden, sáltate la validación",
    // este vale SÍ tiene orden — así que ese bug específico no lo tocaría;
    // lo que este caso prueba es que la rama nativa, tal cual, se conserva
    // byte a byte: sigue leyendo `ticket.order.paymentStatus` y rechazando.
    const order = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `native-unpaid-${suffix}`,
        status: 'CONFIRMED',
        paymentStatus: 'PENDING', // a propósito NO 'PAID'
        subtotal: new Prisma.Decimal('20.00'),
        taxAmount: new Prisma.Decimal(0),
        total: new Prisma.Decimal('20.00'),
        paidAmount: new Prisma.Decimal(0),
        remainingBalance: new Prisma.Decimal('20.00'),
      },
    })
    const nativeTerminal = await prisma.terminal.findFirstOrThrow({ where: { deviceUid: nativeDeliveryDeviceUid } })
    const ticket = await prisma.areaTicket.create({
      data: {
        venueId,
        fulfillmentAreaId: nativeAreaId,
        fulfillmentModeSnapshot: FulfillmentMode.HOLD_UNTIL_PAID,
        settlementRoute: AreaSettlementRoute.AVOQADO,
        code: `native-unpaid-${suffix}`,
        idempotencyKey: `native-unpaid-key-${suffix}`,
        status: AreaTicketStatus.PAID,
        sourceTerminalId: nativeTerminal.id,
        orderId: order.id,
        subtotal: new Prisma.Decimal('20.00'),
        taxAmount: new Prisma.Decimal(0),
        total: new Prisma.Decimal('20.00'),
        pricingSnapshotHash: '0'.repeat(64),
        paidAt: new Date(),
      },
    })

    await expect(
      fulfillAreaTicket(venueId, ticket.id, {
        idempotencyKey: `native-unpaid-fulfill-${suffix}`,
        deviceUid: nativeDeliveryDeviceUid,
        staffId,
        method: AreaTicketFulfillmentMethod.PAPER_CONFIRMATION,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'AREA_TICKET_NOT_PAID' })
    expect(await prisma.areaTicketFulfillment.count({ where: { areaTicketId: ticket.id } })).toBe(0)
  })

  it('un vale NATIVO con orderId nulo NO se entrega — el modo de fallo contra el que existe la bifurcación', async () => {
    // Task 16, Step 6(a): la bifurcación explícita por ruta de la Task 10 se
    // blindó contra "cualquier `orderId` nulo ACCIDENTAL de la ruta nativa
    // convertido en una entrega gratis" (comentario en `fulfillAreaTicket`,
    // línea 2092), pero ningún test hasta ahora ejercitaba el caso EXACTO:
    // vale AVOQADO, `status: PAID`, `orderId: null`. El test de arriba ('la
    // ruta nativa sigue exigiendo Order pagada') es parecido pero SÍ tiene
    // `orderId` — prueba `order.paymentStatus !== 'PAID'`, no `!ticket.order`.
    // Se fuerza el estado por escritura directa a la base: ningún endpoint de
    // producción emite un vale AVOQADO sin `orderId` (`lockAreaTicketCheckoutForPayment`
    // siempre lo asigna desde una Order real antes de marcar PAID), y ese es
    // justamente el punto — el guard existe para el día que algo sí lo
    // produzca. Nada en el schema ni en el CHECK de la Task 2 impide esta fila:
    // `atf_order_required_for_avoqado_route` vive en `AreaTicketFulfillment`
    // (exige `orderId` sólo en la fila de ENTREGA), no en `AreaTicket`.
    //
    // Mismo patrón de fixture hecho a mano que el test anterior — el brief
    // pide un helper `issueNativeTicket(...)` que no existe en este archivo
    // (el área nativa no tiene terminal emisor, sólo uno de entrega); montar
    // esa infraestructura sólo para este caso habría sido más superficie de
    // fixture que el propio escenario que se prueba, y el archivo ya resuelve
    // "fuerza un vale AVOQADO inconsistente" con `prisma.areaTicket.create`
    // directo (ver el test de arriba).
    const nativeTerminal = await prisma.terminal.findFirstOrThrow({ where: { deviceUid: nativeDeliveryDeviceUid } })
    const ticket = await prisma.areaTicket.create({
      data: {
        venueId,
        fulfillmentAreaId: nativeAreaId,
        fulfillmentModeSnapshot: FulfillmentMode.HOLD_UNTIL_PAID,
        settlementRoute: AreaSettlementRoute.AVOQADO,
        code: `native-null-order-${suffix}`,
        idempotencyKey: `native-null-order-key-${suffix}`,
        status: AreaTicketStatus.PAID,
        sourceTerminalId: nativeTerminal.id,
        orderId: null,
        subtotal: new Prisma.Decimal('20.00'),
        taxAmount: new Prisma.Decimal(0),
        total: new Prisma.Decimal('20.00'),
        pricingSnapshotHash: '0'.repeat(64),
        paidAt: new Date(),
      },
    })

    await expect(
      fulfillAreaTicket(venueId, ticket.id, {
        idempotencyKey: `native-null-order-fulfill-${suffix}`,
        deviceUid: nativeDeliveryDeviceUid,
        staffId,
        method: AreaTicketFulfillmentMethod.PAPER_CONFIRMATION,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'AREA_TICKET_NOT_PAID' })
    expect(await prisma.areaTicketFulfillment.count({ where: { areaTicketId: ticket.id } })).toBe(0)
  })
})
