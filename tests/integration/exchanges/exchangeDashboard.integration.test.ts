import cuid from 'cuid'
import { Prisma, VenueType } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as dashboard from '@/services/dashboard/exchange.dashboard.service'
import { getOrderById } from '@/services/dashboard/order.dashboard.service'
import { getPayment } from '@/controllers/dashboard/payment.dashboard.controller'
import { getExchange } from '@/controllers/dashboard/exchange.dashboard.controller'
import { getVenueTpvSettings } from '@/controllers/mobile/tpvSettings.mobile.controller'
import { getVenueById } from '@/services/dashboard/venue.dashboard.service'
import { updateVenueSettings } from '@/services/dashboard/venueSettings.dashboard.service'
import { UpdateVenueSettingsSchema } from '@/schemas/dashboard/venueSettings.schema'
import { loadExchangeLinksForOrders } from '@/services/exchanges/exchangeDetail'
import { createExchange, completeExchange } from '@/services/exchanges/exchange.service'
import { seedClothingSale, seedCardSale } from './seedExchange'
import { clienteQueCuenta } from './contarConsultas'
import { registerExchangeTools } from '@/mcp/tools/exchanges'
import type { McpScope } from '@/mcp/scope'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.setTimeout(90000)
type Seed = Awaited<ReturnType<typeof seedClothingSale>>
let s: Seed
beforeAll(() => {
  expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toMatch(/^\/avoqado_(?:cambio_(?:fix_|r5_)?test_\d{8}|h1a_test_\d{8}(?:_\d+)?)$/)
})
beforeEach(async () => {
  s = await seedClothingSale()
})
afterEach(async () => {
  if (s?.venueId) await s.cleanup()
})
afterAll(async () => {
  await prisma.$disconnect()
})

async function row(overrides: Partial<Prisma.ExchangeUncheckedCreateInput> = {}) {
  const order = await prisma.order.create({
    data: { venueId: s.venueId, orderNumber: cuid(), type: 'TAKEOUT', subtotal: 0, taxAmount: 0, total: 0 },
  })
  return prisma.exchange.create({
    data: {
      venueId: s.venueId,
      idempotencyKey: cuid(),
      requestHash: 'dashboard',
      status: 'NEEDS_REVIEW',
      originalOrderId: s.order.id,
      originalPaymentId: s.payments[0].id,
      newOrderId: order.id,
      returnedAmount: 500,
      takenAmount: 550,
      differenceAmount: 50,
      settlementKind: 'COLLECT',
      settlementMethod: 'CARD_TERMINAL',
      lines: {},
      staffId: s.staffId,
      ...overrides,
    },
  })
}
async function http(handler: any, params: Record<string, string>) {
  let result: any
  const res = {
    status: jest.fn().mockReturnThis(),
    json: (value: unknown) => {
      result = JSON.parse(JSON.stringify(value))
    },
  }
  const next = jest.fn()
  await handler({ params, headers: {}, get: () => undefined }, res, next)
  if (next.mock.calls.length) throw next.mock.calls[0][0]
  return result
}
async function mcpDetail(exchangeId: string, venueId = s.venueId) {
  let handler: any
  const scope: McpScope = {
    staffId: s.staffId,
    activeOrg: s.organizationId,
    allowedVenueIds: [venueId],
    scopes: ['mcp:read'],
    perVenueAccess: new Map([[venueId, { corePermissions: ['payments:read'] } as never]]),
  }
  registerExchangeTools(
    {
      tool: (name: string, _d: unknown, _s: unknown, fn: unknown) => {
        if (name === 'get_exchange') handler = fn
      },
    } as never,
    scope,
  )
  return JSON.parse((await handler({ venueId, exchangeId })).content[0].text)
}

