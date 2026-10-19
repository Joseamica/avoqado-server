/**
 * Una creación de mostrador cabe en UNA conexión (Task 4): dentro de su transacción todo va por `tx` —el candado de la llave,
 * la re-verificación, el armado de las líneas y la búsqueda en el historial—. Una sola lectura con `prisma` adentro pediría
 * una segunda conexión que no existe y se quedaría esperando hasta tronar por `pool_timeout` (P2024).
 *
 * El pool de UNA conexión lo pone esta suite (cliente propio, como `dashboard/sql-aggregation-range-edges`), así corre igual
 * en local y en el CI con la URL de siempre:
 *   TEST_DATABASE_URL="$DESECHABLE" DATABASE_URL="$DESECHABLE" npx jest --selectProjects=integration --runInBand \
 *     --runTestsByPath tests/integration/mobile/precioQueVioElCliente.unaConexion.integration.test.ts --ci
 */

// Cliente de UNA conexión para todo lo que importe `@/utils/prismaClient` (el servicio incluido). `jest.mock` se eleva sobre
// los imports; la fábrica sólo usa globales. El cliente real agrega extensiones que sólo registran: aquí no importan.
jest.mock('@/utils/prismaClient', () => {
  const { PrismaClient } = require('@prisma/client')
  const base = process.env.TEST_DATABASE_URL as string
  const url = `${base}${base.includes('?') ? '&' : '?'}connection_limit=1`
  return { __esModule: true, default: new PrismaClient({ datasources: { db: { url } } }) }
})

import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createOrderWithItems } from '@/services/mobile/order.mobile.service'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(database.hostname) || !/^\/avoqado_[a-z0-9]+_test_/.test(database.pathname)) {
  throw new Error('Esta suite exige una base desechable local (avoqado_<tarea>_test_<fecha>).')
}

const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let organizationId: string
let venueId: string
let staffId: string
let productId: string

beforeAll(async () => {
  organizationId = (
    await prisma.organization.create({ data: { name: `Una con ${s}`, email: `una-con-${s}@example.com`, phone: '5555555555' } })
  ).id
  venueId = (await prisma.venue.create({ data: { organizationId, name: `Una con ${s}`, slug: `una-con-${s}`, seatCapExempt: true } })).id
  staffId = (await prisma.staff.create({ data: { email: `una-con-${s}@staff.test`, firstName: 'Caja', lastName: 'Una' } })).id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: 'MANAGER' } })
  const categoryId = (await prisma.menuCategory.create({ data: { venueId, name: `Cat ${s}`, slug: `cat-${s}` } })).id
  productId = (
    await prisma.product.create({ data: { venueId, categoryId, sku: `SKU-${s}`, name: `Café ${s}`, price: new Prisma.Decimal(45) } })
  ).id
})

afterAll(async () => {
  if (!venueId) return // sin fixture, un deleteMany sin filtro borraría la tabla entera
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } })
})
afterAll(() => prisma.$disconnect())

async function crearMidiendo(input: Record<string, unknown>) {
  const inicio = Date.now()
  const orden = await createOrderWithItems(venueId, { staffId, source: 'AVOQADO_ANDROID', ...input } as any)
  return { orden, ms: Date.now() - inicio }
}

describe('una creación normal cabe en UNA conexión', () => {
  it('app vieja (con externalId, sin campos nuevos) y precio mostrado reconocido: las dos crean su orden en < 8 s', async () => {
    const vieja = await crearMidiendo({ externalId: `venta-${randomUUID()}`, items: [{ productId, quantity: 1 }] })
    expect(vieja.orden.total).toBe(45)
    expect(vieja.ms).toBeLessThan(8_000)

    // El cliente vio 45 y ahora cuesta 50: la búsqueda del historial también corre dentro de la transacción.
    const catalogAt = new Date().toISOString()
    await prisma.product.update({ where: { id: productId }, data: { price: new Prisma.Decimal(50) } })
    const reconocida = await crearMidiendo({
      externalId: `venta-${randomUUID()}`,
      items: [{ productId, quantity: 1, externalId: 'l1', displayedUnitPrice: 4500, catalogAt }],
    })
    expect(reconocida.orden.total).toBe(45)
    expect(reconocida.orden).not.toHaveProperty('priceChanges')
    expect(reconocida.ms).toBeLessThan(8_000)
  }, 40_000)
})
