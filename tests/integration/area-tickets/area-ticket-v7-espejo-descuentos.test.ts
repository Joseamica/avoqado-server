import { DiscountScope, DiscountType, Prisma, StaffRole, TerminalStatus, TerminalType } from '@prisma/client'

import { getDiscountStats } from '@/services/dashboard/discount.dashboard.service'
import {
  applyDiscountToOrder,
  getCustomerDiscounts,
  getEligibleDiscounts,
  removeDiscountFromOrder,
} from '@/services/dashboard/discountEngine.service'
import { listarDescuentosAplicados } from '@/services/dashboard/descuentosAplicados.service'
import { listarMisDescuentos } from '@/services/public/customerPortal.public.service'
import { getAvailableDiscounts } from '@/services/tpv/discount.tpv.service'
import {
  addTicketToCheckout,
  cancelAreaTicketCheckout,
  createAreaTicketCheckout,
  issueAreaTicket,
  materializeAreaTicketCheckout,
} from '@/services/mobile/areaTicketV7.mobile.service'
import { getOrder as getOrderDelPos } from '@/services/mobile/order.mobile.service'
import { getOrder as getOrderDeLaTpv } from '@/services/tpv/order.tpv.service'
import prisma from '@/utils/prismaClient'
import { encenderIvaPorProducto } from '@tests/__helpers__/iva-por-producto'

/**
 * Tarjeta hz:nube0000:na24531d (17-nov-2026), el recorrido real contra Postgres: emitir un vale con descuento de producto →
 * reclamarlo en la caja → cobrar con un producto suelto con descuento y motivo. Antes la venta nacía con el descuento en sus renglones
 * y SIN filas `OrderDiscount`: «Descuentos» del DASHBOARD y las estadísticas no lo veían. Ahora cada renglón con descuento gana su fila
 * ESPEJO marcada (`deValeV7`) en la misma transacción; repetir el cobro con la misma llave no la duplica, cancelar la venta la saca del
 * reporte, y (fase 1, v5.1) los usos del descuento quedan exactamente como antes: ni el contador, ni los topes por cliente, ni «ya aplicado»
 * cuentan estas filas.
 */
