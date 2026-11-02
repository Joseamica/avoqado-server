/**
 * Propuesta R1: HTTP + checkPermission + middleware COMP + controlador/escritor + PostgreSQL REALES.
 * Aplicar como tests/integration/mobile/catalogCompAuthority.http.integration.test.ts.
 * Sólo se sustituyen transportes Socket.IO/wallet; no dinero, autorización, PIN, Prisma ni cálculo.
 * El runner crea y destruye SU base en finally; esta suite no limpia fixtures.
 */
import cuid = require('cuid')
import express from 'express'
import type { ErrorRequestHandler } from 'express'
import request from 'supertest'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createOrder } from '@/controllers/mobile/order.mobile.controller'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { checkCortesiaPermissionIfPresent, tieneCortesiaAutorizada } from '@/middlewares/cortesiaPidePermiso.middleware'
import { updateDiscount } from '@/services/dashboard/discount.dashboard.service'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
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
  throw new Error('R1 exige la MISMA base desechable local en TEST_DATABASE_URL y DATABASE_URL; nunca av-db-25 ni una QA existente.')
}

type Target = 'order' | 'item'
type Actor = 'cashier' | 'manager'
type Interleave = { before: string; after: string; compAuthorityBefore: boolean }
const suffix = cuid()
let organizationId: string
let venueId: string
let cashierId: string
let managerId: string
let productId: string
let inventoryId: string

