/**
 * hz:e0b12f00:D2 — HTTP + checkPermission + PIN de gerente (PermissionOverride) + controlador/escritor + PostgreSQL REALES.
 * En el POS, un «Descuento de la cuenta» libre que deja los productos en $0 es una cortesía:
 * - la app nueva en línea sin `orders:comp` recibe el 403 canónico (con `required` y `overridable`) y no se escribe nada;
 * - con el token de un PIN de `orders:comp` pasa y la fila queda con el gerente que lo autorizó;
 * - lo que llega de la cola (`isOfflineReplay`) o de una app vieja (sin `cortesiaDeCuentaConPin`) se registra, con bitácora.
 * Sólo se sustituyen transportes Socket.IO/wallet y el aviso (correo/push). El runner crea y destruye SU base.
 */
import cuid = require('cuid')
import express from 'express'
import type { ErrorRequestHandler } from 'express'
import request from 'supertest'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createOrder } from '@/controllers/mobile/order.mobile.controller'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { checkCortesiaPermissionIfPresent, traeDescuentoManual } from '@/middlewares/cortesiaPidePermiso.middleware'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.mock('@/services/mobile/avisoDeVentaSinRed', () => ({
  ...jest.requireActual('@/services/mobile/avisoDeVentaSinRed'),
  avisarVentaSinRed: jest.fn().mockResolvedValue(undefined),
}))

const target = new URL(process.env.TEST_DATABASE_URL ?? '')
const actual = new URL(process.env.DATABASE_URL ?? '')
if (
  process.env.USE_RENDER_DB === 'true' ||
  !['localhost', '127.0.0.1'].includes(target.hostname) ||
  !/^\/avoqado_[a-z0-9]+_test_/.test(target.pathname) ||
  target.hostname !== actual.hostname ||
  target.port !== actual.port ||
  target.pathname !== actual.pathname
) {
  throw new Error('D2 exige la MISMA base desechable local en TEST_DATABASE_URL y DATABASE_URL; nunca av-db-25 ni una QA existente.')
}

type Actor = 'mesero' | 'gerente'
const suffix = cuid()
let organizationId: string
let venueId: string
let meseroId: string
let gerenteId: string
let gerenteVenueId: string
let productId: string

