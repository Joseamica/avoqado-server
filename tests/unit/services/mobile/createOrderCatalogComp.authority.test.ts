import express from 'express'
import type { ErrorRequestHandler } from 'express'
import request from 'supertest'
import { Prisma } from '@prisma/client'
import { createOrder } from '@/controllers/mobile/order.mobile.controller'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { checkCortesiaPermissionIfPresent } from '@/middlewares/cortesiaPidePermiso.middleware'
import { updateDiscount } from '@/services/dashboard/discount.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/services/venueSalesGuard', () => ({ assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/services/kds/kitchenDisplayStations', () => ({
  assertPreparationAuthoringAccess: jest.fn(),
  debeMarcarCocina: jest.fn(),
}))
jest.mock('@/services/shared/repartoDescuentoTx', () => ({
  ...jest.requireActual('@/services/shared/repartoDescuentoTx'),
  sincronizarRepartos: jest.fn(),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

const venueId = 'cmn3acoxt000mn227k1vdgj95'
const staffId = 'cmn3a6xr8000kn227eg8zeh42'
const productId = 'cmn3a6xr8000kn227eg8zeh41'
const discountId = 'cmn3a6xr8000kn227eg8zeh50'
const D = (value: number) => new Prisma.Decimal(value)
type Target = 'order' | 'item'

describe('R1 — el tipo de descuento que realmente se aplica exige su autoridad', () => {
  let catalog: any
  let stored: any
  let canComp: boolean
  let changeToComp: boolean
  let trace: string[]

  beforeEach(() => {
    jest.clearAllMocks()
    canComp = false
    changeToComp = true
    stored = null
    trace = []
    catalog = { id: discountId, venueId, name: 'Rebaja', type: 'FIXED_AMOUNT', value: D(10), active: true, scope: 'ORDER' }
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    prismaMock.$queryRaw.mockResolvedValue([])
    prismaMock.staff.findUnique.mockResolvedValue({ id: staffId, active: true })
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null)
    prismaMock.staffVenue.findUnique.mockImplementation(async () => ({
      id: 'cmn3a6xr8000kn227eg8zeh44',
      role: canComp ? 'MANAGER' : 'CASHIER',
      active: true,
      permissionSetId: 'cmn3a6xr8000kn227eg8zeh45',
      permissionSet: { permissions: ['orders:create', ...(canComp ? ['orders:comp'] : [])] },
      staff: { active: true },
    }))
    prismaMock.staffVenue.findFirst.mockImplementation(async ({ where }: any) =>
      where.role === 'SUPERADMIN' ? null : { id: 'cmn3a6xr8000kn227eg8zeh44', staffId: where.staffId, venueId, active: true },
    )
    prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
    prismaMock.venueSettings.findUnique.mockResolvedValue(null)
    prismaMock.product.findMany.mockResolvedValue([
      { id: productId, name: 'Prenda', price: D(100), soldByWeight: false, categoryId: null, category: { name: 'Ropa' } },
    ])
    prismaMock.modifier.findMany.mockResolvedValue([])
    prismaMock.shift.findFirst.mockResolvedValue(null)
    prismaMock.order.findUnique.mockImplementation(async () => stored)
    prismaMock.discount.findFirst.mockImplementation(async ({ where }: any) => {
      if (where.type === 'COMP') {
        trace.push(`middleware:${catalog.type}`)
        return catalog.type === 'COMP' && where.id.in.includes(catalog.id) ? { id: catalog.id } : null
      }
      trace.push(`read:${catalog.type}`)
      return where.id === catalog.id && where.venueId === venueId ? { ...catalog } : null
    })
    prismaMock.discount.findMany.mockImplementation(async ({ where }: any) => {
      trace.push(`items:${catalog.type}`)
      return where.venueId === venueId && where.id.in.includes(catalog.id) ? [{ ...catalog }] : []
    })
    prismaMock.discount.update.mockImplementation(async ({ data }: any) => {
      Object.assign(catalog, data)
      trace.push(`update:${catalog.type}`)
      return { ...catalog }
    })
    prismaMock.order.create.mockImplementation(async ({ data }: any) => {
      stored = {
        ...data,
        id: 'cmn3a6xr8000kn227eg8zeh43',
        createdAt: new Date(),
        items: data.items.create.map((row: any) => ({ ...row, id: 'cmn3a6xr8000kn227eg8zeh46', modifiers: [], product: null })),
        promotions: [],
      }
      return stored
    })
  })

  function body(target: Target, replay = false) {
    return {
      staffId,
      items: [{ productId, quantity: 1, ...(target === 'item' ? { discountId } : {}) }],
      ...(target === 'order' ? { orderDiscountId: discountId } : {}),
      isOfflineReplay: replay,
      // Un cliente no puede fabricar la autoridad ni el actor del escritor.
      canCompItems: true,
      performedBy: 'cmn3a6xr8000kn227eg8zeh47',
    }
  }

  function app() {
    const server = express()
    server.use(express.json())
    server.post(
      '/mobile/venues/:venueId/orders',
      (req, _res, next) => {
        req.authContext = { userId: staffId, orgId: 'cmn3a6xr8000kn227eg8zeh48', venueId, role: canComp ? 'MANAGER' : 'CASHIER' } as any
        next()
      },
      checkPermission('orders:create'),
      checkCortesiaPermissionIfPresent,
      async (_req, _res, next) => {
        try {
          // Intercalado determinista del escritor ADMIN real, tras la prelectura y antes del escritor de la venta real.
          if (changeToComp) await updateDiscount(venueId, discountId, { type: 'COMP' } as any)
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
    server.use(errors)
    return server
  }

  it.each([
    { target: 'order' as const, replay: false },
    { target: 'item' as const, replay: false },
    { target: 'order' as const, replay: true },
    { target: 'item' as const, replay: true },
  ])('FIXED→COMP tras middleware, $target replay=$replay: 403 sin escribir venta/descuento/pago', async ({ target, replay }) => {
    catalog.scope = target === 'order' ? 'ORDER' : 'ITEM'
    const response = await request(app()).post(`/mobile/venues/${venueId}/orders`).send(body(target, replay))

    expect(trace[0]).toBe('middleware:FIXED_AMOUNT')
    expect(trace).toContain('update:COMP')
    expect(trace[trace.length - 1]).toBe(target === 'order' ? 'read:COMP' : 'items:COMP')
    expect({
      status: response.status,
      orders: prismaMock.order.create.mock.calls.length,
      discounts: prismaMock.orderDiscount.create.mock.calls.length,
      payments: prismaMock.payment.create.mock.calls.length,
      unauthorizedTotal: response.status === 201 ? response.body.order?.total : null,
    }).toEqual({ status: 403, orders: 0, discounts: 0, payments: 0, unauthorizedTotal: null })
  })

  it.each(['order', 'item'] as const)('control: el descuento FIXED normal de %s sigue disponible al cajero', async target => {
    catalog.scope = target === 'order' ? 'ORDER' : 'ITEM'
    changeToComp = false
    const response = await request(app()).post(`/mobile/venues/${venueId}/orders`).send(body(target))
    expect(response.status).toBe(201)
    expect(response.body.order).toMatchObject({ total: 90, discountAmount: 10 })
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.orderDiscount.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it.each([
    { target: 'order' as const, changes: false },
    { target: 'item' as const, changes: false },
    { target: 'order' as const, changes: true },
    { target: 'item' as const, changes: true },
  ])('control: COMP de $target con permiso de gerente, cambia=$changes, conserva su autorización', async ({ target, changes }) => {
    catalog.scope = target === 'order' ? 'ORDER' : 'ITEM'
    catalog.type = changes ? 'FIXED_AMOUNT' : 'COMP'
    canComp = true
    changeToComp = changes
    const response = await request(app()).post(`/mobile/venues/${venueId}/orders`).send(body(target))
    expect(response.status).toBe(201)
    expect(response.body.order).toMatchObject({ total: 0, discountAmount: 100 })
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.orderDiscount.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })
})