describe('exchange dashboard additions', () => {
  it.each([
    ['CLOTHING', null, true],
    ['RETAIL_STORE', null, true],
    ['SALON', null, true],
    ['RESTAURANT', null, false],
    ['RESTAURANT', true, true],
    ['CLOTHING', false, false],
  ] as const)('saves explicit settings and exposes the effective value: %s, %s', async (type, setting, effective) => {
    await prisma.venue.update({ where: { id: s.venueId }, data: { type: type as VenueType } })
    await prisma.venueSettings.deleteMany({ where: { venueId: s.venueId } })
    if (setting === null) await prisma.venueSettings.create({ data: { venueId: s.venueId, exchangesEnabled: null } })
    if (setting !== null) {
      const { body } = UpdateVenueSettingsSchema.parse({ params: { venueId: s.venueId }, body: { exchangesEnabled: setting } })
      expect(await updateVenueSettings(s.venueId, body as Prisma.VenueSettingsUpdateInput, s.staffId)).toMatchObject({ exchangesEnabled: setting })
      const { body: flip } = UpdateVenueSettingsSchema.parse({ params: { venueId: s.venueId }, body: { exchangesEnabled: !setting } })
      await updateVenueSettings(s.venueId, flip as Prisma.VenueSettingsUpdateInput, s.staffId)
      await updateVenueSettings(s.venueId, body as Prisma.VenueSettingsUpdateInput, s.staffId)
    }
    expect(await getVenueById(s.organizationId, s.venueId)).toMatchObject({
      exchangesEnabledEffective: effective,
      settings: { exchangesEnabled: setting },
    })
    expect(await http(getVenueTpvSettings, { venueId: s.venueId })).toMatchObject({ data: { exchangesEnabled: effective } })
  })

  it('uses the venue default without a settings row', async () => {
    await prisma.venueSettings.deleteMany({ where: { venueId: s.venueId } })
    expect(await getVenueById(s.organizationId, s.venueId)).toMatchObject({ settings: null, exchangesEnabledEffective: true })
  })

  it.each(['PENDING_PAYMENT', 'CANCELLED', 'NEEDS_REVIEW'] as const)(
    'payment and order carry links in both directions for %s',
    async status => {
      const reviewedAt = status === 'NEEDS_REVIEW' ? new Date('2026-10-26T18:00:00Z') : null
      const e = await row({ status, reviewedAt })
      const original = { exchangeId: e.id, newOrderId: e.newOrderId, status, reviewedAt: reviewedAt?.toISOString() ?? null }
      const replacement = {
        exchangeId: e.id,
        originalOrderId: s.order.id,
        originalOrderNumber: s.order.orderNumber,
        status,
        reviewedAt: reviewedAt?.toISOString() ?? null,
      }
      const payment = await http(getPayment, { venueId: s.venueId, paymentId: s.payments[0].id })
      expect(payment.exchange).toMatchObject({ asOriginalTotal: 1, asOriginal: [original], asNew: null })
      expect(JSON.parse(JSON.stringify(await getOrderById(s.venueId, s.order.id))).exchange).toEqual(payment.exchange)
      expect(JSON.parse(JSON.stringify(await getOrderById(s.venueId, e.newOrderId))).exchange.asNew).toMatchObject(replacement)
      const newPayment = await prisma.payment.create({
        data: {
          venueId: s.venueId,
          orderId: e.newOrderId,
          amount: 50,
          tipAmount: 0,
          netAmount: 50,
          feeAmount: 0,
          feePercentage: 0,
          method: 'CASH',
          source: 'TPV',
          status: 'COMPLETED',
        },
      })
      expect((await http(getPayment, { venueId: s.venueId, paymentId: newPayment.id })).exchange.asNew).toEqual(replacement)
    },
  )

  it('detail reads saved lines, settlement and difference, with 404 for another venue through HTTP and MCP', async () => {
    const { exchange } = await createExchange(s.input())
    const detail = await dashboard.getExchangeForDashboard({ venueId: s.venueId, exchangeId: exchange.id })
    expect(detail).toMatchObject({
      applied: true,
      returned: exchange.lines.returned,
      taken: exchange.lines.taken,
      differenceCents: 0,
      settlement: { kind: 'EVEN', method: null, amountCents: 0 },
    })
    expect((await http(getExchange, { venueId: s.venueId, exchangeId: exchange.id })).data).toMatchObject({ applied: true })
    await expect(dashboard.getExchangeForDashboard({ venueId: cuid(), exchangeId: exchange.id })).rejects.toMatchObject({ statusCode: 404 })
    await expect(http(getExchange, { venueId: cuid(), exchangeId: exchange.id })).rejects.toMatchObject({ statusCode: 404 })
    await expect(mcpDetail(exchange.id, cuid())).rejects.toMatchObject({ statusCode: 404 })
  })

  it.each([
    ['PENDING_PAYMENT', null],
    ['CANCELLED', null],
    ['NEEDS_REVIEW', 'CHARGE_AMOUNT_MISMATCH'],
    ['NEEDS_REVIEW', 'LATE_CHARGE_AFTER_RELEASE'],
    ['NEEDS_REVIEW', 'ORIGINAL_CHANGED_WHILE_PENDING'],
  ] as const)('does not infer applied effects from requested restock for %s/%s', async (status, reviewReason) => {
    const e = await row({ status, reviewReason, lines: { returned: [{ restock: true }], taken: [{ productName: 'Requested' }] } })
    const detail = await dashboard.getExchangeForDashboard({ venueId: s.venueId, exchangeId: e.id })
    expect(detail).toMatchObject({
      applied: false,
      returned: [{ restock: true }],
      expectedChargeCents: null,
      chargedCents: null,
      chargePaymentCount: null,
      paymentIds: [],
    })
    expect(await mcpDetail(e.id)).toMatchObject({ aplicado: false, cobrado: null, esperado: null })
  })

  it('two real charges of $100 show $200 in 2 payments, also through get_exchange', async () => {
    await s.cleanup()
    const card = await seedCardSale({ provider: 'BLUMON', amounts: [350] })
    s = card
    await prisma.venue.update({ where: { id: s.venueId }, data: { seatCapExempt: true } })
    await prisma.product.update({ where: { id: s.products[3].id }, data: { price: 450 } })
    const { exchange: e } = await createExchange(
      s.input(
        s.body({
          taken: [{ productId: s.products[3].id, quantity: 1 }],
          settlement: { kind: 'COLLECT', method: 'CARD_TERMINAL', expectedDifferenceCents: 10000 },
        }),
      ),
    )
    const first = await card.terminalCharge(e.newOrderId, 10000)
    const second = await card.terminalCharge(e.newOrderId, 10000)
    await completeExchange({ venueId: s.venueId, exchangeId: e.id, actorStaffId: s.staffId })
    expect(await dashboard.getExchangeForDashboard({ venueId: s.venueId, exchangeId: e.id })).toMatchObject({
      applied: false,
      expectedChargeCents: 10000,
      chargedCents: 20000,
      chargePaymentCount: 2,
      chargePaymentId: first.id,
      paymentIds: expect.arrayContaining([first.id, second.id]),
    })
    expect(await mcpDetail(e.id)).toMatchObject({
      aplicado: false,
      esperado: 100,
      cobrado: 200,
      cantidadDeCobros: 2,
      cobros: expect.arrayContaining([first.id, second.id]),
      cobroDeLaTerminal: first.id,
    })
  })

  it('cursor does not skip a row after another manager reviews between pages, including equal timestamps', async () => {
    const at = new Date('2020-01-01T00:00:00Z')
    const rows = []
    for (let i = 0; i < 26; i++) rows.push(await row({ createdAt: at }))
    const first = await dashboard.listExchangesForReview({ venueId: s.venueId, pendingReview: true })
    expect(first.items).toHaveLength(25)
    expect(first.nextCursor).toEqual(expect.any(String))
    await dashboard.markExchangeReviewed({
      venueId: s.venueId,
      exchangeId: first.items[0].id,
      staffId: s.staffId,
      note: 'Checked by another manager',
    })
    const second = await dashboard.listExchangesForReview({ venueId: s.venueId, pendingReview: true, cursor: first.nextCursor! })
    expect(second.total).toBe(25)
    expect(second.items.map(r => r.id)).toEqual([
      rows
        .map(r => r.id)
        .sort()
        .reverse()[25],
    ])
    expect(second.nextCursor).toBeNull()
  })

  it('filters by original order and status, caps links at 50 and exposes every row by pagination', async () => {
    const rows = []
    for (let i = 0; i < 51; i++) rows.push(await row({ status: 'CANCELLED' }))
    const other = await row({ originalOrderId: rows[0].newOrderId, status: 'PENDING_PAYMENT' })
    const links = (await loadExchangeLinksForOrders(prisma, s.venueId, [s.order.id])).get(s.order.id)!
    expect(links.asOriginal).toHaveLength(50)
    expect(links.asOriginalTotal).toBe(51)
    const first = await dashboard.listExchangesForReview({
      venueId: s.venueId,
      originalOrderId: s.order.id,
      status: 'CANCELLED',
      limit: 10000,
    })
    expect(first.total).toBe(51)
    expect(first.items).toHaveLength(51)
    const filtered = await dashboard.listExchangesForReview({ venueId: s.venueId, status: 'PENDING_PAYMENT' })
    expect(filtered.items.map(r => r.id)).toEqual([other.id])
    await expect(dashboard.listExchangesForReview({ venueId: s.venueId, cursor: 'bad' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('review rows carry folios, payment and staff name with constant bounded reads per page', async () => {
    const e = await row()
    const staff = await prisma.staff.findUniqueOrThrow({ where: { id: s.staffId } })
    const counter = clienteQueCuenta()
    try {
      const count = async () => {
        counter.reiniciar()
        const result = await dashboard.listExchangesForReview({ venueId: s.venueId, db: counter.db })
        return { result, queries: counter.consultas() }
      }
      const one = await count()
      expect(one.result.items[0]).toMatchObject({
        originalOrderNumber: s.order.orderNumber,
        newOrderNumber: expect.any(String),
        originalPaymentId: s.payments[0].id,
        staffName: `${staff.firstName} ${staff.lastName}`.trim(),
      })
      for (let i = 0; i < 9; i++) await row()
      const ten = await count()
      expect(ten.queries).toBe(one.queries)
      expect(ten.queries).toBeLessThanOrEqual(4)
      expect(ten.result.items).toHaveLength(10)
      expect(ten.result.items.some(r => r.id === e.id)).toBe(true)
    } finally {
      await counter.cerrar()
    }
  })
})
