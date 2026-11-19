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
    // Pedidos en línea fase 2: la lectura de la TPV pregunta si la cuenta es un pedido con tarjeta; aquí no lo es.
    onlineOrder: { findFirst: jest.fn().mockResolvedValue(null) },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import prisma from '@/utils/prismaClient'
import * as orderTpvService from '@/services/tpv/order.tpv.service'
import { SELECT_DESCUENTO_DE_LA_CUENTA } from '@/services/tpv/order.tpv.service'

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
          // D15: también el reparto, para decir qué fila quedó fija al cobrar vales (no viaja en la respuesta).
          orderDiscounts: { select: { ...SELECT_DESCUENTO_DE_LA_CUENTA, reparto: true } },
          serviceCharges: true,
        }),
      }),
    )
  })

  // D15 (pizarrón hz:e82938e1:D15, 18-nov): Mesas de la TPV pinta en gris el «Quitar» de la rebaja que quedó fija al cobrar vales.
  it('🔴 D15: cada descuento dice congeladoPorVales (true sólo en la fila marcada) y no manda su reparto', async () => {
    findUniqueMock.mockResolvedValue(
      buildOrderFixture({
        orderDiscounts: [
          { id: 'od-vale', name: '10 % producto', amount: new Decimal('10.00'), reparto: { v: 1, espejo: true, deValeV7: true } },
          { id: 'od-cortesia', name: 'Cortesía', amount: new Decimal('5.00'), reparto: { v: 1, espejo: true } },
        ],
      }),
    )

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.orderDiscounts).toEqual([
      { id: 'od-vale', name: '10 % producto', amount: expect.anything(), congeladoPorVales: true },
      { id: 'od-cortesia', name: 'Cortesía', amount: expect.anything(), congeladoPorVales: false },
    ])
  })

  // QA del descuento del cliente en la PAX (11-nov): el mapper de la TPV (`OrderDiscountDto`) exige `type`; con la línea
  // recortada a { id, name, amount } truena al releer la venta tras cobrar y la pantalla final dice «Queda por pagar» con lo
  // ya pagado. Se manda lo que la TPV lee, sin quitar nada de lo que ya iba.
  it('manda en cada descuento lo que la TPV lee (tipo, valor y de qué descuento viene), además de id, nombre y monto', () => {
    expect(SELECT_DESCUENTO_DE_LA_CUENTA).toEqual({
      id: true,
      name: true,
      amount: true,
      orderId: true,
      discountId: true,
      couponCodeId: true,
      type: true,
      value: true,
      appliedById: true,
    })
  })

  it('returns the discount breakdown with money in pesos (not cents)', async () => {
    findUniqueMock.mockResolvedValue(buildOrderFixture())

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.orderDiscounts).toEqual([{ id: 'od-1', name: '10% cumpleaños', amount: expect.anything(), congeladoPorVales: false }])
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
        payments: [
          {
            id: 'pay-1',
            amount: new Decimal('50.00'),
            status: 'COMPLETED',
            type: 'REGULAR',
            splitType: 'EQUALPARTS',
            createdAt: new Date(),
          },
        ],
      }),
    )

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.amount_left).toBe(53)
    expect(result.tableName).toBe('Mesa 5')
    expect(result.lastSplitType).toBe('EQUALPARTS')
    expect(result.paidItemIds).toEqual([])
  })

  it('D4: la mesa de $50 con la parte 1 de $25 + $10 de propina responde amount_left = 25 (antes 35)', async () => {
    // Caso medido en la PAX el 12-nov (ORD-1794548257592): el cobro guardó el total CON la propina (60).
    findUniqueMock.mockResolvedValue(
      buildOrderFixture({
        originSystem: 'AVOQADO',
        source: 'TPV',
        externalId: null,
        status: 'CONFIRMED',
        paymentStatus: 'PARTIAL',
        contratoDePrecio: 'IVA_INCLUIDO',
        subtotal: new Decimal('50.00'),
        discountAmount: new Decimal('0.00'),
        serviceChargeAmount: new Decimal('0.00'),
        taxAmount: new Decimal('0.00'),
        tipAmount: new Decimal('10.00'),
        total: new Decimal('60.00'),
        thirdPartyCashDue: null,
        cashTipDue: null,
        orderDiscounts: [],
        serviceCharges: [],
        payments: [
          {
            id: 'pay-1',
            amount: new Decimal('25.00'),
            tipAmount: new Decimal('10.00'),
            status: 'COMPLETED',
            type: 'REGULAR',
            reopenedAmount: null,
            reopenedTipAmount: null,
            splitType: 'CUSTOMAMOUNT',
            createdAt: new Date(),
          },
        ],
      }),
    )

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(typeof result.amount_left).toBe('number')
    expect(result.amount_left).toBe(25)
  })

  // D14 (hz:72be07e6:D14): la N86 dijo «Total $35 · Ya pagado −$35 · Restante $10» contra un SERVIDOR local sin D4
  // (fórmula vieja `total − Σ amount`). Se fijan aquí los dos casos de la tarjeta, por el endpoint real.
  const cuentaD14 = (overrides: Record<string, any>) =>
    buildOrderFixture({
      originSystem: 'AVOQADO',
      source: 'TPV',
      externalId: null,
      status: 'COMPLETED',
      contratoDePrecio: 'IVA_INCLUIDO',
      discountAmount: new Decimal('0.00'),
      serviceChargeAmount: new Decimal('0.00'),
      taxAmount: new Decimal('0.00'),
      thirdPartyCashDue: null,
      cashTipDue: null,
      orderDiscounts: [],
      serviceCharges: [],
      ...overrides,
    })
  const pagoD14 = (amount: string, tipAmount: string, splitType: string) => ({
    id: `pay-${amount}`,
    amount: new Decimal(amount),
    tipAmount: new Decimal(tipAmount),
    status: 'COMPLETED',
    type: 'REGULAR',
    reopenedAmount: null,
    reopenedTipAmount: null,
    splitType,
    createdAt: new Date(),
  })

  it('D14: cuenta de $25 pagada completa con $10 de propina (ORD-1794866186857, total 35) → amount_left = 0 (antes 10)', async () => {
    findUniqueMock.mockResolvedValue(
      cuentaD14({
        paymentStatus: 'PAID',
        subtotal: new Decimal('25.00'),
        tipAmount: new Decimal('10.00'),
        total: new Decimal('35.00'),
        payments: [pagoD14('25.00', '10.00', 'FULLPAYMENT')],
      }),
    )

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.amount_left).toBe(0)
  })

  it('D14: cuenta de $200 con un abono de $50 + $10 de propina (total 210) → amount_left = 150 (antes 160)', async () => {
    findUniqueMock.mockResolvedValue(
      cuentaD14({
        status: 'CONFIRMED',
        paymentStatus: 'PARTIAL',
        subtotal: new Decimal('200.00'),
        tipAmount: new Decimal('10.00'),
        total: new Decimal('210.00'),
        payments: [pagoD14('50.00', '10.00', 'CUSTOMAMOUNT')],
      }),
    )

    const result: any = await orderTpvService.getOrder(VENUE_ID, ORDER_ID)

    expect(result.amount_left).toBe(150)
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
