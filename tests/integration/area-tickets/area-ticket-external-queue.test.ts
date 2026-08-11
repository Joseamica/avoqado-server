import {
  AreaSettlementRoute,
  AreaTicketExternalSettlementStatus,
  AreaTicketStatus,
  FulfillmentMode,
  InventoryMethod,
  Prisma,
  StaffRole,
  TerminalStatus,
  TerminalType,
  Unit,
} from '@prisma/client'

import {
  confirmExternalSettlement,
  listPendingExternalConfirmation,
  markExternalNotCharged,
} from '@/services/mobile/areaTicketExternal.mobile.service'
import { encodePendingCursor, issueAreaTicket } from '@/services/mobile/areaTicketV7.mobile.service'
import prisma from '@/utils/prismaClient'

/**
 * Task 9 — la cola que el operador del área mira para saber qué le falta
 * confirmar. Es una lectura (no toca `AreaTicketExternalSettlement`), pero el
 * filtro es la parte que importa: sólo vales `EXTERNAL` + `ISSUED` +
 * settlement `PENDING`, área derivada de la TERMINAL autenticada (nunca del
 * body), y cursor estable — no offset — para que un vale nuevo emitido
 * mientras el operador lee la lista no le traslape ni le brinque filas.
 *
 * Reusa el mismo fixture de dos áreas (nativa + externa) que
 * `area-ticket-external-issue.test.ts` y `area-ticket-external-not-claimable.test.ts`
 * ya probaron — no reinventa el patrón de fixture, sólo lo usa para su propio
 * caso: listar, no mutar.
 */