beforeAll(async () => {
  const [db] = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`
  expect(db.name).toBe(decodeURIComponent(target.pathname.slice(1)))
  organizationId = (await prisma.organization.create({ data: { name: `R1 ${suffix}`, email: `${suffix}@org.test`, phone: '5555555555' } }))
    .id
  venueId = (
    await prisma.venue.create({
      data: { organizationId, name: `R1 ${suffix}`, slug: suffix, type: 'RETAIL_STORE', seatCapExempt: true },
    })
  ).id
  cashierId = (
    await prisma.staff.create({ data: { email: `${suffix}@cashier.test`, firstName: 'Caja', lastName: 'Sintética', active: true } })
  ).id
  managerId = (
    await prisma.staff.create({ data: { email: `${suffix}@manager.test`, firstName: 'Gerente', lastName: 'Sintético', active: true } })
  ).id
  // Permisos efectivos reales, acotados al contrato: el vendedor gerente no autoriza al cajero que inició la sesión.
  const cashierSet = await prisma.permissionSet.create({ data: { venueId, name: 'R1 Caja', permissions: ['orders:create'] } })
  const managerSet = await prisma.permissionSet.create({
    data: { venueId, name: 'R1 Gerente', permissions: ['orders:create', 'orders:comp'] },
  })
  const cashierVenue = await prisma.staffVenue.create({
    data: { venueId, staffId: cashierId, role: 'CASHIER', active: true, permissionSetId: cashierSet.id },
  })
  const managerVenue = await prisma.staffVenue.create({
    data: { venueId, staffId: managerId, role: 'MANAGER', active: true, permissionSetId: managerSet.id },
  })
  const category = await prisma.menuCategory.create({ data: { venueId, name: 'Artículos sintéticos', slug: suffix } })
  productId = (
    await prisma.product.create({
      data: {
        venueId,
        categoryId: category.id,
        sku: cuid(),
        name: 'Prenda sintética R1',
        type: 'REGULAR',
        price: new Prisma.Decimal(100),
        trackInventory: true,
        inventoryMethod: 'QUANTITY',
      },
    })
  ).id
  inventoryId = (await prisma.inventory.create({ data: { venueId, productId, currentStock: 20 } })).id
  for (const id of [
    organizationId,
    venueId,
    cashierId,
    managerId,
    cashierSet.id,
    managerSet.id,
    cashierVenue.id,
    managerVenue.id,
    category.id,
    productId,
    inventoryId,
  ]) {
    expect(id).toMatch(/^c[a-z0-9]{24}$/)
  }
})

// No deleteMany: todos los registros pertenecen a la base que el runner destruye en finally.
afterAll(async () => {
  await prisma.$disconnect()
})

async function footprint() {
  const [orders, discounts, items, payments, inventoryPostings, stock] = await Promise.all([
    prisma.order.count({ where: { venueId } }),
    prisma.orderDiscount.count({ where: { order: { venueId } } }),
    prisma.orderItem.count({ where: { order: { venueId } } }),
    prisma.payment.count({ where: { venueId } }),
    prisma.inventoryPosting.count({ where: { venueId } }),
    prisma.inventory.findUniqueOrThrow({ where: { id: inventoryId }, select: { currentStock: true } }),
  ])
  return { orders, discounts, items, payments, inventoryPostings, stock: stock.currentStock.toFixed(3) }
}

async function attempt(scope: Target, actor: Actor, replay: boolean, mutate: boolean) {
  const externalId = cuid()
  const lineKey = cuid()
  const discount = await prisma.discount.create({
    data: {
      venueId,
      name: `R1 ${externalId}`,
      type: 'FIXED_AMOUNT',
      value: new Prisma.Decimal(10),
      scope: scope === 'order' ? 'ORDER' : 'ITEM',
    },
  })
  for (const id of [externalId, lineKey, discount.id]) expect(id).toMatch(/^c[a-z0-9]{24}$/)
  const trace: Interleave[] = []
  const api = express()
  api.use(express.json())
  api.post(
    '/mobile/venues/:venueId/orders',
    (req, _res, next) => {
      // Sólo identidad de la autenticación: checkPermission vuelve a leer Staff/StaffVenue/PermissionSet REALES.
      req.authContext = {
        userId: actor === 'cashier' ? cashierId : managerId,
        orgId: organizationId,
        venueId,
        role: actor === 'cashier' ? 'CASHIER' : 'MANAGER',
      }
      next()
    },
    checkPermission('orders:create'),
    checkCortesiaPermissionIfPresent,
    async (req, _res, next) => {
      try {
        if (mutate) {
          const before = await prisma.discount.findUniqueOrThrow({ where: { id: discount.id } })
          const compAuthorityBefore = tieneCortesiaAutorizada(req)
          // Escritor ADMIN real y commit real, después del precheck HTTP y antes del controlador/transacción de venta.
          const after = await updateDiscount(venueId, discount.id, { type: 'COMP' })
          trace.push({ before: before.type, after: after.type, compAuthorityBefore })
        }
        next()
      } catch (error) {
        next(error)
      }
    },
    createOrder,
  )
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(error.statusCode ?? 500).json({ message: error.message })
  }
  api.use(errors)
  const before = await footprint()
  const response = await request(api)
    .post(`/mobile/venues/${venueId}/orders`)
    .send({
      staffId: managerId,
      canCompItems: true,
      performedBy: managerId,
      externalId,
      source: 'AVOQADO_ANDROID',
      orderType: 'TAKEOUT',
      isOfflineReplay: replay,
      ...(scope === 'order' ? { orderDiscountId: discount.id } : {}),
      items: [{ productId, quantity: 1, externalId: lineKey, ...(scope === 'item' ? { discountId: discount.id } : {}) }],
    })
  return { response, before, after: await footprint(), trace, externalId, discountId: discount.id }
}

describe('R1 — el tipo COMP realmente aplicado exige autoridad, HTTP y Postgres', () => {
  it.each([
    { scope: 'order' as const, replay: false },
    { scope: 'item' as const, replay: false },
    { scope: 'order' as const, replay: true },
    { scope: 'item' as const, replay: true },
  ])('$scope replay=$replay: FIXED→COMP no autoriza al cajero ni deja writes', async ({ scope, replay }) => {
    const r = await attempt(scope, 'cashier', replay, true)
    expect(r.trace).toEqual([{ before: 'FIXED_AMOUNT', after: 'COMP', compAuthorityBefore: false }])
    expect(r.response.status).toBe(403)
    expect(r.after).toEqual(r.before)
    expect(await prisma.order.count({ where: { venueId, externalId: r.externalId } })).toBe(0)
    expect(await prisma.orderDiscount.count({ where: { discountId: r.discountId } })).toBe(0)
    expect(await prisma.discount.findUniqueOrThrow({ where: { id: r.discountId } })).toMatchObject({ type: 'COMP', currentUses: 0 })
  })

  async function assertAccepted(r: Awaited<ReturnType<typeof attempt>>, scope: Target, isComp: boolean) {
    const expectedDiscount = isComp ? 100 : 10
    const expectedTotal = isComp ? 0 : 90
    expect(r.response.status).toBe(201)
    expect(r.response.body.order).toMatchObject({ total: expectedTotal, discountAmount: expectedDiscount })
    const order = await prisma.order.findUniqueOrThrow({ where: { venueId_externalId: { venueId, externalId: r.externalId } } })
    expect(order.id).toMatch(/^c[a-z0-9]{24}$/)
    expect([Number(order.subtotal), Number(order.discountAmount), Number(order.total), order.paymentStatus]).toEqual([
      100,
      expectedDiscount,
      expectedTotal,
      'PENDING',
    ])
    const row = await prisma.orderDiscount.findFirstOrThrow({ where: { orderId: order.id, discountId: r.discountId } })
    expect([row.type, Number(row.amount)]).toEqual([isComp ? 'COMP' : 'FIXED_AMOUNT', expectedDiscount])
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } })
    expect(Number(item.total)).toBe(100)
    expect(Number(item.discountAmount)).toBe(scope === 'item' ? expectedDiscount : 0)
    expect(item.appliedDiscountId).toBe(scope === 'item' ? r.discountId : null)
    expect(r.after).toEqual({ ...r.before, orders: r.before.orders + 1, discounts: r.before.discounts + 1, items: r.before.items + 1 })
    expect((await prisma.discount.findUniqueOrThrow({ where: { id: r.discountId } })).currentUses).toBe(1)
  }

  it.each(['order', 'item'] as const)(
    'control %s: gerente acreditado conserva COMP aunque el catálogo cambie tras precheck',
    async scope => {
      const r = await attempt(scope, 'manager', false, true)
      expect(r.trace).toEqual([{ before: 'FIXED_AMOUNT', after: 'COMP', compAuthorityBefore: false }])
      await assertAccepted(r, scope, true)
    },
  )

  it.each(['order', 'item'] as const)('control %s: FIXED de $10 sigue disponible al cajero', async scope => {
    const r = await attempt(scope, 'cashier', false, false)
    expect(r.trace).toEqual([])
    await assertAccepted(r, scope, false)
  })
})
