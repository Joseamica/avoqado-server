import { Prisma } from '@prisma/client'
import { getBasicMetricsData, getBasicMetricsDetailsPage } from '@/services/dashboard/generalStats.dashboard.service'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/legacy/qrPayments.legacy.service', () => ({
  MINDFORM_NEW_VENUE_ID: 'cmisvi38o001fhr2828ygmxi2',
  getLegacyPayments: jest.fn(),
  forEachLegacyPaymentPage: jest.fn(),
}))

const RANGO = { fromDate: '2026-10-14T06:00:00.000Z', toDate: '2026-10-15T05:59:59.999Z' }
/**
 * Texto de una llamada a `$queryRaw` con plantilla: las cadenas y los fragmentos `Prisma.Sql` que lleva dentro. Se reconocen por su
 * forma (`strings`), no con `instanceof Prisma.Sql`: el cliente generado exporta `Sql` sólo como tipo, en ejecución es `undefined`.
 */
const esFragmentoSql = (v: unknown): v is Prisma.Sql => !!v && typeof v === 'object' && Array.isArray((v as { strings?: unknown }).strings)
const textoDe = (llamada: unknown[]) => {
  const [cadenas, ...valores] = llamada as [TemplateStringsArray, ...unknown[]]
  return [...cadenas, ...valores.map(v => (esFragmentoSql(v) ? v.sql : ''))].join(' ')
}

beforeEach(() => {
  ;(prismaMock.$queryRaw as jest.Mock).mockReset()
  ;(prismaMock.payment.findMany as jest.Mock).mockReset()
  ;(prismaMock.venue.findUnique as jest.Mock).mockResolvedValue({ id: 'v1', timezone: 'UTC' })
})

describe('Inicio (basic-metrics) · tarjetas de regalo', () => {
  it('🔴 el KPI se suma en SQL sin las cuentas de tarjetas', async () => {
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0, fiveStar: 0 }])
    await getBasicMetricsData('v1', { ...RANGO, responseMode: 'aggregated-v1' })
    expect(textoDe((prismaMock.$queryRaw as jest.Mock).mock.calls[0])).toContain(
      'gc_oi."orderId" = p."orderId" AND gc_oi."giftCardId" IS NOT NULL',
    )
  })

  it('el detalle (exportar) usa el mismo filtro que el KPI', async () => {
    ;(prismaMock.payment.findMany as jest.Mock).mockResolvedValue([])
    await getBasicMetricsDetailsPage('v1', { ...RANGO, kind: 'payments', limit: 10 })
    expect((prismaMock.payment.findMany as jest.Mock).mock.calls[0][0].where.order).toEqual({
      status: { not: 'CANCELLED' },
      items: { none: { giftCardId: { not: null } } },
    })
  })
})
