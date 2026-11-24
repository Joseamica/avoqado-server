/**
 * Carril F2 (hz:fefa11b6:D7, plan v5): la lectura del periodo comparado no toca el puente del QR anterior (`skipLegacyQr`). Sin la
 * opción, la cabecera del negocio del puente lo recorre como siempre (los demás lectores de `getSalesSummary` no la pasan).
 */
const mockRecorrido = jest.fn()
jest.mock('@/services/legacy/qrPayments.legacy.service', () => ({
  ...jest.requireActual('@/services/legacy/qrPayments.legacy.service'),
  forEachLegacyPaymentPage: (...a: unknown[]) => mockRecorrido(...a),
}))

import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import { MINDFORM_NEW_VENUE_ID } from '@/services/legacy/qrPayments.legacy.service'
import { prismaMock } from '@tests/__helpers__/setup'

const rango = { startDate: '2026-11-16T06:00:00.000Z', endDate: '2026-11-23T05:59:59.999Z', timezone: 'America/Mexico_City' }

beforeEach(() => {
  mockRecorrido.mockReset().mockResolvedValue({ unavailable: false })
  // El ayudante no trae `$queryRawUnsafe`: las consultas crudas de la cabecera contestan vacío.
  prismaMock.$queryRawUnsafe = jest.fn().mockResolvedValue([])
  ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([])
  ;(prismaMock.payment.aggregate as jest.Mock).mockResolvedValue({ _sum: {}, _count: 0 })
  ;(prismaMock.payment.count as jest.Mock).mockResolvedValue(0)
  ;(prismaMock.payment.groupBy as jest.Mock).mockResolvedValue([])
  ;(prismaMock.commissionCalculation.aggregate as jest.Mock).mockResolvedValue({ _sum: {} })
  ;(prismaMock.giftCard.findFirst as jest.Mock).mockResolvedValue(null)
})

describe('getSalesSummary · skipLegacyQr', () => {
  it('🔴 con skipLegacyQr la cabecera del negocio del puente no lo recorre', async () => {
    await getSalesSummary(MINDFORM_NEW_VENUE_ID, { ...rango, skipLegacyQr: true })
    expect(mockRecorrido).not.toHaveBeenCalled()
  })

  it('sin la opción, lo recorre como siempre (regresión)', async () => {
    await getSalesSummary(MINDFORM_NEW_VENUE_ID, rango)
    expect(mockRecorrido).toHaveBeenCalledTimes(1)
  })
})
