/**
 * D15 (Codex r1 #3) — el archivo del Resumen de ventas lleva la advertencia cuando el puente QR legacy no contestó.
 *
 * Cómo se arma cada archivo decide dónde va: CSV y Excel salen de las filas (el aviso es la primera fila); el PDF corta las
 * celdas largas con «…», así que además lo lleva completo en las líneas bajo el título (`resumen`).
 */
import type { Request, Response } from 'express'

jest.mock('@/services/dashboard/sales-summary.dashboard.service', () => ({
  ...jest.requireActual('@/services/dashboard/sales-summary.dashboard.service'),
  getSalesSummary: jest.fn(),
}))
jest.mock('@/services/dashboard/export.helpers', () => {
  const real = jest.requireActual('@/services/dashboard/export.helpers')
  return { ...real, encodeExport: jest.fn(real.encodeExport) }
})

import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import { encodeExport } from '@/services/dashboard/export.helpers'
import { salesSummaryExport } from '@/controllers/dashboard/sales-summary.dashboard.controller'
import { prismaMock } from '@tests/__helpers__/setup'

const AVISO = 'No pudimos leer todos los cobros del sistema anterior de QR. Este total puede estar incompleto: vuelve a intentar.'

const REPORTE = {
  dateRange: { startDate: new Date('2026-10-01'), endDate: new Date('2026-10-31') },
  reportType: 'summary' as const,
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
  filtered: false,
}

async function exportar(format: 'csv' | 'xlsx' | 'pdf') {
  const res: Record<string, jest.Mock> = {}
  res.status = jest.fn(() => res)
  res.setHeader = jest.fn(() => res)
  res.send = jest.fn(() => res)
  res.json = jest.fn(() => res)
  const next = jest.fn()
  const req = {
    authContext: { venueId: 'v1', userId: 'u1', orgId: 'o1', role: 'OWNER' },
    query: { startDate: '2026-10-01', endDate: '2026-10-31', format },
    headers: {},
    params: {},
  } as unknown as Request
  await salesSummaryExport(req, res as unknown as Response, next)
  expect(next).not.toHaveBeenCalled()
  return { cuerpo: res.send.mock.calls[0][0] as Buffer, opciones: (encodeExport as jest.Mock).mock.calls[0][1] }
}

beforeEach(() => {
  ;(prismaMock.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: 'America/Mexico_City' })
})

// Carril F (full-testing W3 y W4): arriba van «Periodo» y «Filtros»; la advertencia sigue antes de las cifras, y en el PDF va completa
// bajo el título junto con esas dos líneas. Los nombres son los de la pantalla («Neto cobrado»).
type Fila = { seccion: string; concepto: string }

describe('exporte del Resumen de ventas con el puente QR caído', () => {
  beforeEach(() => (getSalesSummary as jest.Mock).mockResolvedValue({ ...REPORTE, legacyUnavailable: true }))

  it('🔴 CSV: la advertencia va justo después del periodo y los filtros, antes de las cifras', async () => {
    const { cuerpo } = await exportar('csv')
    const lineas = cuerpo
      .toString('utf8')
      .replace(/^\uFEFF/, '')
      .split('\r\n')
    expect(lineas[1]).toMatch(/^Periodo,/)
    expect(lineas[2]).toMatch(/^Filtros,/)
    expect(lineas[3]).toContain(AVISO)
    expect(lineas.findIndex(l => l.includes(AVISO))).toBeLessThan(lineas.findIndex(l => l.includes('Ventas brutas')))
    expect(lineas.some(l => l.includes('Neto cobrado'))).toBe(true)
  })

  it('🔴 Excel: sale de las mismas filas, con la advertencia antes de las cifras', async () => {
    const { opciones } = await exportar('xlsx')
    const filas = opciones.rows as Fila[]
    const aviso = filas.findIndex(f => f.seccion === 'Aviso' && f.concepto === AVISO)
    expect(aviso).toBeGreaterThanOrEqual(0)
    expect(aviso).toBeLessThan(filas.findIndex(f => f.seccion === 'Totales'))
  })

  it('🔴 PDF: la advertencia va completa bajo el título, después del periodo y los filtros', async () => {
    const { opciones } = await exportar('pdf')
    expect(opciones.resumen).toEqual([expect.stringMatching(/^Periodo: /), 'Filtros: Ninguno', AVISO])
    expect((opciones.rows as Fila[])[0]).toMatchObject({ seccion: 'Aviso', concepto: AVISO })
  })
})

describe('exporte del Resumen de ventas con el puente sano', () => {
  beforeEach(() => (getSalesSummary as jest.Mock).mockResolvedValue(REPORTE))

  it('ningún formato lleva advertencia (sólo el periodo y los filtros)', async () => {
    const { cuerpo, opciones } = await exportar('csv')
    expect(cuerpo.toString('utf8')).not.toContain('sistema anterior de QR')
    expect(opciones.resumen).toEqual([expect.stringMatching(/^Periodo: /), 'Filtros: Ninguno'])
    expect((opciones.rows as Fila[]).some(f => f.seccion === 'Aviso')).toBe(false)
  })
})
