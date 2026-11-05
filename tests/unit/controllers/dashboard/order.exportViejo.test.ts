jest.mock('@/services/dashboard/order.dashboard.service', () => ({
  ...jest.requireActual('@/services/dashboard/order.dashboard.service'),
  countOrdersForExport: jest.fn(),
  fetchOrdersForExport: jest.fn(async () => []),
}))

import { countOrdersForExport, fetchOrdersForExport } from '@/services/dashboard/order.dashboard.service'
import { exportOrdersData } from '@/controllers/dashboard/order.dashboard.controller'

function res() {
  const r: any = { statusCode: 200, headers: {} }
  r.status = jest.fn((c: number) => {
    r.statusCode = c
    return r
  })
  r.json = jest.fn((b: any) => {
    r.body = b
    return r
  })
  r.setHeader = jest.fn((k: string, v: string) => {
    r.headers[k] = v
  })
  r.send = jest.fn()
  return r
}
const pedir = async (query: Record<string, string>) => {
  const r = res()
  await exportOrdersData({ params: { venueId: 'v1' }, query } as any, r, jest.fn())
  return r
}
const con = (n: number) => (countOrdersForExport as jest.Mock).mockResolvedValue(n)

describe('GET viejo de órdenes (/orders/export) con la política de carril', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 de segundo plano (2,000 × 11 columnas) ⇒ 413 «recarga la página» y NO trae filas', async () => {
    con(2_000)
    const r = await pedir({ format: 'xlsx' })
    expect(r.statusCode).toBe(413)
    expect(r.body).toEqual({ success: false, message: 'Este archivo es grande: recarga la página para descargarlo en segundo plano' })
    expect(fetchOrdersForExport).not.toHaveBeenCalled()
  })
  it('del carril directo (100 filas) ⇒ el archivo como hoy', async () => {
    con(100)
    const r = await pedir({ format: 'csv' })
    expect(r.statusCode).toBe(200)
    expect(r.headers['Content-Disposition']).toMatch(/attachment; filename="orders-\d{4}-\d{2}-\d{2}\.csv"/)
    expect(r.send).toHaveBeenCalled()
  })
  it('frontera: 1,818 × 11 = 19,998 es directo; 1,819 × 11 = 20,009 es 413; 5,000 filas con 3 columnas es directo', async () => {
    con(1_818)
    expect((await pedir({ format: 'csv' })).statusCode).toBe(200)
    con(1_819)
    expect((await pedir({ format: 'csv' })).statusCode).toBe(413)
    con(5_000)
    expect((await pedir({ format: 'csv', columns: 'createdAt,orderId,total' })).statusCode).toBe(200)
  })
  it('el PDF no cambia: 900 filas ⇒ archivo; 1,001 ⇒ el 413 de hoy (mensaje de PDF)', async () => {
    con(900)
    expect((await pedir({ format: 'pdf' })).statusCode).toBe(200)
    con(1_001)
    const r = await pedir({ format: 'pdf' })
    expect(r.statusCode).toBe(413)
    expect(r.body.message).toMatch(/PDF está limitado/)
  })
})
