import { AreaSettlementRoute, FulfillmentMode, Prisma, TerminalStatus, TerminalType } from '@prisma/client'

import { issueAreaTicket } from '@/services/mobile/areaTicketV7.mobile.service'
import prisma from '@/utils/prismaClient'

/**
 * Caja externa (spec 2026-09-30 D5): de punta a punta, del `Modifier.sku` real al vale emitido.
 * La otra caja cobra escaneando un código por producto y por extra; si un extra con precio no
 * trae código, el servidor no emite el vale. La ruta AVOQADO no pasa por esa guarda.
 */
describe('Caja externa: el código de cada extra en el vale', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let organizationId: string
  let venueId: string
  let productId: string
  let shotId: string
  let sinAzucarId: string
  let almendraId: string
  const nativeDeviceUid = `codes-native-${suffix}`
  const externalDeviceUid = `codes-external-${suffix}`

  beforeAll(async () => {
    const organization = await prisma.organization.create({
      data: { name: `Caja externa códigos ${suffix}`, email: `caja-externa-codigos-${suffix}@example.com`, phone: '5555555555' },
    })
    organizationId = organization.id

    const venue = await prisma.venue.create({
      data: { organizationId, name: `Caja externa códigos venue ${suffix}`, slug: `caja-externa-codigos-${suffix}`, seatCapExempt: true },
    })
    venueId = venue.id

    // Reserva de inventario en su default (NONE): este archivo prueba códigos, no existencias.
    await prisma.venueAreaTicketSettings.create({ data: { venueId, enabled: true } })

    const nativeArea = await prisma.fulfillmentArea.create({
      data: { venueId, name: `Barra nativa ${suffix}`, fulfillmentMode: FulfillmentMode.HOLD_UNTIL_PAID },
    })
    const externalArea = await prisma.fulfillmentArea.create({
      data: {
        venueId,
        name: `Barra externa ${suffix}`,
        fulfillmentMode: FulfillmentMode.HOLD_UNTIL_PAID,
        settlementRoute: AreaSettlementRoute.EXTERNAL,
      },
    })
    await prisma.terminal.createMany({
      data: [
        {
          venueId,
          name: 'Emisión nativa',
          type: TerminalType.POS_ANDROID,
          status: TerminalStatus.ACTIVE,
          deviceUid: nativeDeviceUid,
          fulfillmentAreaId: nativeArea.id,
          canIssueAreaTickets: true,
        },
        {
          venueId,
          name: 'Emisión externa',
          type: TerminalType.POS_ANDROID,
          status: TerminalStatus.ACTIVE,
          deviceUid: externalDeviceUid,
          fulfillmentAreaId: externalArea.id,
          canIssueAreaTickets: true,
        },
      ],
    })

    const category = await prisma.menuCategory.create({
      data: { venueId, name: 'Bebidas', slug: `caja-externa-codigos-${suffix}`, availableDays: [] },
    })
    const product = await prisma.product.create({
      data: {
        venueId,
        categoryId: category.id,
        sku: `P000500-${suffix}`,
        name: 'Latte',
        price: 55,
        taxRate: new Prisma.Decimal('0.16'),
        tags: [],
        allergens: [],
        trackInventory: false,
      },
    })
    productId = product.id

    const group = await prisma.modifierGroup.create({ data: { venueId, name: 'Extras' } })
    const extra = (name: string, price: number, sku?: string) => prisma.modifier.create({ data: { groupId: group.id, name, price, sku } })
    shotId = (await extra('Shot de espresso', 15, 'P000672')).id
    sinAzucarId = (await extra('Sin azúcar', 0)).id
    almendraId = (await extra('Leche de almendra', 10)).id
  })

  afterAll(async () => {
    if (!venueId) return
    await prisma.areaTicketExternalSettlement.deleteMany({ where: { venueId } })
    await prisma.areaTicket.deleteMany({ where: { venueId } })
    await prisma.modifier.deleteMany({ where: { group: { venueId } } })
    await prisma.modifierGroup.deleteMany({ where: { venueId } })
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.terminal.deleteMany({ where: { venueId } })
    await prisma.fulfillmentArea.deleteMany({ where: { venueId } })
    await prisma.venueAreaTicketSettings.deleteMany({ where: { venueId } })
    await prisma.venue.delete({ where: { id: venueId } })
    if (organizationId) await prisma.organization.delete({ where: { id: organizationId } })
    await prisma.$disconnect()
  })

  it('emite en caja externa y congela el SKU de cada extra', async () => {
    const ticket = await issueAreaTicket(venueId, {
      idempotencyKey: `codes-${suffix}-1`,
      deviceUid: externalDeviceUid,
      lines: [{ clientLineId: 'l1', productId, quantity: '2', modifierIds: [shotId, sinAzucarId] }],
    })
    expect(ticket.settlementRoute).toBe('EXTERNAL')
    expect(ticket.lines[0].skuSnapshot).toBe(`P000500-${suffix}`)
    expect(ticket.lines[0].modifiersSnapshot).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Shot de espresso', sku: 'P000672' }),
        expect.objectContaining({ name: 'Sin azúcar', sku: null }),
      ]),
    )
  })

  it('P1 rechaza en caja externa un extra con precio sin SKU — y no deja vale a medias', async () => {
    const before = await prisma.areaTicket.count({ where: { venueId } })
    await expect(
      issueAreaTicket(venueId, {
        idempotencyKey: `codes-${suffix}-2`,
        deviceUid: externalDeviceUid,
        lines: [{ clientLineId: 'l1', productId, quantity: '1', modifierIds: [almendraId] }],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'EXTERNAL_CODE_MAPPING_MISSING' })
    expect(await prisma.areaTicket.count({ where: { venueId } })).toBe(before)
  })

  it('la ruta AVOQADO no cambia: el mismo extra sin SKU se emite como siempre', async () => {
    const ticket = await issueAreaTicket(venueId, {
      idempotencyKey: `codes-${suffix}-3`,
      deviceUid: nativeDeviceUid,
      lines: [{ clientLineId: 'l1', productId, quantity: '1', modifierIds: [almendraId] }],
    })
    expect(ticket.settlementRoute).toBe('AVOQADO')
    expect(ticket.lines[0].modifiersSnapshot[0]).toMatchObject({ name: 'Leche de almendra', sku: null })
  })
})
