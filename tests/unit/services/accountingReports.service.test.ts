/**
 * Unit tests (mock-first) for los Reportes contables (estado de resultados + balance general).
 * Lock: ingresos − costos − gastos = resultado, y la ECUACIÓN CONTABLE (activo = pasivo + capital,
 * donde el capital incluye el resultado del ejercicio).
 */
import { BadRequestError } from '../../../src/errors/AppError'

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    fiscalEmisor: { findFirst: jest.fn() },
    journalLine: { groupBy: jest.fn() },
    ledgerAccount: { findMany: jest.fn() },
  },
}))

import prisma from '../../../src/utils/prismaClient'
import { getAccountingReports } from '../../../src/services/fiscal/accountingReports.service'

const p = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  fiscalEmisor: { findFirst: jest.Mock }
  journalLine: { groupBy: jest.Mock }
  ledgerAccount: { findMany: jest.Mock }
}

beforeEach(() => {
  jest.clearAllMocks()
  p.venue.findUnique.mockResolvedValue({ organizationId: 'org1', rfc: 'TESC900101AAA', type: 'AUTO_SERVICE' })
  p.fiscalEmisor.findFirst.mockResolvedValue(null)
})

it('periodo inválido → 400', async () => {
  await expect(getAccountingReports('v1', '2026')).rejects.toThrow(BadRequestError)
})

it('sin RFC → needsFiscalSetup', async () => {
  p.venue.findUnique.mockResolvedValue({ organizationId: 'org1', rfc: null, type: 'AUTO_SERVICE' })
  const r = await getAccountingReports('v1', '2026-06')
  expect(r.needsFiscalSetup).toBe(true)
})

it('sin movimientos → reportes vacíos', async () => {
  p.journalLine.groupBy.mockResolvedValue([])
  const r = await getAccountingReports('v1', '2026-06')
  expect(r.incomeStatement.resultadoCents).toBe(0)
  expect(r.balanceSheet.balanced).toBe(true)
})

it('estado de resultados + balance general que cuadra con la ecuación contable', async () => {
  const agg = [
    { ledgerAccountId: 'banco', _sum: { debitCents: 11600, creditCents: 2000 } },
    { ledgerAccountId: 'ventas', _sum: { debitCents: 0, creditCents: 10000 } },
    { ledgerAccountId: 'iva', _sum: { debitCents: 0, creditCents: 1600 } },
    { ledgerAccountId: 'costo', _sum: { debitCents: 4000, creditCents: 0 } },
    { ledgerAccountId: 'inv', _sum: { debitCents: 0, creditCents: 4000 } },
    { ledgerAccountId: 'sueldos', _sum: { debitCents: 2000, creditCents: 0 } },
  ]
  p.journalLine.groupBy.mockResolvedValueOnce(agg).mockResolvedValueOnce(agg) // ytd + all
  p.ledgerAccount.findMany.mockResolvedValue([
    { id: 'banco', code: '102.01', name: 'Bancos', type: 'ACTIVO' },
    { id: 'ventas', code: '401.01', name: 'Ventas', type: 'INGRESO' },
    { id: 'iva', code: '208.01', name: 'IVA cobrado', type: 'PASIVO' },
    { id: 'costo', code: '501.01', name: 'Costo de venta', type: 'COSTO' },
    { id: 'inv', code: '115.01', name: 'Inventario', type: 'ACTIVO' },
    { id: 'sueldos', code: '601.01', name: 'Sueldos', type: 'GASTO' },
  ])

  const r = await getAccountingReports('v1', '2026-06')
  const is = r.incomeStatement
  const bs = r.balanceSheet

  expect(is.ingresos.totalCents).toBe(10000)
  expect(is.costos.totalCents).toBe(4000)
  expect(is.utilidadBrutaCents).toBe(6000)
  expect(is.gastos.totalCents).toBe(2000)
  expect(is.resultadoCents).toBe(4000)

  expect(bs.activo.totalCents).toBe(5600) // banco 9600 - inventario 4000
  expect(bs.pasivo.totalCents).toBe(1600)
  expect(bs.resultadoEjercicioCents).toBe(4000)
  expect(bs.resultadoEjerciciosAnterioresCents).toBe(0) // ejercicio único → sin acumulado anterior
  expect(bs.capital.totalCents).toBe(4000) // 0 capital + resultado
  expect(bs.capital.lines.some(l => l.name === 'Resultado del ejercicio' && l.amountCents === 4000)).toBe(true)
  expect(bs.balanced).toBe(true) // 5600 == 1600 + 4000
})

it('FY2+: el resultado de ejercicios ANTERIORES se reconoce en capital → la ecuación cuadra entre años', async () => {
  // FY2026 dejó +1000 (banco 1000 / ventas 1000); FY2027 (periodo actual) suma +500 más.
  // Balance = acumulado de TODO (banco 1500, ventas all 1500); P&L del ejercicio = sólo 2027 (500).
  const ytd = [
    { ledgerAccountId: 'banco', _sum: { debitCents: 500, creditCents: 0 } },
    { ledgerAccountId: 'ventas', _sum: { debitCents: 0, creditCents: 500 } },
  ]
  const all = [
    { ledgerAccountId: 'banco', _sum: { debitCents: 1500, creditCents: 0 } },
    { ledgerAccountId: 'ventas', _sum: { debitCents: 0, creditCents: 1500 } },
  ]
  p.journalLine.groupBy.mockResolvedValueOnce(ytd).mockResolvedValueOnce(all)
  p.ledgerAccount.findMany.mockResolvedValue([
    { id: 'banco', code: '102.01', name: 'Bancos', type: 'ACTIVO' },
    { id: 'ventas', code: '401.01', name: 'Ventas', type: 'INGRESO' },
  ])

  const r = await getAccountingReports('v1', '2027-06')
  const bs = r.balanceSheet

  expect(r.incomeStatement.resultadoCents).toBe(500) // resultado del EJERCICIO (sólo FY2027)
  expect(bs.resultadoEjercicioCents).toBe(500)
  expect(bs.resultadoEjerciciosAnterioresCents).toBe(1000) // FY2026 acumulado (antes: se perdía)
  expect(bs.capital.lines.some(l => l.name === 'Resultados de ejercicios anteriores' && l.amountCents === 1000)).toBe(true)
  expect(bs.capital.totalCents).toBe(1500) // 0 capital + 1000 anteriores + 500 ejercicio
  expect(bs.balanced).toBe(true) // 1500 == 0 + 1500  (antes daba FALSE: faltaba el resultado anterior)
})
