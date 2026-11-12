/**
 * Descuento del cliente, fase 2 (Task 3) — HTTP por las rutas REALES de `/mobile` (`POST /orders` y `gift-cards/pay-new-order`), con
 * sus validadores, `checkPermission`, los candados de cortesía y de promociones, el controlador y el servicio contra PostgreSQL REAL.
 * Sólo la identidad viene de cabeceras de prueba (`x-test-actor`); los transportes (Socket.IO, Wallet, correo) son dobles.
 *
 * La regla (spec B6): el descuento del cliente es un descuento manual ya llenado. Pasa con `discounts:apply` propio (el token ni se
 * lee) o con el PIN del gerente atado a ese cliente y descuento y con tope ≥ el monto (en el CUERPO, leído sin gastar). Si no, 403 con
 * el texto fijo y no se escribe nada. El PIN no autoriza promociones ni regalar la cuenta.
 *
 * Correr (base desechable de la nube; nunca av-db-25):
 *   cd /Users/amieva/Documents/Programming/Avoqado && AVQ_TREE=avoqado-server/.claude/worktrees/descuento-del-cliente-f2 \
 *     ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects=integration --runInBand \
 *     --runTestsByPath tests/integration/mobile/descuentoDelCliente.mostrador.integration.test.ts --ci
 */
import cuid = require('cuid')
import type { NextFunction, Request, Response } from 'express'
import { Prisma } from '@prisma/client'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
  broadcastTpvStatusUpdate: jest.fn(),
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))
jest.mock('@/services/mobile/avisoDeVentaSinRed', () => ({
  ...jest.requireActual('@/services/mobile/avisoDeVentaSinRed'),
  avisarVentaSinRed: jest.fn().mockResolvedValue(undefined),
}))
// La bitácora REAL (el setup de integración la simula para todas las suites): `DISCOUNT_APPLIED` es lo que se mira.
jest.mock('@/services/dashboard/activity-log.service', () => jest.requireActual('@/services/dashboard/activity-log.service'))
// La identidad del token: quién (`x-test-actor`). Permisos, validadores y servicios son los reales.
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: Request, res: Response, next: NextFunction) => {
    const actorId = req.get('x-test-actor')
    if (!actorId) return res.status(401).json({ success: false, message: 'Autenticación requerida' })
    Object.assign(req, { authContext: { userId: actorId, venueId: req.params.venueId, orgId: req.params.venueId, role: 'CASHIER' } })
    next()
  },
}))
jest.mock('@/middlewares/registerDevice.middleware', () => ({
  registerDeviceMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  capturarVenueDeLaRuta: (_req: Request, _res: Response, next: NextFunction) => next(),
}))

import prisma from '@/utils/prismaClient'
import { encryptGiftCardCode, generateGiftCardCode, generateOpaqueToken, hashGiftCardCode } from '@/services/giftCards/giftCardCode'
import { ensureGiftCardTender } from '@/services/giftCards/giftCardTender'
import { limpiarNegocioDePrueba } from '../giftCards/sembrarTarjetasDeRegalo'

