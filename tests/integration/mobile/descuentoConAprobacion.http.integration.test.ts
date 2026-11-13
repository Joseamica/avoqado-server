/**
 * D4 (hz:f34960c5:D4, founder «B») — HTTP + checkPermission + PIN de gerente (PermissionOverride) + middleware + controlador/escritor
 * + PostgreSQL REALES. Un % o fijo de catálogo con «Requiere aprobación»:
 * - quien tiene `tpv-orders:discount` lo aplica directo;
 * - quien no, recibe el 403 canónico (`required` + `overridable`) y no se escribe nada; con el token del PIN de un gerente, entra;
 * - la fila guarda quién lo aplicó y quién lo aprobó;
 * - D4 r5: una venta de la cola sin el permiso YA se cobró: entra sin aprobador y con rastro (antes, 403 = efectivo sin venta); en
 *   línea sigue el 403; una llave que ya existe devuelve su venta sin pedir nada;
 * - una venta que necesita cortesía Y aprobación lleva los dos tokens y cada revisión gasta el suyo.
 * Sólo se sustituyen transportes Socket.IO/wallet y el aviso. El runner crea y destruye SU base.
 */
import cuid = require('cuid')
import express from 'express'
import type { ErrorRequestHandler } from 'express'
import request from 'supertest'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { applyOrderDiscount, createOrder } from '@/controllers/mobile/order.mobile.controller'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import {
  checkAprobacionDelDescuento,
  checkCortesiaEnDescuento,
  checkCortesiaPermissionIfPresent,
  traeDescuentoManual,
} from '@/middlewares/cortesiaPidePermiso.middleware'

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
  throw new Error('D4 exige la MISMA base desechable local en TEST_DATABASE_URL y DATABASE_URL; nunca av-db-25 ni una QA existente.')
}

type Actor = 'cajera' | 'gerente'
const suffix = cuid()
let organizationId: string
let venueId: string
let cajeraId: string
let cajeraVenueId: string
let gerenteId: string
let gerenteVenueId: string
let productId: string
let gerencialId: string // 10 %, «Requiere aprobación»
let libreId: string // 10 %, sin aprobación

