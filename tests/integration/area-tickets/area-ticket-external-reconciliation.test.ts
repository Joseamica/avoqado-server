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

import { runAreaTicketExternalReconciliation } from '@/jobs/areaTicketExternalReconciliation.job'
import { issueAreaTicket } from '@/services/mobile/areaTicketV7.mobile.service'
import prisma from '@/utils/prismaClient'

/**
 * Task 12 — el job de conciliación, contra Postgres real.
 *
 * La suite unit (`tests/unit/jobs/areaTicketExternalReconciliation.test.ts`) cubre los
 * cinco casos del brief con Prisma mockeado. Lo que un mock NO puede probar es si
 * correr el job DOS VECES sobre el mismo vale de verdad deja UNA sola fila en
 * `AreaTicketExternalIncident` — eso depende del `@@unique([areaTicketId, kind])` real
 * del motor, y de que el `upsert` tome su rama `update` (reabrir) en la segunda
 * pasada, no `create` (que chocaría con la restricción). La revisión de la Task 7 dejó
 * anotado que esa rama nunca se había ejercitado contra una base real — este archivo
 * es lo que la prueba de verdad, no la hereda como "ya verificada".
 */
describe('runAreaTicketExternalReconciliation — contra Postgres real', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let organizationId: string
  let venueId: string
  let staffId: string
  let externalAreaId: string
  let productId: string
  let externalIssueDeviceUid: string
  let issueCounter = 0

  beforeAll(async () => {
    const organization = await prisma.organization.create({
      data: {
        name: `Caja externa reconciliación ${suffix}`,
        email: `caja-externa-recon-${suffix}@example.com`,
        phone: '5555555555',
      },
    })
    organizationId = organization.id

    // Timezone se deja en su DEFAULT del schema (America/Mexico_City) — el job lee
    // `venue.timezone` de la fila real, no de un mock; este test depende de que ese
    // default siga siendo el mismo que usa `venueStartOfDay` por default.
    const venue = await prisma.venue.create({
      data: {
        organizationId,
        name: `Caja externa reconciliación venue ${suffix}`,
        slug: `caja-externa-recon-${suffix}`,
        seatCapExempt: true,
      },
    })
    venueId = venue.id

    const staff = await prisma.staff.create({
      data: {
        email: `caja-externa-recon-staff-${suffix}@example.com`,
        firstName: 'Reconciliación',
        lastName: 'Externa',
      },
    })
    staffId = staff.id
    await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.MANAGER } })

    // `externalConfirmationMode` se deja en su default de schema (MANUAL) — el job
    // sólo procesa vales MANUAL, y este test necesita justo ese modo.
    const externalArea = await prisma.fulfillmentArea.create({
      data: {
        venueId,
        name: `Cremería externa reconciliación ${suffix}`,
        fulfillmentMode: FulfillmentMode.HOLD_UNTIL_PAID,
        settlementRoute: AreaSettlementRoute.EXTERNAL,
      },
    })
    externalAreaId = externalArea.id

    externalIssueDeviceUid = `recon-issue-external-${suffix}`
    await prisma.terminal.create({
      data: {
        venueId,
        name: 'Emisión externa (reconciliación)',
        type: TerminalType.POS_ANDROID,
        status: TerminalStatus.ACTIVE,
        deviceUid: externalIssueDeviceUid,
        fulfillmentAreaId: externalAreaId,
        canIssueAreaTickets: true,
      },
    })

    await prisma.venueAreaTicketSettings.create({ data: { venueId, enabled: true } })

    const category = await prisma.menuCategory.create({
      data: { venueId, name: 'Reconciliación externa', slug: `caja-externa-recon-${suffix}`, availableDays: [] },
    })
    const product = await prisma.product.create({
      data: {
        venueId,
        categoryId: category.id,
        sku: `EXT-RECON-${suffix}`,
        name: 'Producto reconciliación externa',
        price: new Prisma.Decimal('75.00'),
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
    await prisma.areaTicketExternalIncident.deleteMany({ where: { venueId } })
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

  async function issueExternalTicketFromYesterday() {
    issueCounter += 1
    const ticket = await issueAreaTicket(venueId, {
      idempotencyKey: `recon-ext-${suffix}-${issueCounter}`,
      deviceUid: externalIssueDeviceUid,
      lines: [{ clientLineId: 'l1', productId, quantity: '1' }],
    })
    // Backdate a un día operativo claramente anterior — 3 días atrás, sin importar a
    // qué hora corra este test, nunca cae del lado de "hoy" en ningún timezone real.
    await prisma.areaTicket.update({
      where: { id: ticket.id },
      data: { issuedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) },
    })
    return ticket
  }

  it('correr el job dos veces sobre el mismo vale deja UNA fila con occurrenceCount:2 y reopenedAt sellado', async () => {
    const ticket = await issueExternalTicketFromYesterday()

    // --- Primera corrida: INSERT liso (el unique no encuentra fila previa) ---
    await runAreaTicketExternalReconciliation()

    const afterFirst = await prisma.areaTicketExternalIncident.findMany({
      where: { areaTicketId: ticket.id, kind: 'UNCONFIRMED_CHARGE' },
    })
    expect(afterFirst).toHaveLength(1)
    expect(afterFirst[0].status).toBe('OPEN')
    expect(afterFirst[0].occurrenceCount).toBe(1)
    expect(afterFirst[0].reopenedAt).toBeNull()
    const incidentId = afterFirst[0].id

    // --- Segunda corrida: el vale SIGUE PENDING (nadie lo confirmó) — el `upsert`
    // debe tomar la rama `update` sobre la MISMA fila, no chocar contra el unique ni
    // insertar una segunda. ---
    await runAreaTicketExternalReconciliation()

    const afterSecond = await prisma.areaTicketExternalIncident.findMany({
      where: { areaTicketId: ticket.id, kind: 'UNCONFIRMED_CHARGE' },
    })
    // UNA fila, no dos — la prueba directa de que `@@unique([areaTicketId, kind])`
    // hizo su trabajo y el código realmente reabrió en vez de duplicar.
    expect(afterSecond).toHaveLength(1)
    expect(afterSecond[0].id).toBe(incidentId)
    expect(afterSecond[0].status).toBe('OPEN')
    expect(afterSecond[0].occurrenceCount).toBe(2)
    expect(afterSecond[0].reopenedAt).not.toBeNull()
    expect(afterSecond[0].reopenedAt!.getTime()).toBeGreaterThanOrEqual(afterFirst[0].openedAt.getTime())
  })
})
