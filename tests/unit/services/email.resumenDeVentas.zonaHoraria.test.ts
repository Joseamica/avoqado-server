import emailService from '../../../src/services/email.service'

// D20 (16-nov-2026): el cuerpo de TEXTO del correo diario decía «CST» escrito a mano, también en Tijuana y en Cancún.
// Ahora dice la zona del negocio como la nombra la base de zonas horarias en español de México («hora de Tijuana»).
const sendSpy = jest.spyOn(emailService as any, 'sendEmail').mockResolvedValue(true)
beforeEach(() => sendSpy.mockClear())

const METRICAS = {
  grossSales: 100,
  items: 100,
  serviceCosts: 0,
  discounts: 0,
  refunds: 0,
  netSales: 100,
  deferredSales: 0,
  taxes: 0,
  tips: 0,
  platformFees: 0,
  staffCommissions: 0,
  commissions: 0,
  totalCollected: 100,
  netProfit: 100,
  transactionCount: 1,
}

async function cuerpos(venueTimezone: string, horario = { businessHoursStart: '', businessHoursEnd: '' }) {
  await emailService.sendSalesSummaryEmail('duena@example.com', {
    venueId: 'v',
    venueName: 'Negocio',
    venueTimezone,
    venueCurrency: 'MXN',
    reportDate: new Date('2026-10-02T18:00:00.000Z'),
    ...horario,
    dashboardUrl: 'https://dashboard.avoqado.io/venues/negocio',
    metrics: METRICAS,
    categoryBreakdown: [],
    orderSources: [],
  })
  return sendSpy.mock.calls[0][0] as { html: string; text: string }
}

describe('D20 · el correo diario dice la zona del negocio, no «CST»', () => {
  it.each([
    ['America/Tijuana', 'hora de Tijuana'],
    ['America/Cancun', 'hora de Cancún'],
    ['America/Mexico_City', 'hora de Ciudad de México'],
  ])('🔴 %s: el texto y el HTML dicen «%s» y nunca «CST»', async (zona, legible) => {
    const { text, html } = await cuerpos(zona)
    expect(text).toContain(`(${legible})`)
    expect(text).not.toMatch(/\bCST\b/)
    // Codex r1 #4: el job manda el horario vacío, y sin horario el HTML no decía ninguna zona.
    expect(html).toContain(`(${legible})`)
    expect(html).not.toMatch(/\bCST\b/)
  })

  it('🔴 con horario, el HTML dice la zona legible, no el identificador «America/Tijuana»', async () => {
    const { html, text } = await cuerpos('America/Tijuana', { businessHoursStart: '08:00', businessHoursEnd: '22:00' })
    expect(html).toContain('(hora de Tijuana)')
    expect(html).not.toContain('America/Tijuana')
    expect(text).toContain('08:00 - 22:00 (hora de Tijuana)')
  })
})
