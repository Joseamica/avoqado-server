/**
 * hz:e82938e1:D36 · la limpieza de ventas de Cobrar abandonadas contra Postgres REAL (decisión del founder «A con ensayo»).
 *
 * Una venta de Cobrar que cumple TODO (TPV, para llevar, sin mesa, pendiente, con productos, sin cliente, sin cobros ni solicitudes
 * del POS, quieta hace más de 24 h) se ANULA con su bitácora; con cliente, con un pago, con una solicitud del POS, de menos de 24 h
 * o en ENSAYO, se queda como está.
 *
 * Correr (base desechable; nunca av-db-25):
 *   TEST_DATABASE_URL='postgresql://…/avoqado_d36_test_20261120' \
 *   npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/jobs/ventas-cobrar-abandonadas.integration.test.ts
 */
import '../../__helpers__/integration-setup'
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import {
  anularVentaDeCobrarAbandonada,
  CAMINO_LIMPIEZA_COBRAR,
  type Candidata,
  VentasCobrarAbandonadasJob,
} from '@/jobs/ventas-cobrar-abandonadas.job'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import { getOrders } from '@/services/tpv/order.tpv.service'
import { onOrderCancelled } from '@/services/referrals/referralRefund.service'
import { socketManager } from '@/communication/sockets/managers/socketManager'

// El cobro tardío de la cola (efectivo) registra su dinero de verdad; sólo se apagan la caja y la cola de mensajes, que no son de esta prueba.
jest.mock('@/services/shared/cashDrawerPosting', () => ({ postCashSaleToDrawer: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))
// Codex r2 #2: la limpieza ya no manda referidos a VOID después de anular. El efecto real corre igual; sólo se mira si se llamó.
jest.mock('@/services/referrals/referralRefund.service', () => {
  const real = jest.requireActual('@/services/referrals/referralRefund.service')
  return { ...real, onOrderCancelled: jest.fn(real.onOrderCancelled) }
})

// Anula ventas reales: sólo corre en una base de prueba local y desechable.
const url = new URL(process.env.TEST_DATABASE_URL ?? '')
if (
  !['localhost', '127.0.0.1'].includes(url.hostname) ||
  !/^\/(codex_testarudo_test_|avoqado_(?:[a-z0-9]+|cambio_r5)_test_)/.test(url.pathname)
) {
  throw new Error('Exige una base de prueba local y desechable (p. ej. avoqado_d36_test_20261120).')
}

const HACE_DOS_DIAS = () => new Date(Date.now() - 48 * 60 * 60 * 1000)
const HACE_UNA_HORA = () => new Date(Date.now() - 60 * 60 * 1000)

let organizationId: string
let venueId: string
let staffId: string

async function venta(
  clave: string,
  extra: Partial<{
    customerId: string
    createdAt: Date
    updatedAt: Date
    sinProductos: boolean
    source: 'TPV' | 'KIOSK'
    /** Por omisión, la llave de Cobrar (UUID); `null` = sin llave. */
    externalId: string | null
    reservationId: string
  }> = {},
) {
  const creada = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `D36-${clave}-${Date.now()}`,
      type: 'TAKEOUT',
      source: extra.source ?? 'TPV',
      status: 'PENDING',
      paymentStatus: 'PENDING',
      customerId: extra.customerId ?? null,
      externalId: extra.externalId === undefined ? randomUUID() : extra.externalId,
      reservationId: extra.reservationId ?? null,
      subtotal: 100,
      taxAmount: 0,
      total: 100,
      remainingBalance: 100,
      createdAt: extra.createdAt ?? HACE_DOS_DIAS(),
      updatedAt: extra.updatedAt ?? HACE_DOS_DIAS(),
    },
  })
  if (!extra.sinProductos) {
    await prisma.orderItem.create({ data: { orderId: creada.id, quantity: 1, unitPrice: 100, taxAmount: 0, total: 100 } })
    // Agregar el renglón toca `updatedAt`: se regresa a la fecha de la prueba, como una venta vieja de verdad.
    await prisma.$executeRaw`UPDATE "Order" SET "updatedAt" = ${extra.updatedAt ?? HACE_DOS_DIAS()} WHERE id = ${creada.id}`
  }
  return creada.id
}

