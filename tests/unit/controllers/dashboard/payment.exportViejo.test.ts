jest.mock('@/services/dashboard/payment.dashboard.service', () => ({
  ...jest.requireActual('@/services/dashboard/payment.dashboard.service'),
  countPaymentsForExport: jest.fn(),
  fetchPaymentsForExport: jest.fn(async () => []),
}))

import { countPaymentsForExport, fetchPaymentsForExport } from '@/services/dashboard/payment.dashboard.service'
import { exportPaymentsData } from '@/controllers/dashboard/payment.dashboard.controller'

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
  await exportPaymentsData({ params: { venueId: 'v1' }, query } as any, r, jest.fn())
  return r
}

describe('GET viejo de cobros (/payments/export) con la política de carril', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 de segundo plano (4,224 × 13 columnas, las alertas del 3-nov) ⇒ 413 «recarga la página» y NO trae filas', async () => {
    ;(countPaymentsForExport as jest.Mock).mockResolvedValue(4_224)
    const r = await pedir({ format: 'xlsx' })
    expect(r.statusCode).toBe(413)
    expect(r.body).toEqual({ success: false, message: 'Este archivo es grande: recarga la página para descargarlo en segundo plano' })
    expect(fetchPaymentsForExport).not.toHaveBeenCalled()
  })
  it('del carril directo (100 filas) ⇒ el archivo como hoy', async () => {
    ;(countPaymentsForExport as jest.Mock).mockResolvedValue(100)
    const r = await pedir({ format: 'csv' })
    expect(r.statusCode).toBe(200)
    expect(r.headers['Content-Disposition']).toMatch(/attachment; filename="payments-\d{4}-\d{2}-\d{2}\.csv"/)
    expect(r.send).toHaveBeenCalled()
  })
  it('frontera: 1,539 × 13 ya es 413; 3,000 filas con 2 columnas pedidas es directo', async () => {
    ;(countPaymentsForExport as jest.Mock).mockResolvedValue(1_539)
    expect((await pedir({ format: 'csv' })).statusCode).toBe(413)
    ;(countPaymentsForExport as jest.Mock).mockResolvedValue(3_000)
    expect((await pedir({ format: 'csv', columns: 'createdAt,amount' })).statusCode).toBe(200)
  })
  it('el PDF no cambia: 900 filas ⇒ archivo; 1,001 ⇒ el 413 de hoy', async () => {
    ;(countPaymentsForExport as jest.Mock).mockResolvedValue(900)
    expect((await pedir({ format: 'pdf' })).statusCode).toBe(200)
    ;(countPaymentsForExport as jest.Mock).mockResolvedValue(1_001)
    const r = await pedir({ format: 'pdf' })
    expect(r.statusCode).toBe(413)
    expect(r.body.message).toMatch(/PDF está limitado/)
  })
})
