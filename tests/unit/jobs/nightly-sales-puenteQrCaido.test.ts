/**
 * D15 (Codex r1 #6) — el correo nocturno de ventas dice cuándo sus totales pueden estar incompletos.
 *
 * El job pide tres resúmenes (hoy, ayer y el mismo día de la semana pasada) y armaba el correo sólo con las cifras: si el
 * puente QR legacy de Mindform fallaba en cualquiera de los tres, el total o la comparación llegaban parciales sin aviso.
 */
jest.mock('@/services/dashboard/sales-summary.dashboard.service', () => ({ getSalesSummary: jest.fn() }))
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: { sendSalesSummaryEmail: jest.fn().mockResolvedValue(true) },
}))

import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import emailService from '@/services/email.service'
import { NightlySalesSummaryJob } from '@/jobs/nightly-sales-summary.job'
import { prismaMock } from '@tests/__helpers__/setup'

const RESUMEN = {
  summary: {
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
}
const MARCADO = { ...RESUMEN, legacyUnavailable: true }

/** Los tres resúmenes en el orden en que el job los pide: hoy, ayer, semana pasada. */
async function correoCon(hoy: object, ayer: object, semanaPasada: object) {
  ;(getSalesSummary as jest.Mock).mockResolvedValueOnce(hoy).mockResolvedValueOnce(ayer).mockResolvedValueOnce(semanaPasada)
  const resultado = await new NightlySalesSummaryJob().runNow('venue-mindform')
  expect(resultado).toMatchObject({ emailsSent: 1, errors: 0 })
  return (emailService.sendSalesSummaryEmail as jest.Mock).mock.calls[0][1]
}

beforeEach(() => {
  ;(prismaMock.venue.findMany as jest.Mock).mockResolvedValue([
    {
      id: 'venue-mindform',
      name: 'Mindform',
      slug: 'mindform',
      timezone: 'America/Mexico_City',
      currency: 'MXN',
      email: null,
      staff: [{ role: 'OWNER', staff: { id: 'duena', email: 'duena@example.com', firstName: 'Ana', lastName: 'López' } }],
    },
  ])
  ;(prismaMock.notificationPreference.findMany as jest.Mock).mockResolvedValue([{ staffId: 'duena' }])
  ;(prismaMock.$queryRaw as jest.Mock).mockReset().mockResolvedValue([])
})

describe('correo nocturno de ventas con el puente QR caído', () => {
  it.each([
    { cual: 'hoy', resumenes: [MARCADO, RESUMEN, RESUMEN] },
    { cual: 'ayer (la comparación)', resumenes: [RESUMEN, MARCADO, RESUMEN] },
    { cual: 'la semana pasada (la otra comparación)', resumenes: [RESUMEN, RESUMEN, MARCADO] },
  ])('🔴 si falla el resumen de $cual, el correo lleva la marca', async ({ resumenes: [hoy, ayer, semanaPasada] }) => {
    const datos = await correoCon(hoy, ayer, semanaPasada)
    expect(datos.legacyUnavailable).toBe(true)
    expect(datos.metrics.netSales).toBe(1000) // el correo sale igual, con lo que sí se pudo leer
  })

  it('con los tres resúmenes sanos el correo no lleva la marca', async () => {
    const datos = await correoCon(RESUMEN, RESUMEN, RESUMEN)
    expect(datos).not.toHaveProperty('legacyUnavailable')
  })
})