const estado = async (orderId: string) =>
  (await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } })).status

const activo = () => new VentasCobrarAbandonadasJob({ modo: 'ACTIVO' })

/** El efectivo que la cola de una TPV vieja manda días después: $100, sin `cobroNuevo` (dinero ya capturado). */
const efectivoDeLaCola = () =>
  ({
    venueId,
    amount: 10000,
    tip: 0,
    status: 'COMPLETED',
    method: 'CASH',
    source: 'TPV',
    splitType: 'FULLPAYMENT',
    tpvId: 'd36-tpv-vieja',
    staffId,
    paidProductsId: [],
    idempotencyKey: randomUUID(),
    currency: 'MXN',
    isInternational: false,
  }) as any

/** Lo que se toca al lado de la venta (comanda, cupón) puede mover `updatedAt`: se regresa a la fecha de la prueba. */
const otraVezVieja = (id: string) => prisma.$executeRaw`UPDATE "Order" SET "updatedAt" = ${HACE_DOS_DIAS()} WHERE id = ${id}`

/** La candidata tal como la eligió la vuelta (versión incluida). */
async function candidata(id: string): Promise<Candidata> {
  const o = await prisma.order.findUniqueOrThrow({ where: { id }, select: { id: true, venueId: true, orderNumber: true, version: true } })
  return o
}
const UMBRAL = () => new Date(Date.now() - 24 * 60 * 60 * 1000)

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: 'Org D36 limpieza Cobrar', email: `d36-cobrar-${Date.now()}@test.com`, phone: '5550000000' },
  })
  organizationId = org.id
  const venue = await prisma.venue.create({
    data: {
      name: 'D36 limpieza Cobrar',
      slug: `d36-cobrar-${Date.now()}`,
      organizationId,
      address: 'Test',
      city: 'Test',
      state: 'Test',
      country: 'MX',
      zipCode: '12345',
      timezone: 'America/Mexico_City',
    },
  })
  venueId = venue.id
  const staff = await prisma.staff.create({ data: { email: `d36-cobrar-${Date.now()}@test.com`, firstName: 'Cajera', lastName: 'D36' } })
  staffId = staff.id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: 'CASHIER' } })
})

afterAll(async () => {
  if (!venueId) return
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.referral.deleteMany({ where: { venueId } })
  await prisma.orderCustomer.deleteMany({ where: { order: { venueId } } })
  await prisma.orderDiscount.deleteMany({ where: { order: { venueId } } })
  await prisma.couponCode.deleteMany({ where: { discount: { venueId } } })
  await prisma.discount.deleteMany({ where: { venueId } })
  await prisma.terminalPaymentRequest.deleteMany({ where: { venueId } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.reservation.deleteMany({ where: { venueId } })
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: organizationId } })
  await prisma.$disconnect()
})

