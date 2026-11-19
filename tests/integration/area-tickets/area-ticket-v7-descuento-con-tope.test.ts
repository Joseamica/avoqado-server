import { AreaSettlementRoute, DiscountScope, DiscountType, FulfillmentMode, Prisma, StaffRole, TerminalStatus, TerminalType } from '@prisma/client'

import {
  addTicketToCheckout,
  createAreaTicketCheckout,
  issueAreaTicket,
  materializeAreaTicketCheckout,
} from '@/services/mobile/areaTicketV7.mobile.service'
import prisma from '@/utils/prismaClient'
import { encenderIvaPorProducto } from '@tests/__helpers__/iva-por-producto'

/**
 * D11 (pizarrón hz:e82938e1:D11, 18-nov; founder: «no puede haber un hueco»), contra Postgres: en una venta con vales no se usa un
 * descuento con tope de usos (total `maxTotalUses` o por clienta `maxUsesPerCustomer`). Se rechaza con 400 AREA_TICKET_DISCOUNT_HAS_LIMIT
 * al imprimir el vale y al armar la venta (un suelto), antes de escribir nada: ni vale, ni orden, ni contador. Sin tope, como siempre; la
 * ruta EXTERNAL, como siempre; la misma llave de un vale ya impreso lo devuelve.
 */
