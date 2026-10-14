const mockConstruir = jest.fn()
const mockContar = jest.fn()
const mockGenerar = jest.fn()
jest.mock('@/services/dashboard/settlementReport/settlementReport.service', () => ({
  ...jest.requireActual('@/services/dashboard/settlementReport/settlementReport.service'),
  construirReporte: (...a: unknown[]) => mockConstruir(...a),
  contarCandidatos: (...a: unknown[]) => mockContar(...a),
}))
jest.mock('@/services/dashboard/settlementReport/settlementReport.export', () => ({
  ...jest.requireActual('@/services/dashboard/settlementReport/settlementReport.export'),
  generarArchivo: (...a: unknown[]) => mockGenerar(...a),
}))
import { countSettlementReport, exportSettlementReport } from '@/controllers/dashboard/settlementReport.dashboard.controller'

const res = () => {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  r.send = jest.fn(() => r)
  r.setHeader = jest.fn()
  return r
}
const q = {
  startDate: '2026-08-01',
  endDate: '2026-08-31',
  dateBasis: 'charge',
  report: 'transactions',
  format: 'xlsx',
  columns: 'folio,total',
}

it('export: tope de Excel 5,000, filtros partidos, archivo como attachment', async () => {
  mockConstruir.mockResolvedValue({ any: 1 })
  mockGenerar.mockResolvedValue({
    buffer: Buffer.from('x'),
    contentType: 'ct',
    extension: 'xlsx',
    nombre: 'transacciones-2026-08-01-a-2026-08-31.xlsx',
  })
  const r = res()
  const next = jest.fn()
  await exportSettlementReport({ params: { venueId: 'v1' }, query: { ...q, cardTypes: 'DEBIT,NONE' } } as any, r, next)
  expect(mockConstruir).toHaveBeenCalledWith(
    expect.objectContaining({ venueId: 'v1', tope: 5000, filtros: expect.objectContaining({ cardTypes: ['DEBIT', 'NONE'] }) }),
  )
  expect(r.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="transacciones-2026-08-01-a-2026-08-31.xlsx"')
  expect(next).not.toHaveBeenCalled()
})
it('acepta filtros ya convertidos en arreglo por validateRequest', async () => {
  mockConstruir.mockResolvedValue({})
  mockGenerar.mockResolvedValue({ buffer: Buffer.from(''), contentType: 'c', extension: 'xlsx', nombre: 'n.xlsx' })
  await exportSettlementReport(
    { params: { venueId: 'v1' }, query: { ...q, columns: ['folio'], brands: ['VISA'] } } as any,
    res(),
    jest.fn(),
  )
  expect(mockGenerar).toHaveBeenCalledWith({}, 'transactions', 'xlsx', ['folio'])
  expect(mockConstruir).toHaveBeenCalledWith(expect.objectContaining({ filtros: expect.objectContaining({ brands: ['VISA'] }) }))
})
it('export CSV usa el tope de 10,000', async () => {
  mockConstruir.mockResolvedValue({})
  mockGenerar.mockResolvedValue({ buffer: Buffer.from(''), contentType: 'c', extension: 'csv', nombre: 'n.csv' })
  await exportSettlementReport({ params: { venueId: 'v1' }, query: { ...q, format: 'csv' } } as any, res(), jest.fn())
  expect(mockConstruir).toHaveBeenCalledWith(expect.objectContaining({ tope: 10000 }))
})
it('el 413 del servicio pasa a next (no se manda archivo)', async () => {
  const { ReporteDemasiadoGrandeError } = jest.requireActual('@/services/dashboard/settlementReport/settlementReport.service')
  mockConstruir.mockRejectedValue(new ReporteDemasiadoGrandeError(12000, 5000))
  const r = res()
  const next = jest.fn()
  await exportSettlementReport({ params: { venueId: 'v1' }, query: q } as any, r, next)
  expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 413 }))
  expect(r.send).not.toHaveBeenCalled()
})
it('count devuelve los topes por formato', async () => {
  mockContar.mockResolvedValue({ candidateCount: 3464, windowFrom: 'a', windowTo: 'b' })
  const r = res()
  await countSettlementReport({ params: { venueId: 'v1' }, query: q } as any, r, jest.fn())
  expect(r.json).toHaveBeenCalledWith({
    success: true,
    data: { candidateCount: 3464, windowFrom: 'a', windowTo: 'b', caps: { xlsx: 5000, csv: 10000 } },
  })
})