describe('limpieza de ventas de Cobrar abandonadas (D36)', () => {
  it('🔴 en ENSAYO no escribe NADA: la venta que cumple sigue pendiente y no hay bitácora; su negocio cuenta exactamente 1', async () => {
    const id = await venta('ensayo')
    const r = await new VentasCobrarAbandonadasJob({ modo: 'ENSAYO' }).correrAhora()

    expect(r.negocios.find(n => n.venueId === venueId)).toEqual({ venueId, cuantas: 1 })
    expect(await estado(id)).toBe('PENDING')
    expect(await prisma.activityLog.count({ where: { entityId: id } })).toBe(0)
  })

  it('ACTIVO: la venta que cumple TODO se ANULA (no se borra) con UNA bitácora de su camino, sin persona', async () => {
    const id = await venta('cumple')
    await activo().correrAhora()

    expect(await estado(id)).toBe('CANCELLED')
    expect(await prisma.orderItem.count({ where: { orderId: id } })).toBe(1)
    const bitacora = await prisma.activityLog.findMany({ where: { entityId: id, action: 'ORDER_CANCELLED' } })
    expect(bitacora).toHaveLength(1)
    expect(bitacora[0].staffId).toBeNull()
    expect(bitacora[0].data).toMatchObject({ camino: CAMINO_LIMPIEZA_COBRAR })
  })

  it('🔴 una con cliente NO se toca (puede ser un «Pagar después»)', async () => {
    const cliente = await prisma.customer.create({ data: { venueId } })
    const id = await venta('cliente', { customerId: cliente.id })
    await activo().correrAhora()
    expect(await estado(id)).toBe('PENDING')
  })

  it('🔴 una con un pago (de cualquier estado) NO se toca', async () => {
    const id = await venta('pago')
    await prisma.payment.create({
      data: {
        venueId,
        orderId: id,
        amount: 100,
        method: 'CRYPTOCURRENCY',
        status: 'PENDING',
        type: 'REGULAR',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 100,
      },
    })
    await activo().correrAhora()
    expect(await estado(id)).toBe('PENDING')
  })

  it('🔴 una con una solicitud del POS a la terminal NO se toca', async () => {
    const id = await venta('pos')
    await prisma.terminalPaymentRequest.create({
      data: {
        requestId: `d36-${id}-${Math.random()}`,
        venueId,
        terminalId: `terminal-${id}`,
        orderId: id,
        amountCents: 10000,
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    await activo().correrAhora()
    expect(await estado(id)).toBe('PENDING')
  })

  it('🔴 una creada hace menos de 24 h NO se toca, aunque nadie la haya tocado desde hace más', async () => {
    const id = await venta('reciente', { createdAt: HACE_UNA_HORA(), updatedAt: HACE_DOS_DIAS() })
    await activo().correrAhora()
    expect(await estado(id)).toBe('PENDING')
  })

  it('🔴 una vieja que alguien tocó hace menos de 24 h NO se toca', async () => {
    const id = await venta('tocada', { createdAt: HACE_DOS_DIAS(), updatedAt: HACE_UNA_HORA() })
    await activo().correrAhora()
    expect(await estado(id)).toBe('PENDING')
  })

  it('🔴 Codex r3 #4: una con una solicitud del POS RECHAZADA (la terminal estaba ocupada) tampoco se toca', async () => {
    const id = await venta('pos-rechazada')
    await prisma.terminalPaymentRequest.create({
      data: {
        requestId: `d36-${id}-${Math.random()}`,
        venueId,
        terminalId: `terminal-${id}`,
        orderId: id,
        amountCents: 10000,
        expiresAt: new Date(Date.now() + 60_000),
        status: 'FAILED',
        failureCode: 'REJECTED_TERMINAL_BUSY',
      },
    })
    await activo().correrAhora()
    expect(await estado(id)).toBe('PENDING')
  })

  it('🔴 Codex r3 #2: sólo la llave de Cobrar; las de otros flujos (libreta de «Órdenes», tarjetas de regalo) y las de reserva se quedan', async () => {
    const deCobrar = await venta('llave-cobrar', { externalId: randomUUID() })
    const ordenes = await venta('ordenes', { externalId: `local_${randomUUID()}` })
    const tarjetas = await venta('tarjetas', { externalId: `giftcard:${randomUUID()}` })
    const reserva = await prisma.reservation.create({
      data: {
        venueId,
        confirmationCode: `D36${Date.now()}`,
        startsAt: HACE_DOS_DIAS(),
        endsAt: HACE_DOS_DIAS(),
        duration: 60,
        blockedEndsAt: HACE_DOS_DIAS(),
      },
    })
    const deReserva = await venta('reserva', { reservationId: reserva.id })
    // Codex r4 #1: la cuenta que nace al SEPARAR una cuenta (ruta de la TPV) hereda «para llevar» y queda sin llave.
    const separada = await venta('separada', { externalId: null })
    await activo().correrAhora()

    expect(await estado(deCobrar)).toBe('CANCELLED')
    expect(await estado(ordenes)).toBe('PENDING')
    expect(await estado(tarjetas)).toBe('PENDING')
    expect(await estado(deReserva)).toBe('PENDING')
    expect(await estado(separada)).toBe('PENDING')
  })

  it.each([
    // Cada caso mueve UNA sola cosa: si se quitara esa comprobación bajo el candado, su caso se pondría rojo (Codex r4).
    [
      'le guardan un nombre (sólo cambia `updatedAt`)',
      (id: string) => prisma.order.update({ where: { id }, data: { customerName: 'Ana' } }),
    ],
    [
      'el panel la pasa a CONFIRMED (sólo cambia el estado)',
      (id: string) => prisma.$executeRaw`UPDATE "Order" SET status = 'CONFIRMED' WHERE id = ${id}`,
    ],
    [
      'le cambian un renglón (sólo cambia la versión)',
      (id: string) => prisma.$executeRaw`UPDATE "Order" SET version = version + 1 WHERE id = ${id}`,
    ],
  ])('🔴 Codex r3 #3: entre la elección y el candado %s ⇒ se queda, sin escribir nada', async (_caso, cambiar) => {
    const id = await venta('carrera')
    const elegida = await candidata(id)
    // Lo que otra caja o el panel hace en ese hueco.
    await cambiar(id)

    expect(await anularVentaDeCobrarAbandonada(elegida, UMBRAL())).toBe('seQueda')
    expect(await estado(id)).not.toBe('CANCELLED')
    expect(await prisma.activityLog.count({ where: { entityId: id } })).toBe(0)
    // La de la versión sigue cumpliendo la regla al elegir (la versión se compara bajo el candado): que no cuente abajo.
    await prisma.$executeRaw`UPDATE "Order" SET "updatedAt" = now() WHERE id = ${id}`
  })

  it('🔴 Codex r3 #5: el total del ENSAYO, calculado por Postgres, es la suma de todos los negocios', async () => {
    await venta('total-1')
    await venta('total-2')
    const r = await new VentasCobrarAbandonadasJob({ modo: 'ENSAYO' }).correrAhora()

    expect(r.negocios.find(n => n.venueId === venueId)?.cuantas).toBe(2)
    expect(r.anularia).toBe(r.negocios.reduce((suma, n) => suma + n.cuantas, 0))
    // Que no se queden para las pruebas de abajo.
    await activo().correrAhora()
  })

  it('🔴 Codex r4: con más de un lote de candidatas que se quedan, la 101 recibe turno en la vuelta siguiente', async () => {
    const hace = (minutos: number) => new Date(Date.UTC(2025, 0, 1, 0, minutos))
    const ids: string[] = []
    for (let i = 0; i < 101; i++) ids.push(await venta(`lote-${i}`, { createdAt: hace(i), updatedAt: hace(i) }))
    const vistas: string[] = []
    const job = new VentasCobrarAbandonadasJob({
      modo: 'ACTIVO',
      anular: async c => {
        vistas.push(c.id)
        return 'seQueda'
      },
    })

    await job.correrAhora()
    expect(vistas).toHaveLength(100)
    expect(vistas).not.toContain(ids[100])
    await job.correrAhora()
    expect(vistas).toContain(ids[100])
    // Que no se queden para las pruebas de abajo.
    await prisma.$executeRaw`UPDATE "Order" SET "updatedAt" = now() WHERE "venueId" = ${venueId} AND "orderNumber" LIKE 'D36-lote-%'`
  })

  it('🔴 Codex r3 #1: el efectivo que la cola de una TPV vieja manda DESPUÉS de la limpieza reabre la venta con rastro', async () => {
    const id = await venta('cobro-tardio')
    await activo().correrAhora()
    expect(await estado(id)).toBe('CANCELLED')

    const avisos = jest.spyOn(socketManager, 'broadcastToVenue')
    const respuesta: any = await recordOrderPayment(venueId, id, efectivoDeLaCola(), staffId)

    expect(await estado(id)).not.toBe('CANCELLED')
    expect(await prisma.payment.count({ where: { orderId: id } })).toBe(1)
    expect(await prisma.activityLog.count({ where: { entityId: id, action: 'ORDER_REOPENED_BY_CAPTURED_PAYMENT' } })).toBe(1)
    // Codex r2 #4: no basta con que entre el pago; la venta reabierta queda PAGADA, sin saldo de más ni de menos.
    const cobrada = await prisma.order.findUniqueOrThrow({ where: { id }, select: { paymentStatus: true, remainingBalance: true } })
    expect(cobrada.paymentStatus).toBe('PAID')
    expect(cobrada.remainingBalance.toNumber()).toBe(0)
    // Codex r3: la respuesta del cobro y el aviso en vivo dicen lo que quedó guardado, no la copia anulada que se leyó antes de cobrar.
    expect(respuesta.order).toMatchObject({ status: 'COMPLETED', paymentStatus: 'PAID' })
    const avisosDeLaVenta = avisos.mock.calls.filter(([, evento, datos]: any[]) => evento === 'order_updated' && datos?.orderId === id)
    // Uno solo, en el lugar de siempre, con lo que el cierre guardó bajo el candado (founder «B»).
    expect(avisosDeLaVenta.map(([, , datos]: any[]) => [datos.status, datos.paymentStatus])).toEqual([['COMPLETED', 'PAID']])
    avisos.mockRestore()
  })

  it('🔴 founder «B»: un ABONO tardío sobre la venta anulada la reabre debiendo, y el acuse y el aviso dicen PENDING/PARTIAL con su saldo', async () => {
    const id = await venta('abono-tardio')
    await activo().correrAhora()
    expect(await estado(id)).toBe('CANCELLED')

    const avisos = jest.spyOn(socketManager, 'broadcastToVenue')
    const respuesta: any = await recordOrderPayment(
      venueId,
      id,
      { ...efectivoDeLaCola(), amount: 4000, splitType: 'CUSTOMAMOUNT' },
      staffId,
    )

    const guardada = await prisma.order.findUniqueOrThrow({
      where: { id },
      select: { status: true, paymentStatus: true, remainingBalance: true },
    })
    expect(guardada).toMatchObject({ status: 'PENDING', paymentStatus: 'PARTIAL' })
    expect(guardada.remainingBalance.toNumber()).toBe(60)
    expect(respuesta.order).toMatchObject({ status: 'PENDING', paymentStatus: 'PARTIAL' })
    expect(Number(respuesta.order.remainingBalance)).toBe(60)
    // Codex r6 #3: el `order` del acuse es la fila guardada completa, no una mezcla de antes y después del cierre.
    const fila = await prisma.order.findUniqueOrThrow({ where: { id }, select: { splitType: true, servedById: true } })
    expect({ splitType: respuesta.order.splitType, servedById: respuesta.order.servedById }).toEqual(fila)
    const avisosDeLaVenta = avisos.mock.calls.filter(([, evento, datos]: any[]) => evento === 'order_updated' && datos?.orderId === id)
    expect(avisosDeLaVenta.map(([, , datos]: any[]) => [datos.status, datos.paymentStatus])).toEqual([['PENDING', 'PARTIAL']])
    avisos.mockRestore()
  })

  it('una sin productos o que no es de la TPV (kiosco) NO se toca', async () => {
    const vacia = await venta('vacia', { sinProductos: true })
    const kiosco = await venta('kiosco', { source: 'KIOSK' })
    await activo().correrAhora()
    expect(await estado(vacia)).toBe('PENDING')
    expect(await estado(kiosco)).toBe('PENDING')
  })
})

/**
 * Lo que una anulación devuelve y un cobro tardío ya no vuelve a contar (auditorías de Codex del 21-nov, antes de pasar a ACTIVO):
 * esas ventas se quedan como están. Y la lista legacy de «Órdenes» de la TPV ya no ofrece una anulada.
 */
describe('limpieza de Cobrar: lo que no se puede gastar dos veces (21-nov)', () => {
  async function descuento(id: string, fila: { cupon?: boolean; usoContado?: boolean }) {
    const d = await prisma.discount.create({ data: { venueId, name: 'Descuento D36', type: 'FIXED_AMOUNT', value: 10, maxTotalUses: 1 } })
    const cupon = fila.cupon
      ? await prisma.couponCode.create({ data: { discountId: d.id, code: `D36${Date.now()}${Math.random()}`.slice(0, 30), maxUses: 1 } })
      : null
    await prisma.orderDiscount.create({
      data: {
        orderId: id,
        discountId: d.id,
        couponCodeId: cupon?.id ?? null,
        usoContado: fila.usoContado ?? false,
        type: 'FIXED_AMOUNT',
        name: 'Descuento D36',
        value: 10,
        amount: 10,
      },
    })
    await otraVezVieja(id)
  }

  it.each([
    ['un CUPÓN (su uso queda apartado; otra venta podría tomar el último)', { cupon: true }],
    ['un descuento con su uso CONTADO (D24, el del POS; el «primeros N» se pasaría)', { usoContado: true }],
    ['un descuento de catálogo (el que pone la TPV al crearla) o un canje (se borraría y quedaría una deuda que no hubo)', {}],
  ])('🔴 una con %s no se toca: sólo se anulan carritos sin ningún descuento', async (_caso, fila) => {
    const id = await venta('descuento')
    await descuento(id, fila)

    const ensayo = await new VentasCobrarAbandonadasJob({ modo: 'ENSAYO' }).correrAhora()
    expect(ensayo.negocios.find(n => n.venueId === venueId)).toBeUndefined()
    await activo().correrAhora()
    expect(await estado(id)).toBe('PENDING')
  })

  it('🔴 una que un REFERIDO usa como venta que lo califica no se toca: anularla lo mandaría a VOID y el cobro tardío ya no lo califica', async () => {
    const id = await venta('referido')
    const [quienRefiere, referida] = await Promise.all([
      prisma.customer.create({ data: { venueId } }),
      prisma.customer.create({ data: { venueId } }),
    ])
    await prisma.referral.create({
      data: { venueId, referrerCustomerId: quienRefiere.id, referredCustomerId: referida.id, qualifyingOrderId: id },
    })
    await otraVezVieja(id)
    await activo().correrAhora()
    expect(await estado(id)).toBe('PENDING')
  })

  it('🔴 Codex r2 #2: al anular, la limpieza ya no manda referidos a VOID (uno capturado en el instante después queda para el cobro)', async () => {
    const id = await venta('sin-referidos')
    ;(onOrderCancelled as jest.Mock).mockClear()
    await activo().correrAhora()
    expect(await estado(id)).toBe('CANCELLED')
    expect(onOrderCancelled).not.toHaveBeenCalledWith(expect.objectContaining({ orderId: id }))
  })

  it('🔴 la lista legacy de «Órdenes» de la TPV deja de ofrecer la venta anulada, aunque su pago siga PENDING', async () => {
    const id = await venta('lista')
    expect((await getOrders(venueId)).map(o => o.id)).toContain(id)
    await activo().correrAhora()

    const anulada = await prisma.order.findUniqueOrThrow({ where: { id }, select: { status: true, paymentStatus: true } })
    expect(anulada).toEqual({ status: 'CANCELLED', paymentStatus: 'PENDING' })
    expect((await getOrders(venueId)).map(o => o.id)).not.toContain(id)
    expect((await getOrders(venueId, undefined, { includePayLater: true })).map(o => o.id)).not.toContain(id)
  })

  it('🔴 la lista tampoco ofrece una BORRADA ni un «Pagar después» anulado, aunque su pago siga PENDING', async () => {
    const borrada = await venta('borrada')
    await prisma.$executeRaw`UPDATE "Order" SET status = 'DELETED' WHERE id = ${borrada}`
    const cliente = await prisma.customer.create({ data: { venueId } })
    const fiado = await venta('fiado-anulado')
    await prisma.orderCustomer.create({ data: { orderId: fiado, customerId: cliente.id } })
    expect((await getOrders(venueId, undefined, { onlyPayLater: true })).map(o => o.id)).toContain(fiado)
    await prisma.$executeRaw`UPDATE "Order" SET status = 'CANCELLED' WHERE id = ${fiado}`

    expect((await getOrders(venueId)).map(o => o.id)).not.toContain(borrada)
    expect((await getOrders(venueId, undefined, { onlyPayLater: true })).map(o => o.id)).not.toContain(fiado)
  })
})
