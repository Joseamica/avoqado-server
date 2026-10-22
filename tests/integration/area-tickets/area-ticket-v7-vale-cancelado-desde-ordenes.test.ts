import {
  AreaTicketCheckoutStatus,
  AreaTicketStatus,
  InventoryMethod,
  PaymentMethod,
  Prisma,
  StaffRole,
  TerminalStatus,
  TerminalType,
  Unit,
} from '@prisma/client'

import { logAction } from '@/services/dashboard/activity-log.service'
import { deleteOrder, updateOrder } from '@/services/dashboard/order.dashboard.service'
import {
  addTicketToCheckout,
  createAreaTicketCheckout,
  issueAreaTicket,
  materializeAreaTicketCheckout,
  prepareAreaTicketPayment,
} from '@/services/mobile/areaTicketV7.mobile.service'
import { cancelOrder, payCashOrder } from '@/services/mobile/order.mobile.service'
import { OrderTableTopologyChanged } from '@/services/shared/tableOrderLock'
import { voidItems } from '@/services/tpv/order.tpv.service'
import prisma from '@/utils/prismaClient'
import { encenderIvaPorProducto } from '@tests/__helpers__/iva-por-producto'

/**
 * Cancelar una venta de vales desde «Órdenes» (la ruta GENERAL: el DELETE del POS, la terminal, la cola sin red y el panel) dejaba su
 * sesión MATERIALIZED y sus vales CLAIMED para siempre: al re-escanear, «Este vale está siendo cobrado en otra caja» (tablero
 * hz:11d84b54:D2, 21-oct-2026). Ahora la cancelación general deja los vales como el «Cancelar» del cobro de vales: libres para cobrarse.
 */
