/**
 * «Dentro de paquete» (founder «B», 20-nov-2026) y las apps de HOY (Codex r1 #5): la columna es del reporte del DASHBOARD, que pide el
 * plan de reportes avanzados. `/mobile` no pide ese plan, y el POS de ANDROID ordena los renglones por `unitsSold` y enseña los 10
 * primeros como «más vendidos». Por eso a `/mobile` le llega EXACTAMENTE lo de siempre: el servicio ni siquiera calcula lo de paquete
 * (sin renglones de 0 sueltas, sin campos nuevos por renglón ni en los totales).
 */
import type { Request, Response } from 'express'

const mockGetSalesByItem = jest.fn()
jest.mock('@/services/dashboard/sales-by-item.dashboard.service', () => ({
  getSalesByItem: (...a: unknown[]) => mockGetSalesByItem(...a),
}))
jest.mock('@/services/dashboard/sales-summary.dashboard.service', () => ({ getSalesSummary: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findUnique: jest.fn().mockResolvedValue({ timezone: 'America/Mexico_City' }) } },
}))

import { salesByItem } from '@/controllers/mobile/reports.mobile.controller'

async function pedir(query: Record<string, string>) {
  const json = jest.fn()
  const next = jest.fn()
  await salesByItem({ params: { venueId: 'v1' }, query } as unknown as Request, { json } as unknown as Response, next)
  return { body: json.mock.calls[0]?.[0], next }
}

const reporte = {
  dateRange: {},
  reportType: 'summary',
  items: [
    {
      productId: 'p',
      productName: 'Café',
      productSku: null,
      categoryName: null,
      unit: 'c/u',
      itemsSold: 1,
      unitsSold: 1,
      grossSales: 10,
      discounts: 0,
      netSales: 10,
    },
  ],
  totals: { itemsSold: 1, unitsSold: 1, grossSales: 10, discounts: 0, netSales: 10 },
}

describe('GET /mobile/…/reports/sales-by-item — «Dentro de paquete»', () => {
  beforeEach(() => mockGetSalesByItem.mockReset().mockResolvedValue(reporte))

  it.each([undefined, 'none', 'category'])('pide el reporte SIN lo de paquete (groupBy=%s)', async groupBy => {
    const { next } = await pedir({
      startDate: '2026-11-20T06:00:00.000Z',
      endDate: '2026-11-21T05:59:59.999Z',
      ...(groupBy ? { groupBy } : {}),
    })
    expect(next).not.toHaveBeenCalled()
    expect(mockGetSalesByItem).toHaveBeenCalledWith('v1', expect.objectContaining({ incluirDentroDePaquete: false }))
  })

  it('regresión: la respuesta es la del servicio, tal cual, como siempre', async () => {
    const { body } = await pedir({ startDate: '2026-11-20T06:00:00.000Z', endDate: '2026-11-21T05:59:59.999Z' })
    expect(body).toEqual({ success: true, data: reporte })
  })
})
