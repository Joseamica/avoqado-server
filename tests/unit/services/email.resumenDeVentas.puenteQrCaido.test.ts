import emailService from '../../../src/services/email.service'

// Sólo importa lo que sendSalesSummaryEmail le pasa al transporte.
const sendSpy = jest.spyOn(emailService as any, 'sendEmail').mockResolvedValue(true)

beforeEach(() => sendSpy.mockClear())

const DATOS = {
  venueId: 'venue-mindform',
  venueName: 'Mindform',
  venueTimezone: 'America/Mexico_City',
  venueCurrency: 'MXN',
  reportDate: new Date('2026-11-16T04:02:00.000Z'),
  businessHoursStart: '',
  businessHoursEnd: '',
  dashboardUrl: 'https://dashboard.avoqado.io/venues/mindform',
  metrics: {
    grossSales: 1000,
    items: 1000,
    serviceCosts: 0,
    discounts: 0,
    refunds: 0,
    netSales: 1000,
    deferredSales: 0,
    taxes: 0,
    tips: 0,
    platformFees: 0,
    staffCommissions: 0,
    commissions: 0,
    totalCollected: 1000,
    netProfit: 1000,
    transactionCount: 10,
  },
  categoryBreakdown: [],
  orderSources: [],
}

// D15 (Codex r1 #6): el correo copiaba las cifras y tiraba la marca del puente QR legacy.
describe('sendSalesSummaryEmail — aviso de totales incompletos', () => {
  it('🔴 con la marca, el correo dice que sus totales pueden estar incompletos, antes de las cifras', async () => {
    await emailService.sendSalesSummaryEmail('duena@example.com', { ...DATOS, legacyUnavailable: true })

    const html = (sendSpy.mock.calls[0][0] as any).html as string
    expect(html).toContain('No pudimos leer todos los cobros del sistema anterior de QR')
    expect(html).toContain('pueden estar incompletos')
    expect(html.indexOf('sistema anterior de QR')).toBeLessThan(html.indexOf('Key Metrics Box'))
  })

  it('sin la marca, el correo no dice nada del sistema anterior', async () => {
    await emailService.sendSalesSummaryEmail('duena@example.com', DATOS)

    expect((sendSpy.mock.calls[0][0] as any).html).not.toContain('sistema anterior de QR')
  })
})
