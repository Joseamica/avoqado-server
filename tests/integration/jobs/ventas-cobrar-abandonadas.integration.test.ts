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
import prisma from '@/utils/prismaClient'
import { CAMINO_LIMPIEZA_COBRAR, VentasCobrarAbandonadasJob } from '@/jobs/ventas-cobrar-abandonadas.job'

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

async function venta(
  clave: string,
  extra: Partial<{ customerId: string; createdAt: Date; updatedAt: Date; sinProductos: boolean; source: 'TPV' | 'KIOSK' }> = {},
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
})

afterAll(async () => {
  if (!venueId) return
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.terminalPaymentRequest.deleteMany({ where: { venueId } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: organizationId } })
  await prisma.$disconnect()
})

describe('limpieza de ventas de Cobrar abandonadas (D36)', () => {
  it('🔴 en ENSAYO no escribe NADA: la venta que cumple sigue pendiente y no hay bitácora', async () => {
    const id = await venta('ensayo')
    const r = await new VentasCobrarAbandonadasJob({ modo: 'ENSAYO' }).correrAhora()

    expect(r.anularia).toBeGreaterThanOrEqual(1)
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

  it('🔴 una de menos de 24 h NO se toca', async () => {
    const id = await venta('reciente', { createdAt: HACE_UNA_HORA(), updatedAt: HACE_UNA_HORA() })
    await activo().correrAhora()
    expect(await estado(id)).toBe('PENDING')
  })

  it('una sin productos o que no es de la TPV (kiosco) NO se toca', async () => {
    const vacia = await venta('vacia', { sinProductos: true })
    const kiosco = await venta('kiosco', { source: 'KIOSK' })
    await activo().correrAhora()
    expect(await estado(vacia)).toBe('PENDING')
    expect(await estado(kiosco)).toBe('PENDING')
  })
})