beforeAll(async () => {
  const [db] = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`
  expect(db.name).toBe(decodeURIComponent(target.pathname.slice(1)))
  organizationId = (await prisma.organization.create({ data: { name: `D4 ${suffix}`, email: `${suffix}@org.test`, phone: '5555555555' } }))
    .id
  venueId = (
    await prisma.venue.create({ data: { organizationId, name: `D4 ${suffix}`, slug: suffix, type: 'RESTAURANT', seatCapExempt: true } })
  ).id
  await prisma.venueSettings.create({ data: { venueId, managerPinOverrideEnabled: true } })
  cajeraId = (
    await prisma.staff.create({ data: { email: `${suffix}@cajera.test`, firstName: 'Cajera', lastName: 'Sintética', active: true } })
  ).id
  gerenteId = (
    await prisma.staff.create({ data: { email: `${suffix}@gerente.test`, firstName: 'Gerente', lastName: 'Sintético', active: true } })
  ).id
  // Permisos efectivos reales: la cajera aplica descuentos (`discounts:apply`), pero no aprueba ni da cortesías.
  const cajeraSet = await prisma.permissionSet.create({
    data: { venueId, name: 'D4 Cajera', permissions: ['orders:create', 'orders:update', 'discounts:apply'] },
  })
  const gerenteSet = await prisma.permissionSet.create({
    data: {
      venueId,
      name: 'D4 Gerente',
      permissions: ['orders:create', 'orders:update', 'discounts:apply', 'orders:comp', 'tpv-orders:discount'],
    },
  })
  cajeraVenueId = (
    await prisma.staffVenue.create({ data: { venueId, staffId: cajeraId, role: 'CASHIER', active: true, permissionSetId: cajeraSet.id } })
  ).id
  gerenteVenueId = (
    await prisma.staffVenue.create({ data: { venueId, staffId: gerenteId, role: 'MANAGER', active: true, permissionSetId: gerenteSet.id } })
  ).id
  const category = await prisma.menuCategory.create({ data: { venueId, name: 'Ropa sintética', slug: suffix } })
  productId = (
    await prisma.product.create({
      data: { venueId, categoryId: category.id, sku: cuid(), name: 'Playera D4', type: 'REGULAR', price: new Prisma.Decimal(100) },
    })
  ).id
  gerencialId = (
    await prisma.discount.create({
      data: { venueId, name: '10% gerencial', type: 'PERCENTAGE', value: new Prisma.Decimal(10), scope: 'ORDER', requiresApproval: true },
    })
  ).id
  libreId = (
    await prisma.discount.create({
      data: { venueId, name: '10% frecuente', type: 'PERCENTAGE', value: new Prisma.Decimal(10), scope: 'ORDER' },
    })
  ).id
  for (const id of [organizationId, venueId, cajeraId, gerenteId, cajeraVenueId, gerenteVenueId, productId, gerencialId, libreId]) {
    expect(id).toMatch(/^c[a-z0-9]{24}$/)
  }
})

// No deleteMany: todos los registros pertenecen a la base que el runner destruye en finally.
afterAll(async () => {
  await prisma.$disconnect()
})

function sesion(actor: Actor): express.RequestHandler {
  return (req, _res, next) => {
    req.authContext = {
      userId: actor === 'cajera' ? cajeraId : gerenteId,
      orgId: organizationId,
      venueId,
      role: actor === 'cajera' ? 'CASHIER' : 'MANAGER',
    }
    next()
  }
}

/** Las dos rutas reales, con sus mismos candados (de promociones, sólo su `discounts:apply`). */
function api(actor: Actor) {
  const app = express()
  app.use(express.json())
  app.post(
    '/mobile/venues/:venueId/orders',
    sesion(actor),
    checkPermission('orders:create'),
    checkCortesiaPermissionIfPresent,
    checkAprobacionDelDescuento,
    (req, res, next) => (traeDescuentoManual(req.body) ? checkPermission('discounts:apply')(req, res, next) : next()),
    createOrder,
  )
  app.post(
    '/mobile/venues/:venueId/orders/:orderId/discounts',
    sesion(actor),
    checkPermission('orders:update'),
    checkCortesiaEnDescuento,
    checkAprobacionDelDescuento,
    applyOrderDiscount,
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
    staffId: actor === 'cajera' ? cajeraId : gerenteId,
    externalId,
    source: 'AVOQADO_ANDROID',
    orderType: 'TAKEOUT',
    items: [{ productId, quantity: 1, externalId: cuid() }],
    ...cuerpo,
  })
  return { response, externalId }
}

async function cuentaAbierta(): Promise<string> {
  const { response } = await vender('gerente', {})
  expect(response.status).toBe(201)
  return response.body.order.id
}

async function aplicar(actor: Actor, orderId: string, discountId: string, headers: Record<string, string> = {}) {
  const req = request(api(actor)).post(`/mobile/venues/${venueId}/orders/${orderId}/discounts`)
  for (const [k, v] of Object.entries(headers)) req.set(k, v)
  return req.send({ discountId })
}

describe('D4 · Mesas: aplicar a la cuenta abierta', () => {
  it('cajera sin permiso: 403 canónico con overridable y la cuenta no cambia', async () => {
    const orderId = await cuentaAbierta()
    const r = await aplicar('cajera', orderId, gerencialId)
    expect(r.status).toBe(403)
    expect(r.body).toMatchObject({ required: 'tpv-orders:discount', overridable: true })
    expect(await prisma.orderDiscount.count({ where: { orderId } })).toBe(0)
  })

  it('cajera con el PIN de un gerente: entra, guarda quién aplicó y quién aprobó, y el token queda gastado', async () => {
    const orderId = await cuentaAbierta()
    const pin = await token('tpv-orders:discount')
    const r = await aplicar('cajera', orderId, gerencialId, { 'x-permission-override': pin })
    expect(r.status).toBe(200)
    const fila = await prisma.orderDiscount.findFirstOrThrow({ where: { orderId, discountId: gerencialId } })
    expect([Number(fila.amount), fila.appliedById, fila.authorizedById]).toEqual([10, cajeraVenueId, gerenteVenueId])
    expect((await prisma.permissionOverride.findUniqueOrThrow({ where: { token: pin } })).consumedAt).not.toBeNull()
  })

  it('gerente con el permiso: entra directo y queda como quien aprobó', async () => {
    const orderId = await cuentaAbierta()
    const r = await aplicar('gerente', orderId, gerencialId)
    expect(r.status).toBe(200)
    const fila = await prisma.orderDiscount.findFirstOrThrow({ where: { orderId, discountId: gerencialId } })
    expect([fila.appliedById, fila.authorizedById]).toEqual([gerenteVenueId, gerenteVenueId])
  })

  it('regresión: un % sin aprobación lo aplica la cajera como hoy', async () => {
    const orderId = await cuentaAbierta()
    const r = await aplicar('cajera', orderId, libreId)
    expect(r.status).toBe(200)
    const fila = await prisma.orderDiscount.findFirstOrThrow({ where: { orderId, discountId: libreId } })
    expect(fila.authorizedById).toBeNull()
  })
})

describe('D4 · Mostrador: la venta nueva', () => {
  const conEtiqueta = { discount: 1000, descuentoDeCatalogoId: '' }
  const etiqueta = () => ({ ...conEtiqueta, descuentoDeCatalogoId: gerencialId })

  it('cajera con la etiqueta del descuento de cuenta, sin PIN: 403 overridable y no nace la venta', async () => {
    const { response, externalId } = await vender('cajera', etiqueta())
    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ required: 'tpv-orders:discount', overridable: true })
    expect(await prisma.order.count({ where: { venueId, externalId } })).toBe(0)
  })

  it('cajera con el PIN: nace con el importe de la caja y la fila guarda al gerente', async () => {
    const { response } = await vender('cajera', etiqueta(), { 'x-permission-override': await token('tpv-orders:discount') })
    expect(response.status).toBe(201)
    expect(response.body.order).toMatchObject({ discountAmount: 10, total: 90 })
    const fila = await prisma.orderDiscount.findFirstOrThrow({ where: { orderId: response.body.order.id } })
    expect([fila.name, Number(fila.amount), fila.authorizedById]).toEqual(['Descuento de la cuenta', 10, gerenteVenueId])
  })

  it('descuento por renglón que pide aprobación: igual (403 sin PIN; con PIN el renglón guarda al gerente)', async () => {
    const renglon = await prisma.discount.create({
      data: { venueId, name: '$20 gerencial', type: 'FIXED_AMOUNT', value: new Prisma.Decimal(20), scope: 'ITEM', requiresApproval: true },
    })
    const items = [{ productId, quantity: 1, externalId: cuid(), discountId: renglon.id }]
    expect((await vender('cajera', { items })).response.status).toBe(403)
    const { response } = await vender('cajera', { items }, { 'x-permission-override': await token('tpv-orders:discount') })
    expect(response.status).toBe(201)
    const fila = await prisma.orderDiscount.findFirstOrThrow({ where: { orderId: response.body.order.id, discountId: renglon.id } })
    expect([Number(fila.amount), fila.authorizedById]).toEqual([20, gerenteVenueId])
  })

  // D4 r5 (Codex, apps viejas): la cajera cobró $90 de $100 en efectivo SIN RED con un descuento por producto que pide aprobación.
  // Al volver la red la cola reproduce la venta: el dinero ya está en la caja, así que entra (como antes de #423), sin aprobador.
  it('venta de la cola (isOfflineReplay) de una sesión sin el permiso: 201, sin aprobador y con rastro en la bitácora', async () => {
    const renglon = await prisma.discount.create({
      data: {
        venueId,
        name: '10% producto gerencial',
        type: 'PERCENTAGE',
        value: new Prisma.Decimal(10),
        scope: 'ITEM',
        requiresApproval: true,
      },
    })
    const items = [{ productId, quantity: 1, externalId: cuid(), discountId: renglon.id }]
    const { response, externalId } = await vender('cajera', { items, isOfflineReplay: true, createdAtLocal: Date.now() })
    expect(response.status).toBe(201)
    expect(response.body.order).toMatchObject({ discountAmount: 10, total: 90 })
    const orderId = response.body.order.id
    expect(await prisma.order.count({ where: { venueId, externalId } })).toBe(1)
    const fila = await prisma.orderDiscount.findFirstOrThrow({ where: { orderId, discountId: renglon.id } })
    expect([Number(fila.amount), fila.appliedById, fila.authorizedById]).toEqual([10, cajeraVenueId, null])
    const rastro = await prisma.activityLog.findFirstOrThrow({
      where: { venueId, action: 'DESCUENTO_SIN_APROBACION_SIN_RED', entityId: orderId },
    })
    expect(rastro.data).toMatchObject({ orderId, discountId: renglon.id, nombre: '10% producto gerencial', importePesos: 10 })
    // En línea (sin `isOfflineReplay`) la misma venta sigue pidiendo el PIN.
    const enLinea = await vender('cajera', { items: [{ ...items[0], externalId: cuid() }] })
    expect(enLinea.response.status).toBe(403)
    expect(enLinea.response.body).toMatchObject({ required: 'tpv-orders:discount', overridable: true })
    expect(await prisma.order.count({ where: { venueId, externalId: enLinea.externalId } })).toBe(0)
  })

  it('venta de la cola con la etiqueta del descuento de cuenta, sin el permiso: entra sin aprobador', async () => {
    const { response } = await vender('cajera', { ...etiqueta(), isOfflineReplay: true, createdAtLocal: Date.now() })
    expect(response.status).toBe(201)
    const fila = await prisma.orderDiscount.findFirstOrThrow({ where: { orderId: response.body.order.id } })
    expect([fila.name, Number(fila.amount), fila.appliedById, fila.authorizedById]).toEqual([
      'Descuento de la cuenta',
      10,
      cajeraVenueId,
      null,
    ])
  })

  it('venta de la cola de una sesión con el permiso: entra y el aprobador es esa sesión', async () => {
    const { response } = await vender('gerente', { ...etiqueta(), isOfflineReplay: true, createdAtLocal: Date.now() })
    expect(response.status).toBe(201)
    const fila = await prisma.orderDiscount.findFirstOrThrow({ where: { orderId: response.body.order.id } })
    expect(fila.authorizedById).toBe(gerenteVenueId)
  })

  it('la llave ya existe (respuesta perdida): la cola sin permiso recibe la venta que ya está, sin crear otra', async () => {
    const primera = await vender('cajera', etiqueta(), { 'x-permission-override': await token('tpv-orders:discount') })
    expect(primera.response.status).toBe(201)
    const reintento = await vender('cajera', {
      ...etiqueta(),
      externalId: primera.externalId,
      isOfflineReplay: true,
      createdAtLocal: Date.now(),
    })
    expect([200, 201]).toContain(reintento.response.status)
    expect(reintento.response.body.order.id).toBe(primera.response.body.order.id)
    expect(await prisma.order.count({ where: { venueId, externalId: primera.externalId } })).toBe(1)
  })

  it('cortesía y aprobación en la misma venta: los dos tokens viajan juntos y cada revisión gasta el suyo (Codex r1 #4)', async () => {
    const items = [
      { productId, quantity: 1, externalId: cuid() },
      { productId, quantity: 1, externalId: cuid(), isCortesia: true, cortesiaReason: 'Invitación' },
    ]
    const sinNada = await vender('cajera', { items, ...etiqueta() })
    expect(sinNada.response.status).toBe(403)
    const [cortesia, aprobacion] = [await token('orders:comp'), await token('tpv-orders:discount')]
    const { response } = await vender('cajera', { items, ...etiqueta() }, { 'x-permission-override': `${cortesia},${aprobacion}` })
    expect(response.status).toBe(201)
    for (const t of [cortesia, aprobacion]) {
      expect((await prisma.permissionOverride.findUniqueOrThrow({ where: { token: t } })).consumedAt).not.toBeNull()
    }
  })
})
