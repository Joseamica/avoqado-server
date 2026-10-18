import { computeRevenueSplit } from '@/services/payments/revenueShare.service'
import { createMerchantRevenueShareSchema, updateMerchantRevenueShareSchema } from '@/schemas/dashboard/merchant-revenue-share.schema'
import { getEarningsSummary, getEarningsTimeSeries } from '@/services/superadmin/earnings.service'
import { computeRevenueReport } from '@/services/payments/revenueShareReport.service'
import { prismaMock } from '@tests/__helpers__/setup'

const rates = { DEBIT: 0.007, CREDIT: 0.007, AMEX: 0.007, INTERNATIONAL: 0.007 }
const config = {
  aggregatorPrice: rates,
  aggregatorPriceIncludesTax: false,
  avoqadoShareOfProviderMargin: 0.5,
  avoqadoShareOfAggregatorMargin: 1,
  taxRate: 0.16,
  intermediaryFeeRate: 0.01,
}

describe('manejo de intermediario en reportes', () => {
  it.each([0.5, 1])('descuenta el cargo final sobre depósito tras IVA, preservando share %s', fraction => {
    const result = computeRevenueSplit({
      amount: 100,
      cardType: 'DEBIT',
      providerCostRate: 0.0064,
      providerCostIncludesTax: false,
      venueChargeRate: 0.055,
      venueChargeIncludesTax: true,
      share: { ...config, avoqadoShareOfProviderMargin: fraction },
    })
    expect(result).toMatchObject({ intermediaryFeeAmount: 0.99 })
    expect(result.avoqadoFromProviderMargin).toBe(fraction === 0.5 ? 0.03 : 0.06)
    expect(result.avoqadoFromAggregatorMargin).toBe(3.05)
    expect(result.aggregatorNet).toBe(0)
  })

  it('acepta una tasa final sin sumarle IVA ni perderla al validar', () => {
    expect(createMerchantRevenueShareSchema.parse({ merchantAccountId: 'merchant', ...config })).toMatchObject({
      intermediaryFeeRate: 0.01,
    })
    expect(updateMerchantRevenueShareSchema.parse({ intermediaryFeeRate: 0.01 })).toMatchObject({ intermediaryFeeRate: 0.01 })
  })

  it.each([-0.01, 1.01, Infinity, NaN])('rechaza tasa inválida %s', value => {
    expect(updateMerchantRevenueShareSchema.safeParse({ intermediaryFeeRate: value }).success).toBe(false)
  })

  it('los clientes anteriores no borran el cargo si omiten el campo', () => {
    expect(updateMerchantRevenueShareSchema.parse({ avoqadoShareOfProviderMargin: 1 })).not.toHaveProperty('intermediaryFeeRate')
  })

  it('la tarifa que ya incluye IVA produce el mismo depósito y conserva la suma del reparto', () => {
    const result = computeRevenueSplit({
      amount: 100,
      cardType: 'DEBIT',
      providerCostRate: 0.0064,
      providerCostIncludesTax: false,
      venueChargeRate: 0.055,
      venueChargeIncludesTax: true,
      share: {
        ...config,
        aggregatorPrice: { ...rates, DEBIT: 0.00812 },
        aggregatorPriceIncludesTax: true,
        avoqadoShareOfAggregatorMargin: 0.5,
      },
    })
    expect(result.intermediaryFeeAmount).toBe(0.99)
    expect(result.avoqadoFromAggregatorMargin).toBe(1.53)
    expect(result.providerNet + result.avoqadoNet + result.aggregatorNet + result.intermediaryFeeAmount).toBeCloseTo(4.74, 2)
  })

  it('con cargo cero conserva el acuerdo anterior y una pérdida sigue siendo visible', () => {
    const input = {
      amount: 100,
      cardType: 'DEBIT' as const,
      providerCostRate: 0.0064,
      providerCostIncludesTax: false,
      venueChargeRate: 0.00812,
      venueChargeIncludesTax: true,
    }
    expect(computeRevenueSplit({ ...input, share: { ...config, intermediaryFeeRate: 0 } }).avoqadoNet).toBe(0.03)
    const result = computeRevenueSplit({ ...input, share: config })
    expect(result.avoqadoFromAggregatorMargin).toBe(-0.99)
    expect(result.avoqadoNet).toBe(-0.96)
  })
})

describe('propagación del manejo a reportes y ganancias', () => {
  beforeEach(() => {
    prismaMock.transactionCost.findMany.mockReset()
    prismaMock.transactionCost.findMany.mockResolvedValue([
      {
        id: 'tc1',
        amount: 100,
        transactionType: 'DEBIT',
        providerRate: 0.007424,
        venueRate: 0.055,
        createdAt: new Date('2026-10-01T18:00:00Z'),
        merchantAccount: {
          id: 'm1',
          displayName: 'Comercio',
          alias: null,
          externalMerchantId: 'EXT1',
          provider: { id: 'p1', code: 'ANGELPAY', name: 'AngelPay' },
          merchantRevenueShare: config,
        },
        payment: { venue: { id: 'v1', name: 'Negocio' } },
      },
    ])
    prismaMock.$queryRaw.mockResolvedValue([])
    prismaMock.checkoutSession.aggregate.mockResolvedValue({ _count: 0, _sum: { amount: null, applicationFeeCents: null } })
    prismaMock.checkoutSession.findMany.mockResolvedValue([])
  })

  const from = new Date('2026-10-01T00:00:00Z')
  const to = new Date('2026-10-02T00:00:00Z')
  it('el resumen descuenta el manejo una sola vez', async () => {
    const summary = await getEarningsSummary({ startDate: from, endDate: to })
    expect(summary.totals.terminalNet).toBe(3.08)
  })
  it('la gráfica descuenta el manejo una sola vez', async () => {
    const series = await getEarningsTimeSeries({ startDate: from, endDate: to }, 'daily')
    expect(series[0].terminalNet).toBe(3.08)
  })
  it('el reporte por merchant descuenta el manejo una sola vez', async () => {
    const rows = await computeRevenueReport({ from, to })
    expect(rows[0].avoqadoNet).toBe(3.08)
  })

  it('el reporte incluye la página siguiente sin perder filas ni cargos', async () => {
    const fixture = (await prismaMock.transactionCost.findMany())[0]
    prismaMock.transactionCost.findMany.mockReset()
    prismaMock.transactionCost.findMany
      .mockResolvedValueOnce(Array.from({ length: 500 }, (_, i) => ({ ...fixture, id: `tc${i}` })))
      .mockResolvedValueOnce([{ ...fixture, id: 'tc500' }])
    const rows = await computeRevenueReport({ from, to })
    expect(rows[0].txCount).toBe(501)
    expect(rows[0].avoqadoNet).toBeCloseTo(501 * 3.08, 2)
    expect(prismaMock.transactionCost.findMany.mock.calls[1][0]).toMatchObject({
      take: 500,
      cursor: { id: 'tc499' },
      skip: 1,
    })
  })
})