describe('Vales V7 — los descuentos del cobro salen en «Descuentos» (fila espejo)', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let organizationId: string
  let venueId: string
  let staffId: string
  let staffVenueId: string
  let customerId: string
  let jamonId: string
  let papasId: string
  let d10Id: string
  let dGerenteId: string
  const issueDeviceUid = `espejo-issue-${suffix}`
  const checkoutDeviceUid = `espejo-caja-${suffix}`

  beforeAll(async () => {
    const organization = await prisma.organization.create({
      data: { name: `Vales espejo ${suffix}`, email: `vales-espejo-${suffix}@example.com`, phone: '5555555555' },
    })
    organizationId = organization.id
    const venue = await prisma.venue.create({
      data: { organizationId, name: `Vales espejo ${suffix}`, slug: `vales-espejo-${suffix}`, seatCapExempt: true },
    })
    venueId = venue.id
    // Los productos de prueba van al 0 % de IVA (el recorrido no mide impuestos): el negocio tiene «IVA por producto» encendido.
    await encenderIvaPorProducto(venueId)
    const staff = await prisma.staff.create({
      data: { email: `vales-espejo-staff-${suffix}@example.com`, firstName: 'Área', lastName: 'Cremería' },
    })
    staffId = staff.id
    staffVenueId = (await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.MANAGER } })).id
    customerId = (await prisma.customer.create({ data: { venueId, firstName: 'Clienta', lastName: 'Frecuente' } })).id

    const area = await prisma.fulfillmentArea.create({
      data: { venueId, name: `Cremería ${suffix}`, fulfillmentMode: 'HOLD_UNTIL_PAID' },
    })
    await prisma.terminal.createMany({
      data: [
        {
          venueId,
          name: 'Cremería',
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
      data: { venueId, name: 'Abarrotes', slug: `abarrotes-${suffix}`, availableDays: [] },
    })
    const producto = (name: string, price: string) =>
      prisma.product.create({
        data: {
          venueId,
          categoryId: category.id,
          sku: `${name.toUpperCase()}-${suffix}`,
          name,
          price: new Prisma.Decimal(price),
          taxRate: new Prisma.Decimal(0),
          tags: [],
          allergens: [],
        },
      })
    jamonId = (await producto('Jamon', '100.00')).id
    papasId = (await producto('Papas', '50.00')).id

    d10Id = (
      await prisma.discount.create({
        data: { venueId, name: '10 % producto', type: DiscountType.PERCENTAGE, value: new Prisma.Decimal(10), scope: DiscountScope.ITEM },
      })
    ).id
    dGerenteId = (
      await prisma.discount.create({
        data: {
          venueId,
          name: '20 % con aprobación',
          type: DiscountType.PERCENTAGE,
          value: new Prisma.Decimal(20),
          scope: DiscountScope.ITEM,
          requiresApproval: true,
        },
      })
    ).id
  })

  afterAll(async () => {
    if (!venueId) return
    await prisma.areaTicketPaymentAttempt.deleteMany({ where: { checkoutSession: { venueId } } })
    await prisma.orderDiscount.deleteMany({ where: { order: { venueId } } })
    await prisma.orderItemModifier.deleteMany({ where: { orderItem: { order: { venueId } } } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.areaTicket.deleteMany({ where: { venueId } })
    await prisma.areaTicketCheckoutSession.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.customerDiscount.deleteMany({ where: { customer: { venueId } } })
    await prisma.discount.deleteMany({ where: { venueId } })
    await prisma.customer.deleteMany({ where: { venueId } })
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

  it('vale con 10 % y 20 % con aprobación + suelto con motivo ⇒ filas espejo marcadas; usos como antes; repetir no duplica; cancelar la saca', async () => {
    const vale = await issueAreaTicket(venueId, {
      idempotencyKey: `espejo-vale-${suffix}`,
      deviceUid: issueDeviceUid,
      staffId,
      performedBy: staffId,
      // La sesión del área tiene `tpv-orders:discount`: así aprueba el de «Requiere aprobación» (en vales no hay PIN).
      aprobacionDelDescuento: {},
      lines: [
        { clientLineId: `jamon-${suffix}`, productId: jamonId, quantity: '1', discountId: d10Id },
        { clientLineId: `jamon2-${suffix}`, productId: jamonId, quantity: '1', discountId: dGerenteId },
        { clientLineId: `jamon3-${suffix}`, productId: jamonId, quantity: '1', discountId: d10Id },
      ],
    })
    expect(vale.discountAmount).toBe('40.00')
    // Emitir no crea venta ni filas.
    expect(await prisma.orderDiscount.count({ where: { order: { venueId } } })).toBe(0)

    const caja = await createAreaTicketCheckout(venueId, {
      idempotencyKey: `espejo-caja-${suffix}`,
      deviceUid: checkoutDeviceUid,
      staffId,
    })
    await addTicketToCheckout(venueId, caja.id, vale.code, {
      idempotencyKey: `espejo-claim-${suffix}`,
      deviceUid: checkoutDeviceUid,
      staffId,
    })
    const cobro = {
      idempotencyKey: `espejo-materializar-${suffix}`,
      deviceUid: checkoutDeviceUid,
      staffId,
      performedBy: staffId,
      source: 'AVOQADO_ANDROID' as const,
      normalItems: [{ productId: papasId, quantity: 1, discountId: d10Id, discountReason: 'Cliente frecuente' }],
    }
    const materializada = await materializeAreaTicketCheckout(venueId, caja.id, cobro)
    const orderId = materializada.order!.id

    const orden = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { discountAmount: true, total: true } })
    expect(orden.discountAmount.toFixed(2)).toBe('45.00') // 10 + 20 + 10 del vale + 5 de las papas
    expect(orden.total.toFixed(2)).toBe('305.00')

    const filas = await prisma.orderDiscount.findMany({
      where: { orderId },
      orderBy: [{ amount: 'asc' }, { id: 'asc' }],
      take: 10,
    })
    const renglones = await prisma.orderItem.findMany({
      where: { orderId },
      select: { id: true, productId: true, discountAmount: true, appliedDiscountId: true },
      take: 10,
    })
    // Una fila por descuento, área y emisor del vale (los dos jamones al 10 % van en una), más la del suelto.
    expect(filas).toHaveLength(3)
    // Σ filas = el descuento de la venta, al centavo.
    expect(filas.reduce((s, f) => s.add(f.amount), new Prisma.Decimal(0)).toFixed(2)).toBe('45.00')
    for (const fila of filas) {
      expect(fila.reparto).toMatchObject({ espejo: true, alcance: 'DIRIGIDO', deValeV7: true })
      const reparto = (fila.reparto as { renglones: Record<string, number> }).renglones
      expect(Object.keys(reparto).sort()).toEqual([...fila.appliedToItemIds].sort())
      // Cada renglón de la fila trae su descuento y el reparto dice exactamente lo suyo.
      let suma = 0
      for (const id of fila.appliedToItemIds) {
        const renglon = renglones.find(r => r.id === id)!
        expect(renglon.appliedDiscountId).toBe(fila.discountId)
        expect(Math.round(renglon.discountAmount.toNumber() * 100)).toBe(reparto[id])
        suma += reparto[id]
      }
      expect(suma).toBe(Math.round(fila.amount.toNumber() * 100))
      expect(fila.appliedById).toBe(staffVenueId)
    }
    const papasRenglon = renglones.find(r => r.productId === papasId)!
    const papas = filas.find(f => f.appliedToItemIds.includes(papasRenglon.id))!
    const d10Vale = filas.find(f => f.discountId === d10Id && f !== papas)!
    const gerente = filas.find(f => f.discountId === dGerenteId)!
    expect(d10Vale.appliedToItemIds).toHaveLength(2)
    expect(d10Vale.amount.toFixed(2)).toBe('20.00')
    expect(d10Vale.type).toBe('PERCENTAGE')
    expect(papas).toMatchObject({ discountId: d10Id, reason: 'Cliente frecuente', authorizedById: null })
    expect(d10Vale).toMatchObject({ discountId: d10Id, reason: null, authorizedById: null })
    // D4 (18-nov): quién aprobó en el área se congela al emitir (la sesión con permiso propio) y la fila lo copia.
    expect(gerente).toMatchObject({ discountId: dGerenteId, reason: null, authorizedById: staffVenueId })

    // Usos como antes del arreglo: el cobro de vales no sube el contador.
    const usos = await prisma.discount.findMany({ where: { venueId }, select: { currentUses: true }, take: 10 })
    expect(usos.map(u => u.currentUses)).toEqual([0, 0])

    // Sale en «Descuentos» (DASHBOARD y MCP) y en las estadísticas.
    const reporte = await listarDescuentosAplicados(venueId)
    expect(reporte.totales).toEqual({ count: 3, amount: 45 })
    const stats = await getDiscountStats(venueId)
    expect(stats.totalSaved).toBe(45)

    // Los topes por cliente no cuentan las filas marcadas: con la clienta ligada y «1 por cliente», el 10 % sigue disponible para
    // ella en el motor, en su asignación y en su portal (antes del arreglo esta venta no tenía filas: daba 0 usos; sigue en 0).
    await prisma.order.update({ where: { id: orderId }, data: { customerId } })
    await prisma.discount.update({ where: { id: d10Id }, data: { maxUsesPerCustomer: 1 } })
    await prisma.customerDiscount.create({ data: { customerId, discountId: d10Id } })
    expect((await getEligibleDiscounts(venueId, customerId)).map(d => d.id)).toContain(d10Id)
    expect((await getCustomerDiscounts(venueId, customerId)).map(d => d.id)).toContain(d10Id)
    expect((await listarMisDescuentos(venueId, customerId, {})).items.map(d => d.nombre)).toContain('10 % producto')

    // «Ya aplicado» tampoco las cuenta: la TPV sigue ofreciendo el 10 % en esta cuenta, como antes del arreglo.
    expect((await getAvailableDiscounts(venueId, orderId)).map(d => d.id)).toContain(d10Id)

    // Quitar desde la TPV el descuento de un producto de la venta de vales: 400, y la venta queda igual (Codex r1 #1-#2, r2 #1).
    await expect(removeDiscountFromOrder(orderId, d10Vale.id, staffId, venueId)).rejects.toMatchObject({
      statusCode: 400,
      code: 'AREA_TICKET_DISCOUNT_FROZEN',
    })
    const intacta = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { discountAmount: true, total: true } })
    expect([intacta.discountAmount.toFixed(2), intacta.total.toFixed(2)]).toEqual(['45.00', '305.00'])
    expect(await prisma.orderDiscount.count({ where: { orderId } })).toBe(3)

    // La misma llave otra vez: la misma venta, ninguna fila nueva.
    const otraVez = await materializeAreaTicketCheckout(venueId, caja.id, cobro)
    expect(otraVez.order!.id).toBe(orderId)
    expect(await prisma.orderDiscount.count({ where: { order: { venueId } } })).toBe(3)

    // Cancelar la venta la saca del reporte (las filas se quedan con su venta cancelada).
    await cancelAreaTicketCheckout(venueId, caja.id, {
      idempotencyKey: `espejo-cancelar-${suffix}`,
      deviceUid: checkoutDeviceUid,
      staffId,
    })
    expect((await listarDescuentosAplicados(venueId)).totales).toEqual({ count: 0, amount: 0 })
    expect(
      (await prisma.discount.findMany({ where: { venueId }, select: { currentUses: true }, take: 10 })).map(u => u.currentUses),
    ).toEqual([0, 0])
  })

  // D4 (tarjeta hz:e82938e1:D4, 18-nov): el motivo y quién aprobó llegan desde la tablet. El renglón del vale los congela al emitir y la
  // fila espejo los copia al cobrar, agrupando también por ellos; un renglón sin motivo sale como antes («Sin motivo»).
  it('D4: el motivo, su comentario y quien aprobó se congelan en el vale y llegan a «Descuentos»', async () => {
    const vale = await issueAreaTicket(venueId, {
      idempotencyKey: `d4-vale-${suffix}`,
      deviceUid: issueDeviceUid,
      staffId,
      performedBy: staffId,
      aprobacionDelDescuento: {},
      lines: [
        {
          clientLineId: `d4-a-${suffix}`,
          productId: jamonId,
          quantity: '1',
          discountId: d10Id,
          discountReason: '  Cliente   frecuente ',
          discountReasonComment: 'Viene diario',
        },
        { clientLineId: `d4-b-${suffix}`, productId: jamonId, quantity: '1', discountId: d10Id },
        { clientLineId: `d4-c-${suffix}`, productId: jamonId, quantity: '1', discountId: dGerenteId, discountReason: 'Producto dañado' },
        { clientLineId: `d4-d-${suffix}`, productId: papasId, quantity: '1', discountReason: 'Sin descuento no se guarda' },
      ] as any,
    })
    const lineas = await prisma.areaTicketLine.findMany({
      where: { areaTicket: { code: vale.code, venueId } },
      select: { clientLineId: true, discountReason: true, discountReasonComment: true, discountAuthorizedById: true },
      take: 10,
    })
    const linea = (id: string) => lineas.find(l => l.clientLineId === `${id}-${suffix}`)!
    expect(linea('d4-a')).toMatchObject({
      discountReason: 'Cliente frecuente',
      discountReasonComment: 'Viene diario',
      discountAuthorizedById: null,
    })
    expect(linea('d4-b')).toMatchObject({ discountReason: null, discountReasonComment: null, discountAuthorizedById: null })
    expect(linea('d4-c')).toMatchObject({ discountReason: 'Producto dañado', discountAuthorizedById: staffVenueId })
    expect(linea('d4-d')).toMatchObject({ discountReason: null, discountReasonComment: null, discountAuthorizedById: null })

    // La misma llave otra vez: el mismo vale, sin renglones nuevos.
    const otraVez = await issueAreaTicket(venueId, {
      idempotencyKey: `d4-vale-${suffix}`,
      deviceUid: issueDeviceUid,
      staffId,
      performedBy: staffId,
      aprobacionDelDescuento: {},
      lines: [
        { clientLineId: `d4-a-${suffix}`, productId: jamonId, quantity: '1', discountId: d10Id },
        { clientLineId: `d4-b-${suffix}`, productId: jamonId, quantity: '1', discountId: d10Id },
        { clientLineId: `d4-c-${suffix}`, productId: jamonId, quantity: '1', discountId: dGerenteId },
        { clientLineId: `d4-d-${suffix}`, productId: papasId, quantity: '1' },
      ],
    })
    expect(otraVez.code).toBe(vale.code)
    expect(await prisma.areaTicketLine.count({ where: { areaTicket: { code: vale.code, venueId } } })).toBe(4)

    const caja = await createAreaTicketCheckout(venueId, { idempotencyKey: `d4-caja-${suffix}`, deviceUid: checkoutDeviceUid, staffId })
    await addTicketToCheckout(venueId, caja.id, vale.code, { idempotencyKey: `d4-claim-${suffix}`, deviceUid: checkoutDeviceUid, staffId })
    const materializada = await materializeAreaTicketCheckout(venueId, caja.id, {
      idempotencyKey: `d4-materializar-${suffix}`,
      deviceUid: checkoutDeviceUid,
      staffId,
      performedBy: staffId,
      source: 'AVOQADO_ANDROID' as const,
      normalItems: [{ productId: papasId, quantity: 1, discountId: d10Id, discountReason: 'Cliente frecuente' }],
    })
    const orderId = materializada.order!.id

    const filas = await prisma.orderDiscount.findMany({
      where: { orderId },
      select: {
        discountId: true,
        amount: true,
        reason: true,
        reasonComment: true,
        authorizedById: true,
        appliedById: true,
        appliedToItemIds: true,
      },
      orderBy: [{ amount: 'asc' }, { id: 'asc' }],
      take: 10,
    })
    // Vale: 10 % con motivo y comentario · 10 % sin motivo · 20 % aprobado con motivo. Más el suelto con motivo.
    expect(filas).toHaveLength(4)
    expect(filas.reduce((s, f) => s.add(f.amount), new Prisma.Decimal(0)).toFixed(2)).toBe('45.00')
    const conComentario = filas.find(f => f.reasonComment === 'Viene diario')!
    expect(conComentario).toMatchObject({ discountId: d10Id, reason: 'Cliente frecuente', authorizedById: null, appliedById: staffVenueId })
    expect(conComentario.appliedToItemIds).toHaveLength(1)
    const sinMotivo = filas.filter(f => f.reason === null)
    expect(sinMotivo).toHaveLength(1)
    expect(sinMotivo[0]).toMatchObject({ discountId: d10Id, authorizedById: null })
    expect(filas.find(f => f.discountId === dGerenteId)).toMatchObject({
      reason: 'Producto dañado',
      reasonComment: null,
      authorizedById: staffVenueId,
      appliedById: staffVenueId,
    })
    expect(filas.filter(f => f.reason === 'Cliente frecuente' && f.reasonComment === null)).toHaveLength(1) // el suelto

    // «Descuentos» del DASHBOARD (y el MCP) agrupa por el motivo que llegó desde la tablet.
    const reporte = await listarDescuentosAplicados(venueId)
    const motivos = Object.fromEntries(reporte.porMotivo.map(g => [g.reason ?? 'SIN_MOTIVO', g.amount]))
    expect(motivos).toMatchObject({ 'Cliente frecuente': 15, 'Producto dañado': 20, SIN_MOTIVO: 10 })
  })

  // D4 (Codex r1-r4): quien aprobó es una foto del id de su membresía, sin llave foránea. Si la borran para siempre entre emitir y
  // cobrar, el cobro sigue y la fila va sin aprobador (como `OrderDiscount`, que la deja en NULL), dada por el emisor del vale.
  it('D4: si borran la membresía de quien aprobó antes de cobrar, el cobro sigue y la fila va sin aprobador', async () => {
    const otra = await prisma.staff.create({
      data: { email: `vales-espejo-gerente-${suffix}@example.com`, firstName: 'Gerente', lastName: 'Temporal' },
    })
    const membresia = await prisma.staffVenue.create({ data: { staffId: otra.id, venueId, role: StaffRole.MANAGER } })
    const vale = await issueAreaTicket(venueId, {
      idempotencyKey: `d4-borrada-${suffix}`,
      deviceUid: issueDeviceUid,
      staffId,
      performedBy: otra.id,
      aprobacionDelDescuento: {},
      lines: [{ clientLineId: `d4-borrada-${suffix}`, productId: jamonId, quantity: '1', discountId: dGerenteId }],
    })
    expect(
      (await prisma.areaTicketLine.findFirstOrThrow({ where: { areaTicket: { code: vale.code, venueId } } })).discountAuthorizedById,
    ).toBe(membresia.id)
    await prisma.staffVenue.delete({ where: { id: membresia.id } })

    const caja = await createAreaTicketCheckout(venueId, {
      idempotencyKey: `d4-borrada-caja-${suffix}`,
      deviceUid: checkoutDeviceUid,
      staffId,
    })
    await addTicketToCheckout(venueId, caja.id, vale.code, {
      idempotencyKey: `d4-borrada-claim-${suffix}`,
      deviceUid: checkoutDeviceUid,
      staffId,
    })
    const materializada = await materializeAreaTicketCheckout(venueId, caja.id, {
      idempotencyKey: `d4-borrada-materializar-${suffix}`,
      deviceUid: checkoutDeviceUid,
      staffId,
      performedBy: staffId,
      source: 'AVOQADO_ANDROID' as const,
    })
    const filas = await prisma.orderDiscount.findMany({ where: { orderId: materializada.order!.id }, take: 5 })
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({ discountId: dGerenteId, authorizedById: null, appliedById: staffVenueId })
    expect(filas[0].amount.toFixed(2)).toBe('20.00')
    await prisma.staff.delete({ where: { id: otra.id } })
  })

  // D15 (pizarrón hz:e82938e1:D15, 18-nov): Mesas de la TPV y de ANDROID/WINDOWS pintan en gris el «Quitar» de la rebaja fija. El
  // detalle de la cuenta de las dos cajas dice cuál es (`congeladoPorVales`), con la misma marca del candado; una rebaja que la caja da
  // después no la lleva. El `reparto` no viaja.
  it('D15: el detalle de la cuenta del POS y de la TPV marca congeladoPorVales sólo en las rebajas fijas del cobro de vales', async () => {
    const vale = await issueAreaTicket(venueId, {
      idempotencyKey: `d15-vale-${suffix}`,
      deviceUid: issueDeviceUid,
      staffId,
      performedBy: staffId,
      lines: [{ clientLineId: `d15-jamon-${suffix}`, productId: jamonId, quantity: '1', discountId: d10Id }],
    })
    const caja = await createAreaTicketCheckout(venueId, { idempotencyKey: `d15-caja-${suffix}`, deviceUid: checkoutDeviceUid, staffId })
    await addTicketToCheckout(venueId, caja.id, vale.code, { idempotencyKey: `d15-claim-${suffix}`, deviceUid: checkoutDeviceUid, staffId })
    const materializada = await materializeAreaTicketCheckout(venueId, caja.id, {
      idempotencyKey: `d15-materializar-${suffix}`,
      deviceUid: checkoutDeviceUid,
      staffId,
      performedBy: staffId,
      source: 'AVOQADO_ANDROID' as const,
      normalItems: [{ productId: papasId, quantity: 1, discountId: d10Id }],
    })
    const orderId = materializada.order!.id
    // Codex r4 #3: una rebaja de CUENTA del catálogo que la caja da después, por el camino real (el motor de la TPV), sin la marca.
    const delCatalogo = await prisma.discount.create({
      data: { venueId, name: 'Cliente frecuente D15', type: DiscountType.FIXED_AMOUNT, value: new Prisma.Decimal(1), scope: DiscountScope.ORDER },
    })
    await applyDiscountToOrder(orderId, delCatalogo.id, staffVenueId, undefined, venueId)
    const deCuenta = await prisma.orderDiscount.findFirstOrThrow({ where: { orderId, discountId: delCatalogo.id } })

    const delPos = await getOrderDelPos(venueId, orderId)
    const marcasPos = Object.fromEntries(delPos.discounts.map(d => [d.id, d.congeladoPorVales]))
    expect(Object.values(marcasPos).filter(Boolean)).toHaveLength(2) // la del vale y la del suelto
    expect(marcasPos[deCuenta.id]).toBe(false)

    const deLaTpv: any = await getOrderDeLaTpv(venueId, orderId)
    const marcasTpv = Object.fromEntries(deLaTpv.orderDiscounts.map((d: any) => [d.id, d.congeladoPorVales]))
    expect(marcasTpv).toEqual(marcasPos)
    expect(deLaTpv.orderDiscounts.every((d: any) => !('reparto' in d))).toBe(true)

    // La rebaja normal se quita como hoy y las dos fijas siguen ahí, marcadas.
    await removeDiscountFromOrder(orderId, deCuenta.id, staffId, venueId)
    const despues = await getOrderDelPos(venueId, orderId)
    expect(despues.discounts.map(d => d.congeladoPorVales)).toEqual([true, true])
  })
})