describe('Vales V7 — D11: los descuentos con tope de usos no entran a una venta con vales', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let organizationId: string
  let venueId: string
  let staffId: string
  let jamonId: string
  let papasId: string
  let sinTopeId: string
  let topeTotalId: string
  let topePorClientaId: string
  let agotadoId: string
  const issueDeviceUid = `tope-issue-${suffix}`
  const externalDeviceUid = `tope-externa-${suffix}`
  const checkoutDeviceUid = `tope-caja-${suffix}`

  beforeAll(async () => {
    organizationId = (
      await prisma.organization.create({
        data: { name: `Vales tope ${suffix}`, email: `vales-tope-${suffix}@example.com`, phone: '5555555555' },
      })
    ).id
    venueId = (await prisma.venue.create({ data: { organizationId, name: `Vales tope ${suffix}`, slug: `vales-tope-${suffix}`, seatCapExempt: true } }))
      .id
    await encenderIvaPorProducto(venueId)
    staffId = (await prisma.staff.create({ data: { email: `vales-tope-staff-${suffix}@example.com`, firstName: 'Área', lastName: 'Cremería' } }))
      .id
    await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.MANAGER } })

    const area = await prisma.fulfillmentArea.create({ data: { venueId, name: `Cremería ${suffix}`, fulfillmentMode: 'HOLD_UNTIL_PAID' } })
    const externa = await prisma.fulfillmentArea.create({
      data: { venueId, name: `Externa ${suffix}`, fulfillmentMode: FulfillmentMode.HOLD_UNTIL_PAID, settlementRoute: AreaSettlementRoute.EXTERNAL },
    })
    await prisma.terminal.createMany({
      data: [
        { venueId, name: 'Cremería', type: TerminalType.POS_ANDROID, status: TerminalStatus.ACTIVE, deviceUid: issueDeviceUid, fulfillmentAreaId: area.id, canIssueAreaTickets: true },
        { venueId, name: 'Externa', type: TerminalType.POS_ANDROID, status: TerminalStatus.ACTIVE, deviceUid: externalDeviceUid, fulfillmentAreaId: externa.id, canIssueAreaTickets: true },
        { venueId, name: 'Caja', type: TerminalType.POS_ANDROID, status: TerminalStatus.ACTIVE, deviceUid: checkoutDeviceUid, canCheckoutAreaTickets: true },
      ],
    })
    await prisma.venueAreaTicketSettings.create({ data: { venueId, enabled: true } })

    const category = await prisma.menuCategory.create({ data: { venueId, name: 'Abarrotes', slug: `abarrotes-${suffix}`, availableDays: [] } })
    const producto = (name: string, price: string) =>
      prisma.product.create({
        data: { venueId, categoryId: category.id, sku: `${name.toUpperCase()}-${suffix}`, name, price: new Prisma.Decimal(price), taxRate: new Prisma.Decimal(0), tags: [], allergens: [] },
      })
    jamonId = (await producto('Jamon', '100.00')).id
    papasId = (await producto('Papas', '50.00')).id

    const descuento = (name: string, extra: Partial<Prisma.DiscountUncheckedCreateInput> = {}) =>
      prisma.discount.create({
        data: { venueId, name, type: DiscountType.PERCENTAGE, value: new Prisma.Decimal(10), scope: DiscountScope.ITEM, ...extra },
      })
    sinTopeId = (await descuento('10 % sin tope')).id
    topeTotalId = (await descuento('Primeros 100', { maxTotalUses: 100 })).id
    topePorClientaId = (await descuento('1 por clienta', { maxUsesPerCustomer: 1 })).id
    agotadoId = (await descuento('Agotado', { maxTotalUses: 1, currentUses: 1 })).id
  })

  afterAll(async () => {
    if (!venueId) return
    await prisma.areaTicketPaymentAttempt.deleteMany({ where: { checkoutSession: { venueId } } })
    await prisma.areaTicketExternalSettlement.deleteMany({ where: { venueId } })
    await prisma.orderDiscount.deleteMany({ where: { order: { venueId } } })
    await prisma.orderItemModifier.deleteMany({ where: { orderItem: { order: { venueId } } } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.areaTicket.deleteMany({ where: { venueId } })
    await prisma.areaTicketCheckoutSession.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.discount.deleteMany({ where: { venueId } })
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

  const emitir = (llave: string, discountId?: string, deviceUid = issueDeviceUid) =>
    issueAreaTicket(venueId, {
      idempotencyKey: `${llave}-${suffix}`,
      deviceUid,
      staffId,
      performedBy: staffId,
      lines: [{ clientLineId: `${llave}-l1-${suffix}`, productId: jamonId, quantity: '1', ...(discountId ? { discountId } : {}) }],
    })
  const usos = async () => (await prisma.discount.findMany({ where: { venueId }, select: { name: true, currentUses: true }, orderBy: { name: 'asc' }, take: 10 }))

  it('🔴 imprimir un vale con un descuento con tope (total, por clienta o ya agotado) ⇒ 400 con el texto del área, sin vale ni contador', async () => {
    const antes = await usos()
    for (const [llave, id, nombre] of [
      ['total', topeTotalId, 'Primeros 100'],
      ['clienta', topePorClientaId, '1 por clienta'],
      ['agotado', agotadoId, 'Agotado'],
    ] as const) {
      await expect(emitir(llave, id)).rejects.toMatchObject({
        statusCode: 400,
        code: 'AREA_TICKET_DISCOUNT_HAS_LIMIT',
        message: `El descuento «${nombre}» tiene tope de usos y no se puede poner en un vale: emite el vale sin ese descuento.`,
      })
    }
    expect(await prisma.areaTicket.count({ where: { venueId } })).toBe(0)
    expect(await usos()).toEqual(antes)
  })

  it('sin tope se imprime como siempre; la misma llave de un vale ya impreso lo devuelve aunque después le pongan tope', async () => {
    const vale = await emitir('sin-tope', sinTopeId)
    expect(vale.discountAmount).toBe('10.00')
    await prisma.discount.update({ where: { id: sinTopeId }, data: { maxTotalUses: 50 } })
    try {
      const otraVez = await emitir('sin-tope', sinTopeId)
      expect(otraVez.code).toBe(vale.code)
    } finally {
      await prisma.discount.update({ where: { id: sinTopeId }, data: { maxTotalUses: null } })
    }
  })

  it('la ruta EXTERNAL queda como hoy: su propio rechazo de rebajas, no el de D11', async () => {
    await expect(emitir('externa', topeTotalId, externalDeviceUid)).rejects.not.toMatchObject({ code: 'AREA_TICKET_DISCOUNT_HAS_LIMIT' })
  })

  it('🔴 armar la venta con un suelto con tope ⇒ 400 con el texto de la caja, sin orden; sin ese descuento se arma', async () => {
    const vale = await emitir('para-armar')
    const caja = await createAreaTicketCheckout(venueId, { idempotencyKey: `tope-caja-${suffix}`, deviceUid: checkoutDeviceUid, staffId })
    await addTicketToCheckout(venueId, caja.id, vale.code, { idempotencyKey: `tope-claim-${suffix}`, deviceUid: checkoutDeviceUid, staffId })
    const armar = (llave: string, discountId?: string) =>
      materializeAreaTicketCheckout(venueId, caja.id, {
        idempotencyKey: `${llave}-${suffix}`,
        deviceUid: checkoutDeviceUid,
        staffId,
        performedBy: staffId,
        source: 'AVOQADO_ANDROID' as const,
        normalItems: [{ productId: papasId, quantity: 1, ...(discountId ? { discountId } : {}) }],
      })

    const antes = await usos()
    await expect(armar('armar-tope', topePorClientaId)).rejects.toMatchObject({
      statusCode: 400,
      code: 'AREA_TICKET_DISCOUNT_HAS_LIMIT',
      message: 'El descuento «1 por clienta» tiene tope de usos y no se puede usar en una venta con vales: quítalo de ese producto para cobrar.',
    })
    expect(await prisma.order.count({ where: { venueId } })).toBe(0)
    const sesion = await prisma.areaTicketCheckoutSession.findUniqueOrThrow({ where: { id: caja.id }, select: { status: true, orderId: true } })
    expect(sesion).toEqual({ status: 'OPEN', orderId: null })
    expect(await usos()).toEqual(antes)

    const armada = await armar('armar-sin-tope', sinTopeId)
    expect(armada.order?.id).toBeTruthy()
  })
})