require('express-async-errors')
const express = require('express') as typeof import('express')
const request = require('supertest') as typeof import('supertest')
const mobileRouter = (require('@/routes/mobile.routes') as typeof import('@/routes/mobile.routes')).default
const app = express()
app.use(express.json())
app.use('/api/v1/mobile', mobileRouter)
app.use((error: { statusCode?: number; message?: string; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
  res.status(error.statusCode ?? 500).json({ success: false, message: error.message, code: error.code })
})

jest.setTimeout(120_000)

const COPY = 'Tu puesto no puede aplicar el descuento de Cecilia López. Pide autorización o quítalo.'
const D = (v: number) => new Prisma.Decimal(v)
const suffix = cuid()
let organizationId: string
let venueId: string
let cajeraId: string
let cajeraVenueId: string
let gerenteId: string
let gerenteVenueId: string
let productId: string
let ceciliaId: string
let discountId: string
let otroClienteId: string
let otroDescuentoId: string

beforeAll(async () => {
  organizationId = (await prisma.organization.create({ data: { name: `DC ${suffix}`, email: `${suffix}@org.test`, phone: '5555555555' } }))
    .id
  venueId = (
    await prisma.venue.create({
      data: { organizationId, name: `DC ${suffix}`, slug: `dc-${suffix}`, type: 'RETAIL_STORE', seatCapExempt: true },
    })
  ).id
  await prisma.venueSettings.create({ data: { venueId, managerPinOverrideEnabled: true } })
  await prisma.giftCardSettings.create({ data: { venueId, enabled: true, suggestedAmounts: [500, 1000] } })
  await ensureGiftCardTender(prisma, venueId)
  // Permisos efectivos reales: la cajera vende y cobra con saldo, pero no aplica descuentos ni regala; el gerente sí.
  const persona = async (nombre: string, permissions: string[], role: 'CASHIER' | 'MANAGER') => {
    const staffId = (
      await prisma.staff.create({ data: { email: `${nombre}-${suffix}@staff.test`, firstName: nombre, lastName: 'QA', active: true } })
    ).id
    const set = await prisma.permissionSet.create({ data: { venueId, name: `DC ${nombre}`, permissions } })
    const staffVenueId = (await prisma.staffVenue.create({ data: { venueId, staffId, role, active: true, permissionSetId: set.id } })).id
    return { staffId, staffVenueId }
  }
  ;({ staffId: cajeraId, staffVenueId: cajeraVenueId } = await persona('Cajera', ['orders:create', 'giftCards:redeem'], 'CASHIER'))
  ;({ staffId: gerenteId, staffVenueId: gerenteVenueId } = await persona(
    'Gerente',
    ['orders:create', 'giftCards:redeem', 'discounts:apply', 'orders:comp'],
    'MANAGER',
  ))
  const categoryId = (await prisma.menuCategory.create({ data: { venueId, name: 'Ropa', slug: `ropa-${suffix}` } })).id
  productId = (
    await prisma.product.create({
      data: { venueId, categoryId, sku: cuid(), name: 'Playera DC', type: 'REGULAR', price: D(100) },
    })
  ).id
  ceciliaId = (await prisma.customer.create({ data: { venueId, firstName: 'Cecilia', lastName: 'López' } })).id
  otroClienteId = (await prisma.customer.create({ data: { venueId, firstName: 'Ernesto', lastName: 'Ruiz' } })).id
  discountId = (
    await prisma.discount.create({ data: { venueId, name: 'Cliente frecuente', type: 'PERCENTAGE', value: D(10), scope: 'ORDER' } })
  ).id
  otroDescuentoId = (
    await prisma.discount.create({ data: { venueId, name: 'Empleados', type: 'PERCENTAGE', value: D(20), scope: 'ORDER' } })
  ).id
  for (const id of [organizationId, venueId, cajeraId, gerenteId, productId, ceciliaId, discountId]) expect(id).toMatch(/^c[a-z0-9]{24}$/)
})

afterAll(async () => {
  if (!venueId) return
  await limpiarNegocioDePrueba(venueId)
})

/**
 * El PIN de un gerente para Cecilia y su descuento: `tope` en centavos (`null` = la llave de la fase 1, sin tope). `para` lo emite para
 * OTRO cliente u OTRO descuento (la llave es de ellos; la venta sigue siendo de Cecilia con su descuento).
 */
async function pin(
  tope: number | null,
  opciones: { vencido?: boolean; para?: { customerId?: string; discountId?: string } } = {},
): Promise<string> {
  const token = cuid()
  await prisma.permissionOverride.create({
    data: {
      venueId,
      token,
      permission: 'discounts:apply',
      authorizedById: gerenteVenueId,
      operationKey: `descuento-cliente:${opciones.para?.customerId ?? ceciliaId}:${opciones.para?.discountId ?? discountId}${
        tope === null ? '' : `:${tope}`
      }`,
      expiresAt: new Date(Date.now() + (opciones.vencido ? -60_000 : 7 * 86_400_000)),
    },
  })
  return token
}

/** La etiqueta y su `discount` (mismo monto, centavos). */
const monto = (cents: number) => ({ discount: cents, descuentoDelCliente: { discountId, montoCents: cents } })

/** Una playera de $100 con el descuento de Cecilia ($10.00 si no se dice otro monto). */
const cuerpo = (actor: string, extra: Record<string, unknown> = {}) => ({
  staffId: actor,
  source: 'AVOQADO_ANDROID',
  orderType: 'TAKEOUT',
  items: [{ productId, quantity: 1, externalId: cuid() }],
  customerId: ceciliaId,
  ...monto(1000),
  ...extra,
})

/** Un premio de sellos de $20 listo para canjear, de Cecilia. */
async function premioDeCecilia() {
  const card = await prisma.stampCard.create({
    data: {
      customerId: ceciliaId,
      venueId,
      cycle: Math.floor(Math.random() * 1e9),
      stampsRequired: 1,
      stampsEarned: 1,
      completedAt: new Date(),
    },
  })
  return (
    await prisma.stampReward.create({
      data: {
        stampCardId: card.id,
        customerId: ceciliaId,
        venueId,
        rewardType: 'FIXED_AMOUNT',
        rewardValue: 20,
        rewardLabel: 'Café gratis',
      },
    })
  ).id
}

const ruta = (r: string) => `/api/v1/mobile/venues/${venueId}${r}`

async function crearOrden(actor: string, extra: Record<string, unknown> = {}) {
  const externalId = cuid()
  const response = await request(app)
    .post(ruta('/orders'))
    .set({ 'x-test-actor': actor })
    .send({ ...cuerpo(actor, extra), externalId })
  return { response, ...(await loQueQuedo(externalId)) }
}

async function loQueQuedo(externalId: string) {
  const order = await prisma.order.findUnique({ where: { venueId_externalId: { venueId, externalId } } })
  const filas = order ? await prisma.orderDiscount.findMany({ where: { orderId: order.id }, take: 10 }) : []
  return { order, fila: filas[0] ?? null, filas }
}

/** `logAction` no se espera (`void`): se busca su fila unos instantes. */
async function bitacoraDe(orderId: string) {
  for (let i = 0; i < 60; i++) {
    const fila = await prisma.activityLog.findFirst({ where: { venueId, action: 'DISCOUNT_APPLIED', entityId: orderId } })
    if (fila) return fila
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return null
}

/** Una tarjeta de regalo ACTIVE con su ACTIVATE (saldo = la libreta). */
async function tarjeta(pesos: number) {
  const c = generateGiftCardCode()
  const sobre = await prisma.giftCard.create({
    data: {
      venueId,
      organizationId,
      codeHash: hashGiftCardCode(c.normalized),
      codeEnc: encryptGiftCardCode(c.normalized),
      codeLast4: c.last4,
      pageToken: generateOpaqueToken(),
      initialAmount: D(pesos),
      balance: D(pesos),
      status: 'ACTIVE',
      activatedAt: new Date(),
      termsVersion: '2026-10-14',
      deliveryChannel: 'PRINTED',
    },
  })
  await prisma.giftCardActivity.create({
    data: { giftCardId: sobre.id, venueId, type: 'ACTIVATE', amount: D(pesos), balanceAfter: D(pesos) },
  })
  return { id: sobre.id, codigo: c.display }
}

const saldoDe = async (id: string) => Number((await prisma.giftCard.findUniqueOrThrow({ where: { id } })).balance)

async function pagarConSaldo(actor: string, codigo: string, pesos: number, extra: Record<string, unknown> = {}) {
  const llave = `dc-${cuid()}`.slice(0, 40)
  const response = await request(app)
    .post(ruta('/gift-cards/pay-new-order'))
    .set({ 'x-test-actor': actor })
    .send({ ...cuerpo(actor, extra), idempotencyKey: llave, proof: { kind: 'CODE', code: codigo }, amount: pesos, tip: 0 })
  return { response, ...(await loQueQuedo(`giftpay:${llave}`)) }
}

describe('POST /orders con el descuento del cliente', () => {
  it('3a · con discounts:apply propio: 100/10/90, fila etiquetada y DISCOUNT_APPLIED', async () => {
    const r = await crearOrden(gerenteId)
    expect(r.response.status).toBe(201)
    expect([Number(r.order!.subtotal), Number(r.order!.discountAmount), Number(r.order!.total)]).toEqual([100, 10, 90])
    expect(r.filas).toHaveLength(1)
    expect(r.fila).toMatchObject({
      type: 'FIXED_AMOUNT',
      discountId,
      name: 'Cliente frecuente',
      isAutomatic: true,
      isManual: false,
      appliedById: gerenteVenueId,
      authorizedById: null,
    })
    expect(Number(r.fila!.amount)).toBe(10)
    const log = await bitacoraDe(r.order!.id)
    expect(log).toMatchObject({ staffId: gerenteId, entity: 'Order' })
    expect(log!.data).toMatchObject({ amount: 10, discountId, customerId: ceciliaId, descuentoDelCliente: true })
    expect(log!.data).not.toHaveProperty('fueraDeTarifa')
  })

  it('3b · sin permiso, PIN con tope 1000 y monto 1000: se crea con el gerente; el PIN no se gasta', async () => {
    const t = await pin(1000)
    const r = await crearOrden(cajeraId, { autorizacionDelDescuento: t })
    expect(r.response.status).toBe(201)
    expect(r.fila).toMatchObject({ authorizedById: gerenteVenueId, appliedById: cajeraVenueId, isAutomatic: true })
    expect((await bitacoraDe(r.order!.id))!.data).toMatchObject({ autorizadoPor: gerenteVenueId })
    expect((await prisma.permissionOverride.findUniqueOrThrow({ where: { token: t } })).consumedAt).toBeNull()
    // 3i: el mismo PIN sirve a otra venta acotada a su tope.
    const otra = await crearOrden(cajeraId, { autorizacionDelDescuento: t, ...monto(500) })
    expect(otra.response.status).toBe(201)
  })

  it('🔴 3c · sin permiso, PIN con tope 1000 y monto 9000: 403 con el texto y no se escribe nada', async () => {
    const t = await pin(1000)
    const r = await crearOrden(cajeraId, { autorizacionDelDescuento: t, ...monto(9000) })
    expect(r.response.status).toBe(403)
    expect(r.response.body).toMatchObject({ message: COPY, code: 'DESCUENTO_DEL_CLIENTE_SIN_AUTORIZACION' })
    expect(r.order).toBeNull()
  })

  it('3d · desde la cola (isOfflineReplay): PIN suficiente pasa; monto mayor que el tope ⇒ 403 y nada', async () => {
    const t = await pin(1000)
    const pasa = await crearOrden(cajeraId, { autorizacionDelDescuento: t, isOfflineReplay: true })
    expect(pasa.response.status).toBe(201)
    expect(pasa.fila).toMatchObject({ authorizedById: gerenteVenueId, isAutomatic: true })
    const rebasa = await crearOrden(cajeraId, { autorizacionDelDescuento: t, isOfflineReplay: true, ...monto(1001) })
    expect(rebasa.response.status).toBe(403)
    expect(rebasa.response.body.message).toBe(COPY)
    expect(rebasa.order).toBeNull()
  })

  it('🔴 3e · sin permiso y sin PIN: 403 en el guard con el texto fijo', async () => {
    const r = await crearOrden(cajeraId)
    expect(r.response.status).toBe(403)
    expect(r.response.body).toMatchObject({ message: COPY, code: 'DESCUENTO_DEL_CLIENTE_SIN_AUTORIZACION' })
    expect(r.order).toBeNull()
  })

  it.each([
    ['vencido', () => pin(1000, { vencido: true })],
    ['de la fase 1, sin tope', () => pin(null)],
    ['emitido para OTRO cliente', () => pin(1000, { para: { customerId: otroClienteId } })],
    ['emitido para OTRO descuento', () => pin(1000, { para: { discountId: otroDescuentoId } })],
  ])('🔴 3i · sin permiso y con un PIN %s ⇒ 403', async (_caso, hacer) => {
    const r = await crearOrden(cajeraId, { autorizacionDelDescuento: await hacer() })
    expect(r.response.status).toBe(403)
    expect(r.order).toBeNull()
  })

  it.each([
    ['vencido', () => pin(1000, { vencido: true })],
    ['con tope menor', () => pin(100)],
  ])('🔴 3k · con discounts:apply propio y un PIN %s: pasa (el permiso manda) y sin autorizador', async (_caso, hacer) => {
    const r = await crearOrden(gerenteId, { autorizacionDelDescuento: await hacer() })
    expect(r.response.status).toBe(201)
    expect(r.fila).toMatchObject({ isAutomatic: true, authorizedById: null })
  })

  it('3j · con permiso propio y monto mayor que la tarifa: se crea igual y la bitácora dice fueraDeTarifa', async () => {
    const r = await crearOrden(gerenteId, monto(1500))
    expect(r.response.status).toBe(201)
    expect(Number(r.order!.discountAmount)).toBe(15)
    expect((await bitacoraDe(r.order!.id))!.data).toMatchObject({ amount: 15, fueraDeTarifa: true })
  })

  it('🔴 3l · etiqueta + PIN válido + una promoción, sin discounts:apply: 403 de la promoción (el PIN no la autoriza)', async () => {
    const t = await pin(1000)
    const r = await crearOrden(cajeraId, {
      autorizacionDelDescuento: t,
      items: [{ promotionRef: { promotionId: cuid(), promotionInstanceId: cuid(), selections: [] } }],
    })
    expect(r.response.status).toBe(403)
    expect(r.response.body).toMatchObject({ required: 'discounts:apply' })
    expect(r.order).toBeNull()
  })

  it('🔴 3l · etiqueta + PIN válido que deja la cuenta en $0, sin orders:comp, en línea: la regla de regalo (403 de orders:comp)', async () => {
    const t = await pin(10000)
    const r = await crearOrden(cajeraId, { autorizacionDelDescuento: t, cortesiaDeCuentaConPin: true, ...monto(10000) })
    expect(r.response.status).toBe(403)
    expect(r.response.body).toMatchObject({ required: 'orders:comp' })
    expect(r.order).toBeNull()
  })

  it('🔴 3l · lo mismo desde la cola: se registra como regalo sin permiso, con bitácora en la transacción', async () => {
    const t = await pin(10000)
    const externalId = cuid()
    const response = await request(app)
      .post(ruta('/orders'))
      .set({ 'x-test-actor': cajeraId })
      .send({ ...cuerpo(cajeraId, { autorizacionDelDescuento: t, isOfflineReplay: true, ...monto(10000) }), externalId })
    expect(response.status).toBe(201)
    const { order, fila } = await loQueQuedo(externalId)
    expect(Number(order!.total)).toBe(0)
    expect(fila).toMatchObject({ isAutomatic: true, authorizedById: gerenteVenueId })
    const regalo = await prisma.activityLog.findFirst({
      where: { venueId, action: 'VENTA_SIN_RED_DESCUENTO_SIN_PERMISO', entityId: externalId },
    })
    expect(regalo).not.toBeNull()
  })

  it('3h · sin etiqueta y sin permiso: el 403 canónico de discounts:apply de hoy', async () => {
    const r = await crearOrden(cajeraId, { descuentoDelCliente: undefined })
    expect(r.response.status).toBe(403)
    expect(r.response.body).toMatchObject({ required: 'discounts:apply' })
    expect(r.order).toBeNull()
  })

  it('🔴 3e · sin permiso y sin PIN, con la etiqueta mal armada: el 403 del candado sale ANTES que el 400 del cuerpo', async () => {
    const r = await crearOrden(cajeraId, { discount: 1000, descuentoDelCliente: { discountId, montoCents: 900 } })
    expect(r.response.status).toBe(403)
    expect(r.response.body).toMatchObject({ message: COPY, code: 'DESCUENTO_DEL_CLIENTE_SIN_AUTORIZACION' })
    expect(r.order).toBeNull()
  })

  it('🔴 etiqueta + premio de sellos ⇒ 400 y no se canjea ni se crea nada (Codex r5)', async () => {
    const premio = await premioDeCecilia()
    const r = await crearOrden(gerenteId, { stampRewardId: premio, stampRewardAware: true })
    expect(r.response.status).toBe(400)
    expect(r.order).toBeNull()
    expect((await prisma.stampReward.findUniqueOrThrow({ where: { id: premio } })).redeemedAt).toBeNull()
  })

  it('3f · montoCents distinto de discount ⇒ 400', async () => {
    const r = await crearOrden(gerenteId, { discount: 900 })
    expect(r.response.status).toBe(400)
    expect(r.order).toBeNull()
  })
})

describe('POST gift-cards/pay-new-order con el descuento del cliente (3m)', () => {
  it('con discounts:apply propio: la venta nace con $90 y el saldo baja $90; fila etiquetada', async () => {
    const t = await tarjeta(500)
    const r = await pagarConSaldo(gerenteId, t.codigo, 90)
    expect(r.response.status).toBe(200)
    expect(Number(r.order!.total)).toBe(90)
    expect(r.fila).toMatchObject({ discountId, isAutomatic: true, authorizedById: null, appliedById: gerenteVenueId })
    expect(await saldoDe(t.id)).toBe(410)
    expect((await bitacoraDe(r.order!.id))!.data).toMatchObject({ descuentoDelCliente: true, amount: 10 })
  })

  it('sin permiso con PIN suficiente: igual, y la fila lleva al gerente', async () => {
    const t = await tarjeta(500)
    const r = await pagarConSaldo(cajeraId, t.codigo, 90, { autorizacionDelDescuento: await pin(1000) })
    expect(r.response.status).toBe(200)
    expect(r.fila).toMatchObject({ isAutomatic: true, authorizedById: gerenteVenueId, appliedById: cajeraVenueId })
    expect(await saldoDe(t.id)).toBe(410)
  })

  it('🔴 etiqueta + premio de sellos ⇒ 400, saldo intacto y premio sin canjear (Codex r5)', async () => {
    const t = await tarjeta(500)
    const premio = await premioDeCecilia()
    const r = await pagarConSaldo(gerenteId, t.codigo, 90, { stampRewardId: premio, stampRewardAware: true })
    expect(r.response.status).toBe(400)
    expect(r.order).toBeNull()
    expect(await saldoDe(t.id)).toBe(500)
    expect((await prisma.stampReward.findUniqueOrThrow({ where: { id: premio } })).redeemedAt).toBeNull()
  })

  it('🔴 sin permiso con PIN de tope menor que el monto: 403 y el saldo intacto', async () => {
    const t = await tarjeta(500)
    const r = await pagarConSaldo(cajeraId, t.codigo, 10, { autorizacionDelDescuento: await pin(1000), ...monto(9000) })
    expect(r.response.status).toBe(403)
    expect(r.response.body.message).toBe(COPY)
    expect(r.order).toBeNull()
    expect(await saldoDe(t.id)).toBe(500)
  })

  it('🔴 3e · sin permiso y sin PIN, con un código que no existe: 403 del candado (no el 404 de la tarjeta)', async () => {
    const r = await pagarConSaldo(cajeraId, generateGiftCardCode().display, 90)
    expect(r.response.status).toBe(403)
    expect(r.response.body).toMatchObject({ message: COPY, code: 'DESCUENTO_DEL_CLIENTE_SIN_AUTORIZACION' })
    expect(r.order).toBeNull()
  })

  it('🔴 3e · sin permiso y sin PIN: 403 en el guard y el saldo intacto', async () => {
    const t = await tarjeta(500)
    const r = await pagarConSaldo(cajeraId, t.codigo, 90)
    expect(r.response.status).toBe(403)
    expect(r.response.body).toMatchObject({ message: COPY, code: 'DESCUENTO_DEL_CLIENTE_SIN_AUTORIZACION' })
    expect(r.order).toBeNull()
    expect(await saldoDe(t.id)).toBe(500)
  })
})
