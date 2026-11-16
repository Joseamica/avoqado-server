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
// Codex r2 #1: el aviso sólo se puso en el HTML; el cuerpo de TEXTO (lo que lee un cliente de correo sin HTML) seguía
// mostrando ventas, propinas y total sin advertencia. Se afirman los DOS cuerpos.
describe('sendSalesSummaryEmail — aviso de totales incompletos', () => {
  const cuerpos = () => sendSpy.mock.calls[0][0] as { html: string; text: string }

  it('🔴 con la marca, el HTML dice que sus totales pueden estar incompletos, antes de las cifras', async () => {
    await emailService.sendSalesSummaryEmail('duena@example.com', { ...DATOS, legacyUnavailable: true })

    const { html } = cuerpos()
    expect(html).toContain('No pudimos leer todos los cobros del sistema anterior de QR')
    expect(html).toContain('pueden estar incompletos')
    expect(html.indexOf('sistema anterior de QR')).toBeLessThan(html.indexOf('Key Metrics Box'))
  })

  it('🔴 con la marca, el cuerpo de TEXTO dice lo mismo, antes de las cifras', async () => {
    await emailService.sendSalesSummaryEmail('duena@example.com', { ...DATOS, legacyUnavailable: true })

    const { text } = cuerpos()
    expect(text).toContain('No pudimos leer todos los cobros del sistema anterior de QR')
    expect(text).toContain('pueden estar incompletos')
    expect(text.indexOf('sistema anterior de QR')).toBeLessThan(text.indexOf('METRICAS CLAVE'))
    expect(text).toContain('Ventas netas:') // el correo sale igual, con lo que sí se pudo leer
  })

  it('sin la marca, ninguno de los dos cuerpos dice nada del sistema anterior', async () => {
    await emailService.sendSalesSummaryEmail('duena@example.com', DATOS)

    const { html, text } = cuerpos()
    expect(html).not.toContain('sistema anterior de QR')
    expect(text).not.toContain('sistema anterior de QR')
    expect(text).toContain('METRICAS CLAVE')
  })
})
