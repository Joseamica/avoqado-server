/**
 * «Dentro de paquete» (founder «B», 20-nov-2026) y las apps de HOY: el reporte del dashboard agrega renglones de platillos que
 * SÓLO se vendieron dentro de paquetes (0 sueltas, $0). El POS de ANDROID ordena los renglones por `unitsSold` y enseña los 10
 * primeros como «más vendidos»: con menos de 10 productos pintaría «Flauta de pollo · 0». A /mobile le llegan los mismos
 * renglones de siempre (todos con al menos una venta suelta); los campos nuevos viajan como opcionales.
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

const renglon = (over: Record<string, unknown>) => ({
  productId: 'p',
  productName: 'X',
  productSku: null,
  categoryName: null,
  unit: 'c/u',
  itemsSold: 1,
  unitsSold: 1,
  grossSales: 10,
  discounts: 0,
  netSales: 10,
  ...over,
})

async function pedir(query: Record<string, string>) {
  const json = jest.fn()
  const next = jest.fn()
  await salesByItem({ params: { venueId: 'v1' }, query } as unknown as Request, { json } as unknown as Response, next)
  return { body: json.mock.calls[0]?.[0], next }
}

describe('GET /mobile/…/reports/sales-by-item — «Dentro de paquete»', () => {
  beforeEach(() => mockGetSalesByItem.mockReset())

  it('no manda el renglón de un platillo que sólo se vendió dentro de paquetes; los demás llevan los campos nuevos', async () => {
    mockGetSalesByItem.mockResolvedValue({
      dateRange: {},
      reportType: 'summary',
      items: [
        renglon({ productId: 'p-paquete', productName: 'Paquete', unitsSold: 2, unitsInsidePackages: 0, totalUnits: 2 }),
        renglon({ productId: 'p-papa', productName: 'Flauta de papa', unitsSold: 3, unitsInsidePackages: 4, totalUnits: 7 }),
        renglon({
          productId: 'p-pollo',
          productName: 'Flauta de pollo',
          itemsSold: 0,
          unitsSold: 0,
          grossSales: 0,
          netSales: 0,
          unitsInsidePackages: 2,
          totalUnits: 2,
        }),
      ],
      totals: { itemsSold: 2, unitsSold: 5, grossSales: 20, discounts: 0, netSales: 20, unitsInsidePackages: 6, totalUnits: 11 },
    })

    const { body, next } = await pedir({ startDate: '2026-11-20T06:00:00.000Z', endDate: '2026-11-21T05:59:59.999Z' })

    expect(next).not.toHaveBeenCalled()
    expect(body.data.items.map((i: { productName: string }) => i.productName)).toEqual(['Paquete', 'Flauta de papa'])
    expect(body.data.items[1]).toMatchObject({ unitsSold: 3, unitsInsidePackages: 4, totalUnits: 7 })
    // Los totales de siempre no cambian (el renglón quitado sumaba cero en todos).
    expect(body.data.totals).toMatchObject({ itemsSold: 2, unitsSold: 5, grossSales: 20, netSales: 20 })
  })

  it('regresión: sin extras ligados la respuesta es la de siempre', async () => {
    const reporte = {
      dateRange: {},
      reportType: 'summary',
      items: [renglon({ productName: 'Café' })],
      totals: { itemsSold: 1, unitsSold: 1, grossSales: 10, discounts: 0, netSales: 10 },
    }
    mockGetSalesByItem.mockResolvedValue(reporte)

    const { body } = await pedir({ startDate: '2026-11-20T06:00:00.000Z', endDate: '2026-11-21T05:59:59.999Z', groupBy: 'category' })

    expect(body).toEqual({ success: true, data: reporte })
  })
})
