/**
 * order.tpv.service.ts::getOrder — itemized check breakdown (gap fix, 2026-07-29).
 *
 * `GET /tpv/venues/:venueId/orders/:orderId` used to return ONLY the flat
 * `discountAmount`/`serviceChargeAmount` totals — no `orderDiscounts` or
 * `serviceCharges` breakdown, unlike `/mobile`'s `order.mobile.service.ts::getOrder`,
 * which has selected `orderDiscounts: { id, name, amount }` and full `serviceCharges`
 * for a while. The TPV "Mesas" module needs the itemized breakdown to render a check
 * a waiter/customer can actually read ("why is it this much?").
 *
 * This file pins:
 *   1. The Prisma `include` now asks for `orderDiscounts`/`serviceCharges`, mirroring
 *      the exact field selection `/mobile` already uses (same relation names, same
 *      `select` — no invented field names).
 *   2. The response actually carries those arrays, with money in pesos (not cents).
 *   3. Nothing pre-existing was removed: items/payments/amount_left/tableName/
 *      lastSplitType/paidItemIds are all still there (regression).
 */

import { Decimal } from '@prisma/client/runtime/library'

// ── Local prisma mock (overrides the global one for this test file) ───────────
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    order: {
      findUnique: jest.fn(),
    },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import prisma from '@/utils/prismaClient'
import * as orderTpvService from '@/services/tpv/order.tpv.service'

const findUniqueMock = (prisma as any).order.findUnique as jest.Mock

const VENUE_ID = 'venue-1'
const ORDER_ID = 'order-1'

function buildOrderFixture(overrides: Record<string, any> = {}) {
  return {
    id: ORDER_ID,
    venueId: VENUE_ID,
    orderNumber: 'ORD-1',
    status: 'CONFIRMED',
    paymentStatus: 'PENDING',
    type: 'DINE_IN',
    subtotal: new Decimal('100.00'),
    discountAmount: new Decimal('10.00'),
    serviceChargeAmount: new Decimal('13.00'),
    taxAmount: new Decimal('0.00'),
    tipAmount: new Decimal('0.00'),
    total: new Decimal('103.00'),
    version: 1,
    splitType: null,
    items: [],
    payments: [],
    createdBy: null,
    servedBy: null,
    table: null,
    orderDiscounts: [{ id: 'od-1', name: '10% cumpleaños', amount: new Decimal('10.00') }],
    serviceCharges: [
      {
        id: 'osc-1',
        orderId: ORDER_ID,
        serviceChargeId: 'sc-1',
        name: 'Servicio grupos 8+',
        type: 'PERCENTAGE',
        value: new Decimal('13.0000'),
        amount: new Decimal('13.00'),
        taxable: true,
        isAutomatic: true,
        appliedById: null,
        createdAt: new Date('2026-07-01T00:00:00Z'),
      },
    ],
    ...overrides,
  }
}

describe('order.tpv.service.getOrder — itemized check breakdown', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // NEW FEATURE TESTS ────────────────────────────────────────────────────────

  it('asks Prisma for orderDiscounts and serviceCharges, mirroring /mobile field selection', async () => {
    findUniqueMock.mockResolvedValue(buildOrderFixture())

    await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(findUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          orderDiscounts: { select: { id: true, name: true, amount: true } },
          serviceCharges: true,
        }),
      }),
    )
  })

  it('returns the discount breakdown with money in pesos (not cents)', async () => {
    findUniqueMock.mockResolvedValue(buildOrderFixture())

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.orderDiscounts).toEqual([{ id: 'od-1', name: '10% cumpleaños', amount: expect.anything() }])
    // Decimal('10.00') — pesos 1:1, never *100
    expect(Number(result.orderDiscounts[0].amount)).toBe(10)
  })

  it('returns the service-charge breakdown with money in pesos (not cents)', async () => {
    findUniqueMock.mockResolvedValue(buildOrderFixture())

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.serviceCharges).toHaveLength(1)
    expect(result.serviceCharges[0].name).toBe('Servicio grupos 8+')
    expect(result.serviceCharges[0].isAutomatic).toBe(true)
    expect(Number(result.serviceCharges[0].amount)).toBe(13)
  })

  it('still exposes an itemized breakdown when there are no discounts/service charges (empty arrays, not undefined)', async () => {
    findUniqueMock.mockResolvedValue(buildOrderFixture({ orderDiscounts: [], serviceCharges: [] }))

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.orderDiscounts).toEqual([])
    expect(result.serviceCharges).toEqual([])
  })

  // REGRESSION TESTS — existing shape must survive untouched ────────────────

  it('still computes amount_left, tableName, lastSplitType and paidItemIds', async () => {
    findUniqueMock.mockResolvedValue(
      buildOrderFixture({
        table: { id: 'table-1', number: 5 },
        payments: [{ id: 'pay-1', amount: new Decimal('50.00'), splitType: 'EQUALPARTS', createdAt: new Date() }],
      }),
    )

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.amount_left).toBe(53)
    expect(result.tableName).toBe('Mesa 5')
    expect(result.lastSplitType).toBe('EQUALPARTS')
    expect(result.paidItemIds).toEqual([])
  })

  it('still throws NotFoundError when the order does not exist', async () => {
    findUniqueMock.mockResolvedValue(null)

    await expect(orderTpvService.getOrder(VENUE_ID, 'missing-order')).rejects.toThrow('Order not found')
  })

  it('still includes the pre-existing relations (items, payments, createdBy, servedBy, table)', async () => {
    findUniqueMock.mockResolvedValue(buildOrderFixture())

    await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    const callArg = findUniqueMock.mock.calls[0][0]
    expect(callArg.include).toMatchObject({
      items: expect.anything(),
      payments: expect.anything(),
      createdBy: expect.anything(),
      servedBy: expect.anything(),
      table: expect.anything(),
    })
  })

  it('still scopes the lookup by venueId (tenant isolation)', async () => {
    findUniqueMock.mockResolvedValue(buildOrderFixture())

    await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    const callArg = findUniqueMock.mock.calls[0][0]
    expect(callArg.where).toMatchObject({ id: ORDER_ID, venueId: VENUE_ID })
  })
})
