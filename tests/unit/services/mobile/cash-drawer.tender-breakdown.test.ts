/**
 * Desglose por método de pago del corte (`GET …/cash-drawer/tender-breakdown`).
 *
 * Revisión del 5-sep-2026: era un `findMany` sin `take` que traía cada cobro del rango para sumarlo
 * en memoria, y mientras el único consumidor fue el corte del día de Android/iOS la ventana la
 * acotaba la sesión. El reporte de la PAX usa el MISMO endpoint con «últimos 90 días» o un rango
 * libre: la agregación pasa a SQL (`groupBy`) y el rango se acota aquí, no en el llamador.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { getTenderBreakdown, TENDER_BREAKDOWN_MAX_DIAS } from '@/services/mobile/cash-drawer.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const DESDE = new Date('2026-09-01T06:00:00Z')
const HASTA = new Date('2026-09-02T05:59:59Z')
const dia = 24 * 60 * 60 * 1000

const grupo = (method: string | null, amount: number, tip: number) => ({
  method,
  _sum: { amount, tipAmount: tip },
  _count: { _all: 1 },
})

beforeEach(() => jest.clearAllMocks())

describe('getTenderBreakdown — agrega en SQL y acota el rango', () => {
  it('🔴 agrega con `groupBy` por método (una fila por método), nunca con un findMany de cada cobro', async () => {
    ;(prismaMock as any).payment.groupBy.mockResolvedValue([grupo('CASH', 1000, 0), grupo('CREDIT_CARD', 350.5, 40)])

    const r = await getTenderBreakdown(VENUE, DESDE, HASTA)

    expect((prismaMock as any).payment.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['method'],
        where: { venueId: VENUE, status: 'COMPLETED', createdAt: { gte: DESDE, lte: HASTA } },
        _sum: { amount: true, tipAmount: true },
      }),
    )
    expect((prismaMock as any).payment.findMany).not.toHaveBeenCalled()
    // `total` incluye la propina (es lo que entró por ese método); `tips` la desglosa aparte.
    expect(r.tenderBreakdown).toEqual([
      { method: 'CASH', total: 1000, tips: 0 },
      { method: 'CREDIT_CARD', total: 390.5, tips: 40 },
    ])
    expect(r.totalTips).toBe(40)
  })

  it('🔴 un método cuya venta y reembolso se cancelan sigue apareciendo, en cero, en vez de desaparecer del corte', async () => {
    ;(prismaMock as any).payment.groupBy.mockResolvedValue([grupo('CASH', 500, 0), grupo('CREDIT_CARD', 0, 0)])

    const r = await getTenderBreakdown(VENUE, DESDE, HASTA)

    expect(r.tenderBreakdown).toEqual([
      { method: 'CASH', total: 500, tips: 0 },
      { method: 'CREDIT_CARD', total: 0, tips: 0 },
    ])
  })

  it('sin cobros en el rango la lista va VACÍA (es lo que la app lee como «no hubo cobros en este corte»)', async () => {
    ;(prismaMock as any).payment.groupBy.mockResolvedValue([])

    const r = await getTenderBreakdown(VENUE, DESDE, HASTA)

    expect(r.tenderBreakdown).toEqual([])
    expect(r.totalTips).toBe(0)
    expect(r.from).toBe(DESDE.toISOString())
    expect(r.to).toBe(HASTA.toISOString())
  })

  it('un método nulo (fila legacy) se reporta como OTHER', async () => {
    ;(prismaMock as any).payment.groupBy.mockResolvedValue([grupo(null, 20, 0)])

    const r = await getTenderBreakdown(VENUE, DESDE, HASTA)

    expect(r.tenderBreakdown[0].method).toBe('OTHER')
  })

  it(`🔴 rechaza un rango mayor a ${TENDER_BREAKDOWN_MAX_DIAS} días sin tocar la base`, async () => {
    const hasta = new Date(DESDE.getTime() + (TENDER_BREAKDOWN_MAX_DIAS + 1) * dia)

    await expect(getTenderBreakdown(VENUE, DESDE, hasta)).rejects.toThrow(/días/)
    expect((prismaMock as any).payment.groupBy).not.toHaveBeenCalled()
  })

  it(`acepta exactamente ${TENDER_BREAKDOWN_MAX_DIAS} días: el reporte de 90 días de la PAX cabe con margen`, async () => {
    ;(prismaMock as any).payment.groupBy.mockResolvedValue([])
    const hasta = new Date(DESDE.getTime() + TENDER_BREAKDOWN_MAX_DIAS * dia)

    await expect(getTenderBreakdown(VENUE, DESDE, hasta)).resolves.toBeDefined()
  })

  it('rechaza un rango invertido (`to` antes de `from`)', async () => {
    await expect(getTenderBreakdown(VENUE, HASTA, DESDE)).rejects.toThrow(/anterior/)
    expect((prismaMock as any).payment.groupBy).not.toHaveBeenCalled()
  })
})
