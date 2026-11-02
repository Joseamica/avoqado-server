import { flattenSalesSummaryForExport, type SalesSummaryResponse } from '@/services/dashboard/sales-summary.dashboard.service'

const reporte = (extra: Omit<Partial<SalesSummaryResponse>, 'summary'> & { summary?: Partial<SalesSummaryResponse['summary']> } = {}) =>
  ({
    dateRange: { startDate: new Date('2026-10-14T06:00:00Z'), endDate: new Date('2026-10-15T05:59:59Z') },
    reportType: 'summary',
    filtered: false,
    ...extra,
    summary: {
      grossSales: 500,
      items: 500,
      serviceCosts: 0,
      discounts: 0,
      refunds: 0,
      netSales: 500,
      deferredSales: 0,
      taxes: 0,
      tips: 0,
      platformFees: 0,
      staffCommissions: 0,
      commissions: 0,
      totalCollected: 500,
      netProfit: 500,
      transactionCount: 3,
      ...extra.summary,
    },
  }) as SalesSummaryResponse

describe('exportación de Ventas · tarjetas de regalo', () => {
  it('agrega «Tarjetas de regalo cargadas» y «Pagado con saldo» al final de los totales cuando vienen', () => {
    const { rows } = flattenSalesSummaryForExport(
      reporte({ summary: { giftCardLoads: 500, giftCardLoadsCount: 2, paidWithGiftCardBalance: 200 } }),
      ['totals'],
    )
    expect(rows.slice(-2)).toEqual([
      { section: 'totals', label: 'Tarjetas de regalo cargadas (no es venta)', count: 2, amount: 500, percentage: null },
      {
        section: 'totals',
        label: 'Pagado con saldo de tarjeta de regalo (incluido en ventas y propinas)',
        count: null,
        amount: 200,
        percentage: null,
      },
    ])
  })

  it('regresión: sin cifras de tarjetas, los totales son los 8 de siempre', () => {
    expect(flattenSalesSummaryForExport(reporte(), ['totals']).rows).toHaveLength(8)
  })

  it('con tarjetas, los métodos son DINERO como el panel; el saldo va aparte, bruto y sin porcentaje, y dice lo que regresó', () => {
    const { rows } = flattenSalesSummaryForExport(
      reporte({
        summary: { paidWithGiftCardBalance: 100 },
        // DINERO: incluye $150 de una carga de tarjeta cobrada en efectivo; el dueño cuadra el cajón con esto.
        byPaymentMethod: [{ method: 'CASH', amount: 1050, count: 10, percentage: 100 }],
        // VENTAS (la barra de «Total de Ventas»): no es esta sección.
        salesByPaymentMethod: [
          { method: 'CASH', amount: 900, count: 9, percentage: 90 },
          { method: 'GIFT_CARD', amount: 100, count: 2, percentage: 10 },
        ],
        giftCardBalanceBreakdown: { amount: 150, count: 2, tips: 0, refunds: 50 },
      }),
      ['paymentMethods'],
    )
    expect(rows).toEqual([
      { section: 'paymentMethods', label: 'CASH', count: 10, amount: 1050, percentage: 100 },
      { section: 'paymentMethods', label: 'Saldo de tarjeta de regalo', count: 2, amount: 150, percentage: null },
      { section: 'paymentMethods', label: 'Regresó al saldo de tarjetas', count: null, amount: 50, percentage: null },
    ])
  })

  it('con saldo y sin reversos, no sale la fila de lo que regresó', () => {
    const { rows } = flattenSalesSummaryForExport(
      reporte({
        summary: { paidWithGiftCardBalance: 150 },
        byPaymentMethod: [{ method: 'CASH', amount: 300, count: 1, percentage: 100 }],
        giftCardBalanceBreakdown: { amount: 150, count: 2, tips: 0, refunds: 0 },
      }),
      ['paymentMethods'],
    )
    expect(rows.map(r => r.label)).toEqual(['CASH', 'Saldo de tarjeta de regalo'])
  })

  it('sin tarjetas no cambia', () => {
    // Negocio sin ninguna tarjeta: el reporte no trae `salesByPaymentMethod` y el desglose del saldo viene en cero.
    const { rows } = flattenSalesSummaryForExport(
      reporte({
        byPaymentMethod: [{ method: 'CASH', amount: 300, count: 1, percentage: 100 }],
        giftCardBalanceBreakdown: { amount: 0, count: 0, tips: 0, refunds: 0 },
      }),
      ['paymentMethods'],
    )
    expect(rows).toEqual([{ section: 'paymentMethods', label: 'CASH', count: 1, amount: 300, percentage: 100 }])
  })
})
