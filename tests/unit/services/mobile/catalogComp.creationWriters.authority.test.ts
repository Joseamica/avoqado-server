import express from 'express'
import type { ErrorRequestHandler } from 'express'
import request from 'supertest'
import { Prisma } from '@prisma/client'
import { buildAreaTicketCode } from '@/lib/areaTicketCode'
import { canonicalSnapshotHash } from '@/services/mobile/areaTicketV7.mobile.service'
import { updateDiscount } from '@/services/dashboard/discount.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'

let mockCanComp = false
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    req.authContext = {
      userId: 'cmn3a6xr8000kn227eg8zeh42',
      orgId: 'cmn3a6xr8000kn227eg8zeh48',
      venueId: 'cmn3acoxt000mn227k1vdgj95',
      role: mockCanComp ? 'MANAGER' : 'CASHIER',
    }
    next()
  },
}))
jest.mock('@/services/venueSalesGuard', () => ({ assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkFeatureAccess.middleware'),
  checkFeatureAccess: () => (_req: any, _res: any, next: any) => next(),
}))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))
jest.mock('@/services/kds/kitchenDisplayStations', () => ({
  assertPreparationAuthoringAccess: jest.fn(),
  debeMarcarCocina: jest.fn().mockResolvedValue(false),
}))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({ armarComandasTrasCommit: jest.fn() }))
jest.mock('@/services/shared/repartoDescuentoTx', () => ({
  ...jest.requireActual('@/services/shared/repartoDescuentoTx'),
  sincronizarRepartos: jest.fn().mockResolvedValue({ impuestoDevuelto: new (jest.requireActual('@prisma/client').Prisma.Decimal)(0) }),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

import mobileRouter from '@/routes/mobile.routes'
import tpvRouter from '@/routes/tpv.routes'

const venueId = 'cmn3acoxt000mn227k1vdgj95'
const actorId = 'cmn3a6xr8000kn227eg8zeh42'
const sellerId = 'cmn3a6xr8000kn227eg8zeh47'
const productId = 'cmn3a6xr8000kn227eg8zeh41'
const discountId = 'cmn3a6xr8000kn227eg8zeh50'
const orderId = 'cmn3a6xr8000kn227eg8zeh43'
const areaId = 'cmn3a6xr8000kn227eg8zeh49'
const sessionId = 'cmn3a6xr8000kn227eg8zeh51'
const ticketId = 'cmn3a6xr8000kn227eg8zeh52'
const code = buildAreaTicketCode(47, 12)
const D = (n: number) => new Prisma.Decimal(n)
type Mode = 'mobile-custom' | 'tpv-order' | 'tpv-item' | 'tpv-custom' | 'legacy-open' | 'legacy-add' | 'v7-issue' | 'v7-materialize'
const modes: Mode[] = ['mobile-custom', 'tpv-order', 'tpv-item', 'tpv-custom', 'legacy-open', 'legacy-add', 'v7-issue', 'v7-materialize']
const api = express()
api.use(express.json())
api.use('/mobile', mobileRouter)
api.use('/tpv', tpvRouter)
const errors: ErrorRequestHandler = (error, _req, res, _next) => {
  res.status(error.statusCode ?? 500).json({ message: error.message })
}
api.use(errors)

describe('R1 — todos los escritores de creación que consumen Discount mutable', () => {
  let mode: Mode
  let catalog: any
  let order: any
  let rows: any[]
  let discounts: any[]
  let ticket: any
  let session: any
  let mutateAtDiscountRead: boolean
  let trace: string[]
  let sequence: number
  const nextId = () => `cmn3a6xr8000kn227eg8zeh${String(++sequence).padStart(2, '0')}`

  function orderRow(extra: Record<string, unknown> = {}) {
    return {
      id: orderId,
      venueId,
      orderNumber: 'ORD-R1',
      status: 'CONFIRMED',
      paymentStatus: 'PENDING',
      contratoDePrecio: 'IVA_INCLUIDO',
      subtotal: D(0),
      discountAmount: D(0),
      taxAmount: D(0),
      serviceChargeAmount: D(0),
      tipAmount: D(0),
      total: D(0),
      paidAmount: D(0),
      remainingBalance: D(0),
      version: 1,
      createdAt: new Date(),
      claimedAt: null,
      claimedByTerminalId: null,
      areaTicketCode: code,
      items: rows,
      table: null,
      payments: [],
      orderCustomers: [],
      promotions: [],
      fulfillments: [],
      ...extra,
    }
  }

  function storedItem(data: any) {
    return {
      ...data,
      id: nextId(),
      orderId,
      product: null,
      modifiers: (data.modifiers?.create ?? []).map((m: any) => ({ ...m, modifier: null })),
      paymentAllocations: [],
    }
  }

  // La foto de un vale previo de $30 es la misma forma que areaTicketV7.vale-revendido.test.ts; el hash lo calcula el helper REAL.
  function priorTicket() {
    const now = new Date()
    const line = {
      id: nextId(),
      clientLineId: 'prior-line',
      productId,
      productNameSnapshot: 'Prenda',
      skuSnapshot: null,
      categoryNameSnapshot: null,
      modifiersSnapshot: [],
      quantity: D(1),
      weightKg: null,
      unitPrice: D(30),
      discountAmount: D(0),
      appliedDiscountId: null,
      taxAmount: D(0),
      total: D(30),
      notes: null,
      createdAt: now,
    }
    return {
      id: ticketId,
      code: '9696971106',
      status: 'CLAIMED',
      fulfillmentAreaId: areaId,
      fulfillmentModeSnapshot: 'HOLD_UNTIL_PAID',
      fulfillmentArea: { id: areaId, name: 'Área', fulfillmentMode: 'HOLD_UNTIL_PAID' },
      sourceTerminalId: 'terminal-issue',
      sourceTerminal: { id: 'terminal-issue', name: 'Área' },
      currency: 'MXN',
      subtotal: D(30),
      discountAmount: D(0),
      taxAmount: D(0),
      total: D(30),
      pricingSnapshotHash: canonicalSnapshotHash('MXN', [line as any]),
      printStatus: 'NOT_PRINTED',
      version: 1,
      issuedAt: now,
      printedAt: null,
      claimedAt: now,
      claimExpiresAt: new Date(now.getTime() + 60_000),
      paidAt: null,
      expiresAt: null,
      orderId: null,
      checkoutSessionId: sessionId,
      lines: [line],
      fulfillment: null,
      externalSettlement: null,
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockCanComp = false
    mode = 'mobile-custom'
    order = null
    rows = []
    discounts = []
    sequence = 60
    mutateAtDiscountRead = false
    trace = []
    catalog = { id: discountId, venueId, name: 'Rebaja', type: 'COMP', value: D(10), active: true, scope: 'ITEM', targetItemIds: [] }
    ticket = priorTicket()
    session = {
      id: sessionId,
      status: 'OPEN',
      terminalId: 'terminal-issue',
      terminal: { id: 'terminal-issue', name: 'Caja' },
      staffId: actorId,
      orderId: null,
      order: null,
      materializeIdempotencyKey: null,
      activePaymentAttemptId: null,
      version: 1,
      lastHeartbeatAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      tickets: [ticket],
      paymentAttempts: [],
    }
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    prismaMock.$queryRaw.mockResolvedValue([{ id: orderId }])
    prismaMock.staff.findUnique.mockResolvedValue({ active: true })
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null)
    prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
    prismaMock.venueSettings.findUnique.mockResolvedValue(null)
    prismaMock.staffVenue.findUnique.mockImplementation(async ({ where }: any) => {
      const manager = where.staffId_venueId.staffId === sellerId || mockCanComp
      return {
        id: nextId(),
        role: manager ? 'MANAGER' : 'CASHIER',
        active: true,
        staff: { id: where.staffId_venueId.staffId, active: true },
        permissionSetId: 'permission-set',
        permissionSet: {
          permissions: [
            'orders:create',
            'orders:update',
            'area-tickets:issue',
            'area-tickets:checkout',
            ...(manager ? ['orders:comp'] : []),
          ],
        },
      }
    })
    prismaMock.staffVenue.findFirst.mockImplementation(async ({ where }: any) =>
      where.role === 'SUPERADMIN' ? null : { id: nextId(), staffId: where.staffId, venueId, active: true },
    )
    prismaMock.product.findMany.mockResolvedValue([
      { id: productId, name: 'Prenda', price: D(100), categoryId: null, category: { name: 'Ropa' }, soldByWeight: false },
    ])
    prismaMock.product.findUnique.mockResolvedValue({ id: productId, trackInventory: false })
    prismaMock.modifier.findMany.mockResolvedValue([])
    prismaMock.shift.findFirst.mockResolvedValue(null)
    prismaMock.terminal.findFirst.mockResolvedValue({
      id: 'terminal-issue',
      name: 'Caja',
      partition: 47,
      areaTicketLastCounter: 11,
      fulfillmentAreaId: areaId,
      fulfillmentArea: { id: areaId, name: 'Área', active: true, fulfillmentMode: 'HOLD_UNTIL_PAID', settlementRoute: 'AVOQADO' },
      canIssueAreaTickets: true,
      canCheckoutAreaTickets: true,
      canDeliverAreaTickets: true,
      scaleProfile: null,
    })
    prismaMock.terminal.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.discount.findFirst.mockImplementation(async ({ where }: any) => {
      if (where.type === 'COMP') {
        trace.push(`precheck:${catalog.type}`)
        return catalog.type === 'COMP' && where.id.in.includes(discountId) ? { id: discountId } : null
      }
      trace.push(`read:${catalog.type}`)
      return { ...catalog }
    })
    prismaMock.discount.findMany.mockImplementation(async () => {
      if (mutateAtDiscountRead) {
        mutateAtDiscountRead = false
        await updateDiscount(venueId, discountId, { type: 'COMP' } as any)
      }
      trace.push(`writer:${catalog.type}`)
      return [{ ...catalog }]
    })
    prismaMock.discount.update.mockImplementation(async ({ data }: any) => {
      Object.assign(catalog, data)
      trace.push(`update:${catalog.type}`)
      return { ...catalog }
    })
    prismaMock.order.findUnique.mockImplementation(async () => order)
    prismaMock.order.findFirstOrThrow.mockImplementation(async () => order)
    prismaMock.order.findUniqueOrThrow.mockImplementation(async () => order)
    prismaMock.order.create.mockImplementation(async ({ data }: any) => {
      rows.push(...(data.items?.create ?? []).map(storedItem))
      order = orderRow({ ...data, items: rows })
      return order
    })
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.order.update.mockImplementation(async ({ data }: any) => Object.assign(order, data))
    prismaMock.orderItem.create.mockImplementation(async ({ data }: any) => {
      const row = storedItem(data)
      rows.push(row)
      return row
    })
    prismaMock.orderItem.findMany.mockImplementation(async () => rows)
    prismaMock.orderDiscount.create.mockImplementation(async ({ data }: any) => {
      const row = { id: nextId(), createdAt: new Date(), ...data }
      discounts.push(row)
      return row
    })
    prismaMock.orderDiscount.findMany.mockImplementation(async () => discounts)
    prismaMock.payment.create.mockImplementation(async ({ data }: any) => ({ id: nextId(), ...data }))
    prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'allocation' })
    prismaMock.venueAreaTicketSettings.findUnique.mockResolvedValue({
      enabled: true,
      allowMixedCart: true,
      inventoryReservationMode: 'NONE',
    })
    prismaMock.areaTicket.findUnique.mockResolvedValue(null)
    prismaMock.areaTicket.create.mockImplementation(async ({ data }: any) => {
      ticket = { ...ticket, ...data, status: 'ISSUED', lines: [] }
      return ticket
    })
    prismaMock.areaTicketLine.create.mockImplementation(async ({ data }: any) => {
      const row = { id: nextId(), createdAt: new Date(), ...data }
      ticket.lines.push(row)
      return row
    })
    prismaMock.areaTicket.findUniqueOrThrow.mockImplementation(async () => ticket)
    prismaMock.areaTicket.updateMany.mockImplementation(async ({ data }: any) => {
      Object.assign(ticket, data)
      return { count: 1 }
    })
    prismaMock.areaTicketCheckoutSession.findFirst.mockImplementation(async () => session)
    prismaMock.areaTicketCheckoutSession.findUniqueOrThrow.mockImplementation(async () => session)
    prismaMock.areaTicketCheckoutSession.updateMany.mockImplementation(async ({ data }: any) => {
      Object.assign(session, data, { order })
      return { count: 1 }
    })
  })

  function run(target: Mode, fixed = false) {
    mode = target
    const forged = { staffId: sellerId, canCompItems: true, performedBy: sellerId }
    const item = { productId, quantity: 1, discountId }
    const base = `/mobile/venues/${venueId}`
    catalog.scope = mode === 'tpv-order' ? 'ORDER' : 'ITEM'
    let url: string
    let body: any
    if (mode.startsWith('tpv-')) {
      const custom = mode === 'tpv-custom'
      const amount = fixed ? 10 : 100
      url = `/tpv/venues/${venueId}/orders/with-items`
      body = {
        ...forged,
        items: [
          {
            ...(custom ? { name: 'Servicio', unitPrice: 100 } : { productId }),
            quantity: 1,
            ...(mode !== 'tpv-order' ? { itemDiscountId: discountId } : {}),
          },
        ],
        ...(mode === 'tpv-order' ? { orderDiscountId: discountId } : {}),
        taxAmount: 0,
        tip: 0,
        subtotal: 100,
        discount: mode === 'tpv-order' ? amount : 0,
        total: 100 - amount,
      }
    } else if (mode === 'mobile-custom') {
      url = `${base}/orders`
      body = { ...forged, items: [{ name: 'Servicio', unitPrice: 10_000, quantity: 1, discountId }] }
    } else if (mode === 'legacy-open' || mode === 'legacy-add') {
      url = `${base}/area-tickets${mode === 'legacy-add' ? `/${code}/items` : ''}`
      body = { ...forged, code, items: [item] }
      if (mode === 'legacy-add') {
        rows.push({ id: nextId(), productId, quantity: 1, unitPrice: D(50), total: D(50), discountAmount: D(0), modifiers: [] })
        order = orderRow({ subtotal: D(50), total: D(50) })
      }
    } else if (mode === 'v7-issue') {
      url = `${base}/area-tickets`
      body = { ...forged, idempotencyKey: 'r1-issue', lines: [{ clientLineId: 'r1-line', productId, quantity: '1', discountId }] }
    } else {
      url = `${base}/area-ticket-checkouts/${sessionId}/materialize-order`
      body = { ...forged, idempotencyKey: 'r1-materialize', normalItems: [item] }
    }
    return request(api).post(url).set('X-Device-Id', 'r1-device').send(body)
  }

  function writes() {
    return {
      orders: prismaMock.order.create.mock.calls.length,
      orderUpdates: prismaMock.order.update.mock.calls.length + prismaMock.order.updateMany.mock.calls.length,
      items: prismaMock.orderItem.create.mock.calls.length,
      discounts: prismaMock.orderDiscount.create.mock.calls.length,
      payments: prismaMock.payment.create.mock.calls.length,
      tickets: prismaMock.areaTicket.create.mock.calls.length + prismaMock.areaTicket.updateMany.mock.calls.length,
      ticketLines: prismaMock.areaTicketLine.create.mock.calls.length,
      checkouts: prismaMock.areaTicketCheckoutSession.updateMany.mock.calls.length,
    }
  }

  it.each(modes)('%s: COMP sin permiso de la sesión no escribe aunque el vendedor/body digan gerente', async target => {
    // El escritor ADMIN cambia la fila antes de la lectura que calcula. Un precheck añadido a vales tampoco basta.
    catalog.type = 'FIXED_AMOUNT'
    mutateAtDiscountRead = true
    const response = await run(target)
    expect(trace).toContain('writer:COMP')
    expect({ status: response.status, ...writes() }).toEqual({
      status: 403,
      orders: 0,
      orderUpdates: 0,
      items: 0,
      discounts: 0,
      payments: 0,
      tickets: 0,
      ticketLines: 0,
      checkouts: 0,
    })
  })

  it.each(modes)('%s: gerente con COMP sigue aplicando su regla sin cambiar precios', async target => {
    mockCanComp = true
    const response = await run(target)
    expect(response.status).toBe(['legacy-add', 'v7-materialize'].includes(target) ? 200 : 201)
    const saved = target === 'v7-issue' ? ticket : order
    expect(Number(saved.discountAmount)).toBe(100)
    expect(Number(saved.total)).toBe(target === 'legacy-add' ? 50 : target === 'v7-materialize' ? 30 : 0)
    expect(trace).toContain('writer:COMP')
  })

  it.each(modes)('%s: FIXED sigue disponible sin orders:comp', async target => {
    catalog.type = 'FIXED_AMOUNT'
    const response = await run(target, true)
    expect(response.status).toBe(['legacy-add', 'v7-materialize'].includes(target) ? 200 : 201)
    const saved = target === 'v7-issue' ? ticket : order
    expect(Number(saved.discountAmount)).toBe(10)
    expect(Number(saved.total)).toBe(target === 'legacy-add' ? 140 : target === 'v7-materialize' ? 120 : 90)
    expect(trace).toContain('writer:FIXED_AMOUNT')
  })
})