describe('listPendingExternalConfirmation — cola de cobros por confirmar', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let organizationId: string
  let venueId: string
  let staffId: string
  let externalAreaId: string
  let nativeAreaId: string
  // Step 4 (Task 10, revisión de la Task 9): segunda área EXTERNAL — el test
  // de aislamiento original comparaba contra una terminal NATIVA, que queda
  // fuera por TRES condiciones independientes a la vez (fulfillmentAreaId,
  // settlementRoute, ausencia de externalSettlement), así que no vigilaba el
  // filtro de área que decía vigilar. Con dos áreas EXTERNAL, sólo
  // fulfillmentAreaId las distingue.
  let secondExternalAreaId: string
  let productId: string
  let externalIssueDeviceUid: string
  let nativeIssueDeviceUid: string
  let segundaAreaDeviceUid: string
  let issueCounter = 0

  beforeAll(async () => {
    const organization = await prisma.organization.create({
      data: {
        name: `Caja externa cola ${suffix}`,
        email: `caja-externa-cola-${suffix}@example.com`,
        phone: '5555555555',
      },
    })
    organizationId = organization.id

    const venue = await prisma.venue.create({
      data: {
        organizationId,
        name: `Caja externa cola venue ${suffix}`,
        slug: `caja-externa-cola-${suffix}`,
        seatCapExempt: true,
      },
    })
    venueId = venue.id

    const staff = await prisma.staff.create({
      data: {
        email: `caja-externa-cola-staff-${suffix}@example.com`,
        firstName: 'Cola',
        lastName: 'Externa',
      },
    })
    staffId = staff.id
    await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.MANAGER } })

    // Área nativa (ruta AVOQADO) — la necesita el caso de aislamiento: una
    // terminal de otra área nunca debe ver la cola de la externa.
    const nativeArea = await prisma.fulfillmentArea.create({
      data: { venueId, name: `Cremería nativa cola ${suffix}`, fulfillmentMode: FulfillmentMode.HOLD_UNTIL_PAID },
    })
    nativeAreaId = nativeArea.id

    // Área externa: otro POS cobra en su propia caja — la que este archivo lista.
    const externalArea = await prisma.fulfillmentArea.create({
      data: {
        venueId,
        name: `Cremería externa cola ${suffix}`,
        fulfillmentMode: FulfillmentMode.HOLD_UNTIL_PAID,
        settlementRoute: AreaSettlementRoute.EXTERNAL,
      },
    })
    externalAreaId = externalArea.id

    externalIssueDeviceUid = `queue-issue-external-${suffix}`
    nativeIssueDeviceUid = `queue-issue-native-${suffix}`
    await prisma.terminal.createMany({
      data: [
        {
          venueId,
          name: 'Emisión externa (cola)',
          type: TerminalType.POS_ANDROID,
          status: TerminalStatus.ACTIVE,
          deviceUid: externalIssueDeviceUid,
          fulfillmentAreaId: externalAreaId,
          canIssueAreaTickets: true,
        },
        {
          venueId,
          name: 'Emisión nativa (cola)',
          type: TerminalType.POS_ANDROID,
          status: TerminalStatus.ACTIVE,
          deviceUid: nativeIssueDeviceUid,
          fulfillmentAreaId: nativeAreaId,
          canIssueAreaTickets: true,
        },
      ],
    })

    // Step 4 (Task 10): segunda área EXTERNAL + su propia terminal — ver
    // comentario en la declaración de `secondExternalAreaId` arriba.
    const secondExternalArea = await prisma.fulfillmentArea.create({
      data: {
        venueId,
        name: `Cremería externa cola 2 ${suffix}`,
        fulfillmentMode: FulfillmentMode.HOLD_UNTIL_PAID,
        settlementRoute: AreaSettlementRoute.EXTERNAL,
      },
    })
    secondExternalAreaId = secondExternalArea.id
    segundaAreaDeviceUid = `queue-issue-external-2-${suffix}`
    await prisma.terminal.create({
      data: {
        venueId,
        name: 'Emisión externa 2 (cola)',
        type: TerminalType.POS_ANDROID,
        status: TerminalStatus.ACTIVE,
        deviceUid: segundaAreaDeviceUid,
        fulfillmentAreaId: secondExternalAreaId,
        canIssueAreaTickets: true,
      },
    })

    // inventoryReservationMode se deja en su default (NONE): este archivo
    // prueba la cola, no inventario — Tasks 4/5 ya cubren la reserva/reversa.
    await prisma.venueAreaTicketSettings.create({ data: { venueId, enabled: true } })

    const category = await prisma.menuCategory.create({
      data: { venueId, name: 'Cola externa', slug: `caja-externa-cola-${suffix}`, availableDays: [] },
    })
    const product = await prisma.product.create({
      data: {
        venueId,
        categoryId: category.id,
        sku: `EXT-QUEUE-${suffix}`,
        name: 'Producto cola externa',
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
    await prisma.inventory.create({ data: { venueId, productId, currentStock: new Prisma.Decimal('500.000') } })
  })

  afterAll(async () => {
    if (!venueId) return
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

  async function issueExternalTicket() {
    issueCounter += 1
    return issueAreaTicket(venueId, {
      idempotencyKey: `queue-ext-${suffix}-${issueCounter}`,
      deviceUid: externalIssueDeviceUid,
      lines: [{ clientLineId: 'l1', productId, quantity: '1' }],
    })
  }

  // Step 4 (Task 10): mismo vale, emitido en la SEGUNDA área EXTERNAL.
  async function issueExternalTicketInSecondArea() {
    issueCounter += 1
    return issueAreaTicket(venueId, {
      idempotencyKey: `queue-ext-2-${suffix}-${issueCounter}`,
      deviceUid: segundaAreaDeviceUid,
      lines: [{ clientLineId: 'l1', productId, quantity: '1' }],
    })
  }

  it('devuelve sólo los vales EXTERNAL/ISSUED/PENDING del área de la terminal autenticada, con su importe de referencia', async () => {
    const ticket = await issueExternalTicket()

    const r = await listPendingExternalConfirmation(venueId, { deviceUid: externalIssueDeviceUid })

    expect(r.items.length).toBeGreaterThan(0)
    expect(r.items.every(i => i.fulfillmentAreaId === externalAreaId)).toBe(true)

    const found = r.items.find(i => i.id === ticket.id)
    expect(found).toBeDefined()
    expect(found!.code).toBe(ticket.code)
    // referenceAmount congela el total del vale al emitir (Task 6) — la cola
    // expone el MISMO número, no lo recalcula.
    expect(found!.referenceAmount).toBe(ticket.total)
    // El papel no ha salido del área todavía — Task 6 no corrió sobre este vale.
    expect(found!.handoffState).toBe('PENDING')
  })

  it('excluye los ya confirmados (con y sin discrepancia), los asumidos, los no-cobrados, los cancelados y los vencidos', async () => {
    const confirmed = await issueExternalTicket()
    await confirmExternalSettlement(venueId, confirmed.id, {
      idempotencyKey: `queue-confirm-ok-${suffix}`,
      deviceUid: externalIssueDeviceUid,
    })

    const discrepancy = await issueExternalTicket()
    await confirmExternalSettlement(venueId, discrepancy.id, {
      idempotencyKey: `queue-confirm-disc-${suffix}`,
      deviceUid: externalIssueDeviceUid,
      externalAmount: '1.00', // distinto del total (20.00) => DISCREPANCY
    })

    // ASSUMED: hoy ningún código de producción lo produce todavía (el modo
    // automático "asumir al imprimir" es trabajo futuro de este mismo plan) —
    // se fuerza directo en la fila, sólo para probar el filtro de la cola.
    const assumed = await issueExternalTicket()
    await prisma.areaTicketExternalSettlement.update({
      where: { areaTicketId: assumed.id },
      data: { status: AreaTicketExternalSettlementStatus.ASSUMED },
    })

    const notCharged = await issueExternalTicket()
    await markExternalNotCharged(venueId, notCharged.id, {
      idempotencyKey: `queue-nc-${suffix}`,
      deviceUid: externalIssueDeviceUid,
      reason: 'Cliente no pasó a la caja externa',
    })

    const cancelled = await issueExternalTicket()
    await prisma.areaTicket.update({ where: { id: cancelled.id }, data: { status: AreaTicketStatus.CANCELLED } })

    const expired = await issueExternalTicket()
    await prisma.areaTicket.update({ where: { id: expired.id }, data: { status: AreaTicketStatus.EXPIRED } })

    const r = await listPendingExternalConfirmation(venueId, { deviceUid: externalIssueDeviceUid, limit: 100 })
    const ids = r.items.map(i => i.id)
    for (const excluded of [confirmed, discrepancy, assumed, notCharged, cancelled, expired]) {
      expect(ids).not.toContain(excluded.id)
    }
  })

  it('ordena por antigüedad y pagina por cursor estable — un vale nuevo a media lectura no traslapa', async () => {
    // Ancla propia de este caso: un cursor sintético fechado justo antes de
    // los tres vales de este test aísla la aserción de cualquier vale
    // PENDING que hayan dejado los casos anteriores (reusa el MISMO
    // encode/decode que la implementación, no un mecanismo aparte).
    const anchor = new Date()
    const anchorCursor = encodePendingCursor({ issuedAt: anchor, id: '0' })

    const a = await issueExternalTicket()
    await prisma.areaTicket.update({ where: { id: a.id }, data: { issuedAt: new Date(anchor.getTime() + 1000) } })
    const b = await issueExternalTicket()
    await prisma.areaTicket.update({ where: { id: b.id }, data: { issuedAt: new Date(anchor.getTime() + 2000) } })
    const c = await issueExternalTicket()
    await prisma.areaTicket.update({ where: { id: c.id }, data: { issuedAt: new Date(anchor.getTime() + 3000) } })

    const first = await listPendingExternalConfirmation(venueId, {
      deviceUid: externalIssueDeviceUid,
      cursor: anchorCursor,
      limit: 2,
    })
    expect(first.items.map(i => i.id)).toEqual([a.id, b.id])
    expect(first.nextCursor).not.toBeNull()

    // Mientras el operador "lee" la página 1, entra un vale nuevo — ordenado
    // ANTES del punto donde se quedó el cursor (simula el caso real: alguien
    // emite un vale externo justo a media consulta).
    const mid = await issueExternalTicket()
    await prisma.areaTicket.update({ where: { id: mid.id }, data: { issuedAt: new Date(anchor.getTime() + 1500) } })

    const second = await listPendingExternalConfirmation(venueId, {
      deviceUid: externalIssueDeviceUid,
      cursor: first.nextCursor,
      limit: 10,
    })
    // Un cursor por OFFSET, al insertarse una fila antes de la posición ya
    // leída, recorre el índice: repite `b` (o brinca `c`) en la página 2. El
    // cursor estable (issuedAt, id) ignora esa fila nueva —anterior al punto
    // de corte— y sigue exactamente donde se quedó: sólo `c`. `mid` no se
    // pierde: aparece en una lectura FRESCA de la página 1, no en esta.
    expect(second.items.map(i => i.id)).toEqual([c.id])
    expect(second.items.map(i => i.id)).not.toEqual(expect.arrayContaining(first.items.map(i => i.id)))
    expect(second.nextCursor).toBeNull()
  })

  it('una terminal de otra área no ve estos vales', async () => {
    const r = await listPendingExternalConfirmation(venueId, { deviceUid: nativeIssueDeviceUid })
    expect(r.items).toHaveLength(0)
  })

  // Step 4 (Task 10) — el test de arriba usa una terminal NATIVA, que queda
  // fuera de la cola por TRES condiciones independientes a la vez
  // (fulfillmentAreaId, settlementRoute: EXTERNAL, y la ausencia de relación
  // externalSettlement): pasaría igual si se borrara la línea de
  // `fulfillmentAreaId` de la query — no vigila el predicado que dice
  // vigilar, que es justo la regla de seguridad central de este módulo. El
  // código de la query ya era correcto (verificado en revisión); lo que
  // fallaba era la prueba. Este test lo arregla con DOS áreas EXTERNAL: la
  // única diferencia entre ellas es el área, así que sólo el filtro de área
  // puede explicar el aislamiento.
  it('una terminal de OTRA área externa no ve estos vales — aísla el filtro de área, no otros', async () => {
    const mio = await issueExternalTicket()
    const ajeno = await issueExternalTicketInSecondArea()

    const propia = await listPendingExternalConfirmation(venueId, { deviceUid: externalIssueDeviceUid })
    expect(propia.items.map((i: any) => i.id)).toContain(mio.id)
    expect(propia.items.map((i: any) => i.id)).not.toContain(ajeno.id)

    const otra = await listPendingExternalConfirmation(venueId, { deviceUid: segundaAreaDeviceUid })
    expect(otra.items.map((i: any) => i.id)).toContain(ajeno.id)
    expect(otra.items.map((i: any) => i.id)).not.toContain(mio.id)
  })

  it('una terminal sin área asignada no truena — regresa una cola vacía', async () => {
    const noAreaDeviceUid = `queue-no-area-${suffix}`
    await prisma.terminal.create({
      data: {
        venueId,
        name: 'Caja sin área (cola)',
        type: TerminalType.POS_ANDROID,
        status: TerminalStatus.ACTIVE,
        deviceUid: noAreaDeviceUid,
        canCheckoutAreaTickets: true,
      },
    })

    const r = await listPendingExternalConfirmation(venueId, { deviceUid: noAreaDeviceUid })
    expect(r).toEqual({ items: [], nextCursor: null })
  })

  it('el límite por default es 25 y el tope es 100, aunque pidan más', async () => {
    const spy = jest.spyOn(prisma.areaTicket, 'findMany')
    try {
      await listPendingExternalConfirmation(venueId, { deviceUid: externalIssueDeviceUid })
      const defaultCall = spy.mock.calls[spy.mock.calls.length - 1][0] as { take?: number }
      // +1 sobre el límite: así la función sabe si hay más páginas sin pedir
      // una segunda vuelta.
      expect(defaultCall.take).toBe(26)

      await listPendingExternalConfirmation(venueId, { deviceUid: externalIssueDeviceUid, limit: 5000 })
      const cappedCall = spy.mock.calls[spy.mock.calls.length - 1][0] as { take?: number }
      expect(cappedCall.take).toBe(101)
    } finally {
      spy.mockRestore()
    }
  })
})
