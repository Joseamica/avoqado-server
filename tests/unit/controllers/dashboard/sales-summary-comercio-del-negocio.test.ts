/**
 * Carril F (Codex r13, decisión del coordinador): el filtro `merchantAccountId` del Resumen de ventas debe ser de ESTE negocio. Si no
 * es de su configuración de cobro (la lista del panel) ni de un cobro suyo, el GET y el exporte contestan 400 en español y no calculan.
 */
import type { Request, Response } from 'express'

const mockGetSalesSummary = jest.fn()
const mockConfig = jest.fn()

jest.mock('@/services/dashboard/sales-summary.dashboard.service', () => ({
  ...jest.requireActual('@/services/dashboard/sales-summary.dashboard.service'),
  getSalesSummary: (...a: unknown[]) => mockGetSalesSummary(...a),
}))
jest.mock('@/services/organization-payment-config.service', () => ({
  ...jest.requireActual('@/services/organization-payment-config.service'),
  getEffectivePaymentConfig: (...a: unknown[]) => mockConfig(...a),
}))
jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn().mockResolvedValue(true) }))
jest.mock('@/services/access/rolVigente', () => ({ esSuperadminDeLaSesion: jest.fn().mockResolvedValue(false) }))

import { salesSummaryExport, salesSummaryReport } from '@/controllers/dashboard/sales-summary.dashboard.controller'
import { MENSAJE_COMERCIO_AJENO } from '@/services/venuePaymentConfig.service'
import { prismaMock } from '@tests/__helpers__/setup'

const PROPIO = 'clpropiosse0123456789012a'
const AJENO = 'clajenosse01234567890123a'

const req = (query: Record<string, string>) =>
  ({
    authContext: { venueId: 'v1', userId: 'u1', orgId: 'o1', role: 'OWNER' },
    query: { startDate: '2026-11-22T06:00:00.000Z', endDate: '2026-11-23T05:59:59.999Z', ...query },
    headers: {},
    params: {},
  }) as unknown as Request

function makeRes() {
  const res: Record<string, jest.Mock> = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  res.setHeader = jest.fn(() => res)
  res.send = jest.fn(() => res)
  return res as unknown as Response
}

const llamar = async (fn: typeof salesSummaryReport, query: Record<string, string>) => {
  const next = jest.fn()
  await fn(req(query), makeRes(), next)
  return next
}

const es400Ajeno = (next: jest.Mock) => {
  expect(next).toHaveBeenCalledTimes(1)
  expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400, message: MENSAJE_COMERCIO_AJENO })
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(prismaMock.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: 'America/Mexico_City' })
  mockConfig.mockResolvedValue({ config: { primaryAccount: { id: PROPIO } } })
  ;(prismaMock.payment.findFirst as jest.Mock).mockResolvedValue(null)
  mockGetSalesSummary.mockResolvedValue({ summary: { netSales: 0 }, byPaymentMethod: [], filtered: true })
})

describe('el filtro de comercio del Resumen de ventas es del negocio', () => {
  it('🔴 GET: una clave que no es del negocio ⇒ 400 en español y no calcula', async () => {
    es400Ajeno(await llamar(salesSummaryReport, { merchantAccountId: AJENO }))
    expect(mockGetSalesSummary).not.toHaveBeenCalled()
  })

  it('🔴 exporte (resumen): una clave que no es del negocio ⇒ 400 en español y no calcula', async () => {
    es400Ajeno(await llamar(salesSummaryExport, { merchantAccountId: AJENO, mode: 'summary', format: 'csv' }))
    expect(mockGetSalesSummary).not.toHaveBeenCalled()
  })

  it('🔴 exporte (detallado): una clave que no es del negocio ⇒ 400 en español', async () => {
    es400Ajeno(await llamar(salesSummaryExport, { merchantAccountId: AJENO, mode: 'detailed', format: 'csv' }))
  })

  it('control: la clave de su configuración de cobro pasa', async () => {
    const next = await llamar(salesSummaryReport, { merchantAccountId: PROPIO })
    expect(next).not.toHaveBeenCalled()
    expect(mockGetSalesSummary).toHaveBeenCalledWith('v1', expect.objectContaining({ merchantAccountId: PROPIO }))
  })

  it('control: una clave que ya no está en la configuración pero tiene cobros de este negocio pasa', async () => {
    ;(prismaMock.payment.findFirst as jest.Mock).mockResolvedValue({ id: 'p1' })
    const next = await llamar(salesSummaryReport, { merchantAccountId: AJENO })
    expect(next).not.toHaveBeenCalled()
    expect(prismaMock.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'v1', merchantAccountId: AJENO } }),
    )
  })

  it('control: sin filtro de comercio no se consulta nada de más', async () => {
    const next = await llamar(salesSummaryReport, {})
    expect(next).not.toHaveBeenCalled()
    expect(mockConfig).not.toHaveBeenCalled()
  })
})
