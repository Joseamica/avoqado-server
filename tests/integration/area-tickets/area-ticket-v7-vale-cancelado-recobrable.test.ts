import { AreaTicketStatus, InventoryMethod, Prisma, StaffRole, TerminalStatus, TerminalType, Unit } from '@prisma/client'

import {
  addTicketToCheckout,
  cancelAreaTicketCheckout,
  createAreaTicketCheckout,
  issueAreaTicket,
  materializeAreaTicketCheckout,
} from '@/services/mobile/areaTicketV7.mobile.service'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import prisma from '@/utils/prismaClient'
import { encenderIvaPorProducto } from '@tests/__helpers__/iva-por-producto'

/**
 * Un vale cuyo cobro se canceló DESPUÉS de armar su cuenta se vuelve a escanear y a cobrar (QA N86, 21-oct-2026; tablero
 * hz:11d84b54:D1). Cancelar regresa el vale a ISSUED, pero el renglón de la cuenta cancelada conservaba `areaTicketLineId`
 * (único): la cuenta nueva chocaba cinco veces y el servidor contestaba 503 «No fue posible generar el código de entrega».
 */
describe('Area tickets v7 — un vale cancelado se vuelve a cobrar', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let organizationId: string
  let venueId: string
  let staffId: string
  let productId: string
  let issueDeviceUid: string
  let checkoutDeviceUid: string
  let paso = 0

  const llave = (nombre: string) => `${nombre}-${suffix}-${++paso}`

  async function emitirVale() {
    return issueAreaTicket(venueId, {
      idempotencyKey: llave('emitir'),
      deviceUid: issueDeviceUid,
      staffId,
      lines: [{ clientLineId: llave('renglon'), productId, quantity: '1' }],
    })
  }

  async function armarCuenta(codigo: string) {
    const sesion = await createAreaTicketCheckout(venueId, { idempotencyKey: llave('caja'), deviceUid: checkoutDeviceUid, staffId })
    await addTicketToCheckout(venueId, sesion.id, codigo, { idempotencyKey: llave('apartar'), deviceUid: checkoutDeviceUid, staffId })
    return materializeAreaTicketCheckout(venueId, sesion.id, {
      idempotencyKey: llave('armar'),
      deviceUid: checkoutDeviceUid,
      staffId,
      source: 'AVOQADO_ANDROID',
    })
  }

  async function cancelar(sesionId: string) {
    return cancelAreaTicketCheckout(venueId, sesionId, { idempotencyKey: llave('cancelar'), deviceUid: checkoutDeviceUid, staffId })
  }

  beforeAll(async () => {
    const organization = await prisma.organization.create({
      data: { name: `Vale cancelado ${suffix}`, email: `vale-cancelado-${suffix}@example.com`, phone: '5555555555' },
    })
    organizationId = organization.id
    const venue = await prisma.venue.create({
      data: { organizationId, name: `Vale cancelado ${suffix}`, slug: `vale-cancelado-${suffix}`, seatCapExempt: true },
    })
    venueId = venue.id
    // El producto va al 0 %, como en la prueba vecina: el negocio tiene IVA por producto encendido.
    await encenderIvaPorProducto(venueId)
    const staff = await prisma.staff.create({
      data: { email: `vale-cancelado-staff-${suffix}@example.com`, firstName: 'Vale', lastName: 'Cancelado' },
    })
    staffId = staff.id
    await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.MANAGER } })
    const area = await prisma.fulfillmentArea.create({
      data: { venueId, name: `Cocina ${suffix}`, fulfillmentMode: 'HOLD_UNTIL_PAID' },
    })
    issueDeviceUid = `emisora-${suffix}`
    checkoutDeviceUid = `caja-${suffix}`
    await prisma.terminal.createMany({
      data: [
        {
          venueId,
          name: 'Cocina',
          type: TerminalType.POS_ANDROID,
          status: TerminalStatus.ACTIVE,
          deviceUid: issueDeviceUid,
          fulfillmentAreaId: area.id,
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
    await prisma.venueAreaTicketSettings.create({ data: { venueId, enabled: true } })
    const category = await prisma.menuCategory.create({
      data: { venueId, name: 'Bebidas', slug: `bebidas-${suffix}`, availableDays: [] },
    })
    const product = await prisma.product.create({
      data: {
        venueId,
        categoryId: category.id,
        sku: `CAFE-${suffix}`,
        name: 'Café americano',
        price: new Prisma.Decimal('30.00'),
        taxRate: new Prisma.Decimal(0),
        tags: [],
        allergens: [],
        trackInventory: false,
        inventoryMethod: InventoryMethod.QUANTITY,
        unit: Unit.PIECE,
      },
    })
    productId = product.id
  })

  afterAll(async () => {
    if (!venueId) return
    await prisma.paymentAllocation.deleteMany({ where: { payment: { venueId } } })
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.areaTicketPaymentAttempt.deleteMany({ where: { checkoutSession: { venueId } } })
    await prisma.areaTicketInventoryReservation.deleteMany({ where: { venueId } })
    await prisma.orderItemModifier.deleteMany({ where: { orderItem: { order: { venueId } } } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.areaTicket.deleteMany({ where: { venueId } })
    await prisma.areaTicketCheckoutSession.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.terminal.deleteMany({ where: { venueId } })
    await prisma.fulfillmentArea.deleteMany({ where: { venueId } })
    await prisma.venueAreaTicketSettings.deleteMany({ where: { venueId } })
    await prisma.staffVenue.deleteMany({ where: { venueId } })
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.venue.delete({ where: { id: venueId } })
    if (staffId) await prisma.staff.delete({ where: { id: staffId } })
    if (organizationId) await prisma.organization.delete({ where: { id: organizationId } })
    await prisma.$disconnect()
  })

  it('cancelar con la cuenta ya armada y volver a escanear arma una cuenta nueva con el mismo vale', async () => {
    const vale = await emitirVale()
    const primera = await armarCuenta(vale.code)
    const ordenCancelada = primera.order!.id
    const renglonDelVale = (await prisma.areaTicketLine.findFirstOrThrow({ where: { areaTicketId: vale.id } })).id
    const renglonOriginal = await prisma.orderItem.findUniqueOrThrow({ where: { areaTicketLineId: renglonDelVale } })
    await cancelar(primera.id)
    expect((await prisma.areaTicket.findUniqueOrThrow({ where: { id: vale.id } })).status).toBe(AreaTicketStatus.ISSUED)

    const segunda = await armarCuenta(vale.code)

    expect(segunda.order!.id).not.toBe(ordenCancelada)
    // La cuenta nueva arma su PROPIO renglón desde el vale y toma el vínculo único.
    const dueno = await prisma.orderItem.findUniqueOrThrow({ where: { areaTicketLineId: renglonDelVale } })
    expect(dueno.orderId).toBe(segunda.order!.id)
    expect(dueno.id).not.toBe(renglonOriginal.id)
    // La cancelada conserva su renglón (producto, precio, historial), con la procedencia y sin el vínculo.
    const historico = await prisma.orderItem.findUniqueOrThrow({ where: { id: renglonOriginal.id } })
    expect(historico.orderId).toBe(ordenCancelada)
    expect(historico.areaTicketLineId).toBeNull()
    expect(historico.releasedAreaTicketLineId).toBe(renglonDelVale)
    expect((await prisma.areaTicket.findUniqueOrThrow({ where: { id: vale.id } })).orderId).toBe(segunda.order!.id)
  })

  it('la cuenta nueva se cobra en efectivo y el vale queda pagado (el recorrido de la N86)', async () => {
    const vale = await emitirVale()
    const primera = await armarCuenta(vale.code)
    await cancelar(primera.id)
    const segunda = await armarCuenta(vale.code)

    const pago = await payCashOrder(venueId, segunda.order!.id, { amount: 3000, tip: 0, staffId, idempotencyKey: llave('efectivo') })

    expect(pago.status).toBe('COMPLETED')
    const [orden, valePagado] = await Promise.all([
      prisma.order.findUniqueOrThrow({ where: { id: segunda.order!.id } }),
      prisma.areaTicket.findUniqueOrThrow({ where: { id: vale.id } }),
    ])
    expect(orden.paymentStatus).toBe('PAID')
    expect(orden.paidAmount.toFixed(2)).toBe('30.00')
    expect(valePagado.status).toBe(AreaTicketStatus.PAID)
    expect(await prisma.payment.count({ where: { orderId: primera.order!.id } })).toBe(0)
  })

  it('la cuenta nueva se arma desde el vale aunque el renglón de la cancelada se haya cambiado (cortesía, precio)', async () => {
    const vale = await emitirVale()
    const primera = await armarCuenta(vale.code)
    const renglonDelVale = (await prisma.areaTicketLine.findFirstOrThrow({ where: { areaTicketId: vale.id } })).id
    await cancelar(primera.id)
    await prisma.orderItem.update({
      where: { areaTicketLineId: renglonDelVale },
      data: { isCortesia: true, unitPrice: new Prisma.Decimal('0.00'), total: new Prisma.Decimal('0.00') },
    })

    const segunda = await armarCuenta(vale.code)

    const nuevo = await prisma.orderItem.findUniqueOrThrow({ where: { areaTicketLineId: renglonDelVale } })
    expect(nuevo.orderId).toBe(segunda.order!.id)
    expect([nuevo.isCortesia, nuevo.unitPrice.toFixed(2), nuevo.total.toFixed(2)]).toEqual([false, '30.00', '30.00'])
    expect(segunda.order!.total).toBe('30.00')
  })

  it('un vale que sigue en una cuenta viva no se roba: contesta qué cuenta lo tiene, no un 503', async () => {
    const vale = await emitirVale()
    const primera = await armarCuenta(vale.code)
    const ordenReabierta = primera.order!.id
    await cancelar(primera.id)
    // La cuenta cancelada se reabrió (p. ej. llegó dinero que la terminal ya había capturado, R12-1): su renglón no se toca.
    await prisma.order.update({ where: { id: ordenReabierta }, data: { status: 'CONFIRMED' } })

    await expect(armarCuenta(vale.code)).rejects.toMatchObject({ statusCode: 409, code: 'AREA_TICKET_LINE_IN_OTHER_ORDER' })

    const renglonDelVale = (await prisma.areaTicketLine.findFirstOrThrow({ where: { areaTicketId: vale.id } })).id
    const dueno = await prisma.orderItem.findUniqueOrThrow({ where: { areaTicketLineId: renglonDelVale } })
    expect(dueno.orderId).toBe(ordenReabierta)
  })
})