beforeAll(async () => {
  const [db] = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`
  expect(db.name).toBe(decodeURIComponent(target.pathname.slice(1)))
  organizationId = (await prisma.organization.create({ data: { name: `D2 ${suffix}`, email: `${suffix}@org.test`, phone: '5555555555' } }))
    .id
  venueId = (
    await prisma.venue.create({ data: { organizationId, name: `D2 ${suffix}`, slug: suffix, type: 'RESTAURANT', seatCapExempt: true } })
  ).id
  await prisma.venueSettings.create({ data: { venueId, managerPinOverrideEnabled: true } })
  meseroId = (
    await prisma.staff.create({ data: { email: `${suffix}@mesero.test`, firstName: 'Mesero', lastName: 'Sintético', active: true } })
  ).id
  gerenteId = (
    await prisma.staff.create({ data: { email: `${suffix}@gerente.test`, firstName: 'Gerente', lastName: 'Sintético', active: true } })
  ).id
  // Permisos efectivos reales: el mesero aplica descuentos, pero no da cortesías.
  const meseroSet = await prisma.permissionSet.create({
    data: { venueId, name: 'D2 Mesero', permissions: ['orders:create', 'discounts:apply'] },
  })
  const gerenteSet = await prisma.permissionSet.create({
    data: { venueId, name: 'D2 Gerente', permissions: ['orders:create', 'discounts:apply', 'orders:comp'] },
  })
  await prisma.staffVenue.create({ data: { venueId, staffId: meseroId, role: 'WAITER', active: true, permissionSetId: meseroSet.id } })
  gerenteVenueId = (
    await prisma.staffVenue.create({ data: { venueId, staffId: gerenteId, role: 'MANAGER', active: true, permissionSetId: gerenteSet.id } })
  ).id
  const category = await prisma.menuCategory.create({ data: { venueId, name: 'Comida sintética', slug: suffix } })
  productId = (
    await prisma.product.create({
      data: { venueId, categoryId: category.id, sku: cuid(), name: 'Enchiladas D2', type: 'REGULAR', price: new Prisma.Decimal(100) },
    })
  ).id
  for (const id of [organizationId, venueId, meseroId, gerenteId, gerenteVenueId, productId]) expect(id).toMatch(/^c[a-z0-9]{24}$/)
})

// No deleteMany: todos los registros pertenecen a la base que el runner destruye en finally.
afterAll(async () => {
  await prisma.$disconnect()
})

/** La ruta real: mismos candados que `POST /mobile/venues/:venueId/orders` (el de promociones, sólo su `discounts:apply`). */
function api(actor: Actor) {
  const app = express()
  app.use(express.json())
  app.post(
    '/mobile/venues/:venueId/orders',
    (req, _res, next) => {
      req.authContext = {
        userId: actor === 'mesero' ? meseroId : gerenteId,
        orgId: organizationId,
        venueId,
        role: actor === 'mesero' ? 'WAITER' : 'MANAGER',
      }
      next()
    },
    checkPermission('orders:create'),
    checkCortesiaPermissionIfPresent,
    (req, res, next) => (traeDescuentoManual(req.body) ? checkPermission('discounts:apply')(req, res, next) : next()),
    createOrder,
  )
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(error.statusCode ?? 500).json({ message: error.message })
  }
  app.use(errors)
  return app
}

async function token(permission: string) {
  const value = cuid()
  await prisma.permissionOverride.create({
    data: { venueId, token: value, permission, authorizedById: gerenteVenueId, expiresAt: new Date(Date.now() + 60_000) },
  })
  return value
}

async function vender(actor: Actor, cuerpo: Record<string, unknown>, headers: Record<string, string> = {}) {
  const externalId = (cuerpo.externalId as string) ?? cuid()
  const req = request(api(actor)).post(`/mobile/venues/${venueId}/orders`)
  for (const [k, v] of Object.entries(headers)) req.set(k, v)
  const response = await req.send({
    staffId: actor === 'mesero' ? meseroId : gerenteId,
    externalId,
    source: 'AVOQADO_ANDROID',
    orderType: 'DINE_IN',
    items: [{ productId, quantity: 1, externalId: cuid() }],
    discount: 10000,
    cortesiaDeCuentaConPin: true,
    ...cuerpo,
  })
  const order = await prisma.order.findUnique({ where: { venueId_externalId: { venueId, externalId } } })
  const fila = order ? await prisma.orderDiscount.findFirst({ where: { orderId: order.id, name: 'Descuento de la cuenta' } }) : null
  const bitacora = await prisma.activityLog.findFirst({
    where: { venueId, action: 'VENTA_SIN_RED_DESCUENTO_SIN_PERMISO', entityId: externalId },
  })
  return { response, externalId, order, fila, bitacora }
}

describe('D2 — el «Descuento de la cuenta» que regala, HTTP y Postgres', () => {
  it('🔴 mesero, app nueva, en línea, 100 %: 403 canónico de orders:comp (con PIN) y no se escribe nada', async () => {
    const antes = await prisma.order.count({ where: { venueId } })
    const r = await vender('mesero', {})
    expect(r.response.status).toBe(403)
    expect(r.response.body).toMatchObject({ required: 'orders:comp', overridable: true })
    expect(r.order).toBeNull()
    expect(await prisma.order.count({ where: { venueId } })).toBe(antes)
  })

  it('🔴 con el token del PIN de un gerente: se crea y la fila queda con el gerente; el token se consume', async () => {
    const t = await token('orders:comp')
    const r = await vender('mesero', {}, { 'x-permission-override': t })
    expect(r.response.status).toBe(201)
    expect([Number(r.order!.subtotal), Number(r.order!.discountAmount), Number(r.order!.total)]).toEqual([100, 100, 0])
    expect(r.fila).toMatchObject({ authorizedById: gerenteVenueId, isManual: true })
    expect(Number(r.fila!.amount)).toBe(100)
    expect(r.bitacora).toBeNull()
    const usado = await prisma.permissionOverride.findUniqueOrThrow({ where: { token: t } })
    expect(usado.consumedAt).not.toBeNull()
    // Un solo uso: el mismo token ya no autoriza otra venta.
    const otra = await vender('mesero', {}, { 'x-permission-override': t })
    expect(otra.response.status).toBe(403)
    expect(otra.order).toBeNull()
  })

  it('un token de OTRO permiso no autoriza la cortesía y no se gasta', async () => {
    const t = await token('discounts:apply')
    const r = await vender('mesero', {}, { 'x-permission-override': t })
    expect(r.response.status).toBe(403)
    expect(r.order).toBeNull()
    expect((await prisma.permissionOverride.findUniqueOrThrow({ where: { token: t } })).consumedAt).toBeNull()
  })

  it('$99.99 de $100: pasa sin permiso, sin autorizador y sin bitácora', async () => {
    const r = await vender('mesero', { discount: 9999 })
    expect(r.response.status).toBe(201)
    expect(Number(r.fila!.amount)).toBe(99.99)
    expect(r.fila!.authorizedById).toBeNull()
    expect(r.bitacora).toBeNull()
  })

  it('gerente en sesión: pasa sin PIN y la fila queda con su membresía', async () => {
    const r = await vender('gerente', {})
    expect(r.response.status).toBe(201)
    expect(r.fila).toMatchObject({ authorizedById: gerenteVenueId })
  })

  it.each([
    ['la cola sin red', { isOfflineReplay: true }],
    ['una app vieja (sin la marca)', { cortesiaDeCuentaConPin: undefined }],
  ])('🔴 %s, mesero sin permiso: se registra, sin autorizador y con bitácora en la misma transacción', async (_, extra) => {
    const r = await vender('mesero', extra)
    expect(r.response.status).toBe(201)
    expect(Number(r.order!.total)).toBe(0)
    expect(r.fila!.authorizedById).toBeNull()
    expect(r.bitacora).toMatchObject({ entity: 'VentaSinRed', staffId: meseroId })
    expect(r.bitacora!.data).toMatchObject({ orderId: r.order!.id, montoCents: 10000 })
  })

  it('🔴 el reintento con la misma llave de una venta ya creada recibe su orden, no un 403 (antes de la regla)', async () => {
    const primera = await vender('mesero', { isOfflineReplay: true })
    expect(primera.response.status).toBe(201)
    const reintento = await vender('mesero', { externalId: primera.externalId })
    expect(reintento.response.status).toBe(201)
    expect(reintento.order!.id).toBe(primera.order!.id)
    expect(await prisma.order.count({ where: { venueId, externalId: primera.externalId } })).toBe(1)
  })
})