describe('Area tickets v7 — cancelar una venta de vales desde «Órdenes»', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let organizationId: string
  let venueId: string
  let staffId: string
  /** El mesero cuyo id llega en el cuerpo de «Anular»: la bitácora no lo firma (Codex r2 #2). */
  let otroStaffId: string
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

  /** La venta cancelada por la ruta general queda como la deja la ruta de vales: vale libre y sesión cancelada, con su bitácora y su autor. */
  async function esperarValeLibre(valeId: string, sesionId: string) {
    const vale = await prisma.areaTicket.findUniqueOrThrow({ where: { id: valeId } })
    expect([vale.status, vale.checkoutSessionId, vale.orderId]).toEqual([AreaTicketStatus.ISSUED, null, null])
    expect((await prisma.areaTicketCheckoutSession.findUniqueOrThrow({ where: { id: sesionId } })).status).toBe(
      AreaTicketCheckoutStatus.CANCELLED,
    )
    // La bitácora sale después del commit con `logAction` (Codex r3 #1; simulado en integración, como en las pruebas vecinas), con quién
    // dejó los vales libres para volver a cobrarse (Codex r1 #3).
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'AREA_TICKET_CHECKOUT_CANCELLED',
        entityId: sesionId,
        venueId,
        staffId,
        data: expect.objectContaining({ motivo: 'ORDEN_CANCELADA_POR_LA_RUTA_GENERAL', ticketIds: [valeId] }),
      }),
    )
  }

  /** Cuántas conexiones de esta base esperan el candado del negocio (el primer paso de `lockTableOrderScope`). */
  async function esperandoAlNegocio(): Promise<number> {
    const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FROM "Venue"%FOR KEY SHARE%'`
    return n
  }

  async function esperarHasta(condicion: () => Promise<boolean>, topeMs = 10_000) {
    const fin = Date.now() + topeMs
    while (!(await condicion())) {
      if (Date.now() > fin) throw new Error('La condición no se cumplió a tiempo')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  /** El mismo vale se vuelve a escanear, se arma otra cuenta y se cobra en efectivo. */
  async function cobrarOtraVez(codigo: string, valeId: string, ordenCancelada: string) {
    const otra = await armarCuenta(codigo)
    expect(otra.order!.id).not.toBe(ordenCancelada)
    const pago = await payCashOrder(venueId, otra.order!.id, { amount: 3000, tip: 0, staffId, idempotencyKey: llave('efectivo') })
    expect(pago.status).toBe('COMPLETED')
    expect((await prisma.areaTicket.findUniqueOrThrow({ where: { id: valeId } })).status).toBe(AreaTicketStatus.PAID)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: ordenCancelada } })).status).toBe('CANCELLED')
  }

  beforeAll(async () => {
    const organization = await prisma.organization.create({
      data: { name: `Vale desde ordenes ${suffix}`, email: `vale-ordenes-${suffix}@example.com`, phone: '5555555555' },
    })
    organizationId = organization.id
    const venue = await prisma.venue.create({
      data: { organizationId, name: `Vale desde ordenes ${suffix}`, slug: `vale-ordenes-${suffix}`, seatCapExempt: true },
    })
    venueId = venue.id
    await encenderIvaPorProducto(venueId)
    const staff = await prisma.staff.create({
      data: { email: `vale-ordenes-staff-${suffix}@example.com`, firstName: 'Vale', lastName: 'Ordenes' },
    })
    staffId = staff.id
    await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.MANAGER } })
    const otro = await prisma.staff.create({
      data: { email: `vale-ordenes-otro-${suffix}@example.com`, firstName: 'Otro', lastName: 'Mesero' },
    })
    otroStaffId = otro.id
    await prisma.staffVenue.create({ data: { staffId: otroStaffId, venueId, role: StaffRole.WAITER } })
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
    await prisma.table.deleteMany({ where: { venueId } })
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.terminal.deleteMany({ where: { venueId } })
    await prisma.fulfillmentArea.deleteMany({ where: { venueId } })
    await prisma.venueAreaTicketSettings.deleteMany({ where: { venueId } })
    await prisma.staffVenue.deleteMany({ where: { venueId } })
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.venue.delete({ where: { id: venueId } })
    if (staffId) await prisma.staff.delete({ where: { id: staffId } })
    if (otroStaffId) await prisma.staff.delete({ where: { id: otroStaffId } })
    if (organizationId) await prisma.organization.delete({ where: { id: organizationId } })
    await prisma.$disconnect()
  })

  it('POS, terminal y cola sin red (`cancelOrder`): el vale queda libre y se vuelve a cobrar', async () => {
    const vale = await emitirVale()
    const armada = await armarCuenta(vale.code)

    await cancelOrder(venueId, armada.order!.id, 'el cliente se fue', staffId)

    await esperarValeLibre(vale.id, armada.id)
    await cobrarOtraVez(vale.code, vale.id, armada.order!.id)
  })

  it('panel, «Eliminar orden» (`deleteOrder`): el vale queda libre y se vuelve a cobrar', async () => {
    const vale = await emitirVale()
    const armada = await armarCuenta(vale.code)

    await deleteOrder(venueId, armada.order!.id, staffId)

    await esperarValeLibre(vale.id, armada.id)
    await cobrarOtraVez(vale.code, vale.id, armada.order!.id)
  })

  it('panel, editar la orden a «Cancelada» (`updateOrder`): el vale queda libre y se vuelve a cobrar', async () => {
    const vale = await emitirVale()
    const armada = await armarCuenta(vale.code)

    await updateOrder(venueId, armada.order!.id, { status: 'CANCELLED' } as any, { staffId })

    await esperarValeLibre(vale.id, armada.id)
    await cobrarOtraVez(vale.code, vale.id, armada.order!.id)
  })

  it('terminal, «Anular» todos los artículos (`voidItems`, Codex r1 #2): el vale queda libre y se vuelve a cobrar', async () => {
    const vale = await emitirVale()
    const armada = await armarCuenta(vale.code)
    const orden = await prisma.order.findUniqueOrThrow({ where: { id: armada.order!.id }, include: { items: { select: { id: true } } } })

    // Codex r2 #2: el `staffId` llega en el cuerpo de la petición; la bitácora de los vales la firma quien está autenticado (`actorId`).
    await voidItems(venueId, orden.id, {
      itemIds: orden.items.map(item => item.id),
      reason: 'el cliente se fue',
      staffId: otroStaffId,
      expectedVersion: orden.version,
      actorId: staffId,
    })

    await esperarValeLibre(vale.id, armada.id)
    await cobrarOtraVez(vale.code, vale.id, orden.id)
  })

  it('dos ventas de vales en la misma mesa se cancelan a la vez sin trabarse entre sí (Codex r1 #1)', async () => {
    const [valeA, valeB] = [await emitirVale(), await emitirVale()]
    const [ventaA, ventaB] = [await armarCuenta(valeA.code), await armarCuenta(valeB.code)]
    // El panel puede pasar una venta a una mesa; dos ventas de vales en la misma mesa son hermanas para `lockTableOrderScope`.
    const mesa = await prisma.table.create({ data: { venueId, number: `M-${suffix}`, capacity: 4, qrCode: `qr-vales-${suffix}` } })
    await prisma.order.updateMany({ where: { id: { in: [ventaA.order!.id, ventaB.order!.id] } }, data: { tableId: mesa.id } })

    const cancelar = (orderId: string) => cancelOrder(venueId, orderId, 'a la vez', staffId)
    let cancelaciones!: Promise<PromiseSettledResult<void>[]>
    // El negocio bloqueado detiene a las dos cancelaciones justo antes del candado de las cuentas de la mesa. Si cada una ya tuviera
    // SU cuenta tomada (el candado anticipado de la ronda 1), al soltarse se esperarían entre sí y Postgres abortaría una (40P01).
    // Codex r2 #3: no se suelta hasta ver a las DOS esperando ese candado (si no, podrían correr una tras otra y pasar por suerte).
    await prisma.$transaction(
      async bloqueo => {
        await bloqueo.$queryRaw`SELECT id FROM "Venue" WHERE id = ${venueId} FOR UPDATE`
        cancelaciones = Promise.allSettled([cancelar(ventaA.order!.id), cancelar(ventaB.order!.id)])
        await esperarHasta(async () => (await esperandoAlNegocio()) === 2)
      },
      { timeout: 20_000 },
    )
    const resultados = await cancelaciones

    // La que pierde la carrera puede ver la mesa cambiada (409 de topología, transitorio de siempre: la app reintenta); nunca un
    // interbloqueo.
    for (const [i, resultado] of resultados.entries()) {
      if (resultado.status === 'rejected') {
        const motivo = resultado.reason instanceof OrderTableTopologyChanged ? 'topología' : String(resultado.reason?.message)
        expect(motivo).toBe('topología')
        await cancelar([ventaA, ventaB][i].order!.id)
      }
    }
    await esperarValeLibre(valeA.id, ventaA.id)
    await esperarValeLibre(valeB.id, ventaB.id)
  })

  it('si otra caja tiene la venta de vales tomada, cancelar NO espera: 409 reintentable al instante y nada cambia (Codex r2 #1)', async () => {
    const vale = await emitirVale()
    const armada = await armarCuenta(vale.code)
    // Cualquier operación de vales (cobro, armado, liquidación) toma la sesión ANTES que la cuenta. Si la cancelación esperara la sesión
    // con la cuenta ya tomada, se cruzaría con ella; por eso no espera. Con 3 s de tope: una cancelación que espera NO falla, se queda.
    let cancelacion!: Promise<unknown>
    let resultado: unknown
    await prisma.$transaction(
      async otraCaja => {
        await otraCaja.$queryRaw`SELECT id FROM "AreaTicketCheckoutSession" WHERE id = ${armada.id} FOR UPDATE`
        cancelacion = cancelOrder(venueId, armada.order!.id, 'el cliente se fue', staffId).then(
          () => 'CANCELADA',
          error => error,
        )
        resultado = await Promise.race([cancelacion, new Promise(resolve => setTimeout(() => resolve('SE QUEDÓ ESPERANDO'), 3_000))])
      },
      { timeout: 20_000 },
    )
    await cancelacion

    expect(resultado).toMatchObject({ statusCode: 409, code: 'VERSION_CONFLICT' })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: armada.order!.id } })).status).not.toBe('CANCELLED')
    expect((await prisma.areaTicket.findUniqueOrThrow({ where: { id: vale.id } })).status).toBe(AreaTicketStatus.CLAIMED)
    // Ya sin la otra caja, la misma cancelación pasa.
    await cancelOrder(venueId, armada.order!.id, 'el cliente se fue', staffId)
    await esperarValeLibre(vale.id, armada.id)
  })

  it('cancelar no espera al empleado: la bitácora de los vales se escribe después del commit (Codex r3 #1)', async () => {
    const vale = await emitirVale()
    const armada = await armarCuenta(vale.code)
    let cancelacion!: Promise<unknown>
    let resultado: unknown
    // Como el borrado de un empleado (superadmin): su fila tomada. Una bitácora DENTRO de la transacción revisa la liga al empleado con un
    // candado implícito que sí espera, y podía cruzarse con ese borrado.
    await prisma.$transaction(
      async borrado => {
        await borrado.$queryRaw`SELECT id FROM "Staff" WHERE id = ${staffId} FOR UPDATE`
        cancelacion = cancelOrder(venueId, armada.order!.id, 'el cliente se fue', staffId).then(
          () => 'CANCELADA',
          error => error,
        )
        resultado = await Promise.race([cancelacion, new Promise(resolve => setTimeout(() => resolve('SE QUEDÓ ESPERANDO'), 3_000))])
      },
      { timeout: 20_000 },
    )
    await cancelacion

    expect(resultado).toBe('CANCELADA')
    await esperarValeLibre(vale.id, armada.id)
  })

  it('con un cobro de vales en camino la cancelación se niega como en la ruta de vales, y nada cambia', async () => {
    const vale = await emitirVale()
    const armada = await armarCuenta(vale.code)
    await prepareAreaTicketPayment(venueId, armada.id, {
      idempotencyKey: llave('preparar'),
      deviceUid: checkoutDeviceUid,
      staffId,
      amount: '30.00',
      method: PaymentMethod.CREDIT_CARD,
    })

    await expect(cancelOrder(venueId, armada.order!.id, 'el cliente se fue', staffId)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CHECKOUT_HAS_PAYMENT',
    })

    expect((await prisma.order.findUniqueOrThrow({ where: { id: armada.order!.id } })).status).not.toBe('CANCELLED')
    expect((await prisma.areaTicket.findUniqueOrThrow({ where: { id: vale.id } })).status).toBe(AreaTicketStatus.CLAIMED)
    expect((await prisma.areaTicketCheckoutSession.findUniqueOrThrow({ where: { id: armada.id } })).status).toBe(
      AreaTicketCheckoutStatus.PAYMENT_PENDING,
    )
  })
})
