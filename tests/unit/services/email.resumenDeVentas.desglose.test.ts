import emailService from '../../../src/services/email.service'

// D21: los renglones del desglose que no son una categoría (importe libre, devoluciones) no tienen «artículos vendidos».
const sendSpy = jest.spyOn(emailService as any, 'sendEmail').mockResolvedValue(true)

const METRICAS = {
  grossSales: 472.99,
  items: 472.99,
  serviceCosts: 0,
  discounts: 0,
  refunds: 0,
  netSales: 472.99,
  deferredSales: 0,
  taxes: 0,
  tips: 0,
  platformFees: 0,
  staffCommissions: 0,
  commissions: 0,
  totalCollected: 472.99,
  netProfit: 472.99,
  transactionCount: 23,
}

it('🔴 un renglón sin artículos imprime «—», no «null»', async () => {
  await emailService.sendSalesSummaryEmail('duena@example.com', {
    venueId: 'venue-full',
    venueName: 'Avoqado Full',
    venueTimezone: 'America/Mexico_City',
    venueCurrency: 'MXN',
    reportDate: new Date('2026-10-27T17:59:59.999Z'),
    businessHoursStart: '',
    businessHoursEnd: '',
    dashboardUrl: 'https://dashboard.avoqado.io/venues/avoqado-full',
    metrics: METRICAS,
    categoryBreakdown: [
      { name: 'Bebidas', itemsSold: 10, netSales: 446 },
      { name: 'Ventas sin producto (importe libre)', itemsSold: null, netSales: 26.99 },
    ],
    orderSources: [],
  })
  const { html } = sendSpy.mock.calls[0][0] as { html: string }
  const renglon = html.slice(html.indexOf('Ventas sin producto (importe libre)'))
  expect(renglon.slice(0, 400)).toMatch(/>—<\/td>/)
  expect(html).not.toContain('>null<')
})
