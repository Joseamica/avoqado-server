/**
 * Unit tests (mock-first) para IVA en flujo de efectivo (Capa B).
 * Lock fiscal: (1) suma multi-venue por RFC la base y el IVA que cada income statement ya calculó por
 * tasa real (el split es por-pago dentro de getIncomeStatement, no un split único del agregado);
 * (2) IVA acreditable pagado (Fase 2) resta al IVA a cargo y el IVA retenido a proveedores se reporta
 * aparte; la retención de ventas sigue null (NUNCA 0); (3) periodo inválido → 400; (4) zeroActivity
 * recuerda declarar en ceros.
 */
import { BadRequestError } from '../../../src/errors/AppError'
import { splitIvaIncluded } from '../../../src/services/fiscal/ivaMath'

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findMany: jest.fn(), findUnique: jest.fn() },
    cfdi: { aggregate: jest.fn() },
  },
}))
jest.mock('../../../src/services/fiscal/chartOfAccounts.service', () => ({
  resolveScopeOrNull: jest.fn(),
}))
jest.mock('../../../src/services/dashboard/accounting.dashboard.service', () => ({
  getIncomeStatement: jest.fn(),
}))
jest.mock('../../../src/services/fiscal/expense.service', () => ({
  getAcreditablePagado: jest.fn(),
}))
jest.mock('../../../src/utils/datetime', () => ({
  parseDbDateRange: () => ({ from: new Date('2026-06-01T06:00:00Z'), to: new Date('2026-07-01T05:59:59Z') }),
}))

import prisma from '../../../src/utils/prismaClient'
import { resolveScopeOrNull } from '../../../src/services/fiscal/chartOfAccounts.service'
import { getIncomeStatement } from '../../../src/services/dashboard/accounting.dashboard.service'
import { getAcreditablePagado } from '../../../src/services/fiscal/expense.service'
import { getIvaCashflow } from '../../../src/services/fiscal/ivaFlujo.service'

const p = prisma as unknown as {
  venue: { findMany: jest.Mock; findUnique: jest.Mock }
  cfdi: { aggregate: jest.Mock }
}
const mockScope = resolveScopeOrNull as jest.Mock
const mockIncome = getIncomeStatement as jest.Mock
const mockAcreditable = getAcreditablePagado as jest.Mock
const acreditableResult = (acreditablePagadoCents: number, ivaRetenidoTercerosCents = 0) => ({
  organizationId: 'org1',
  rfc: 'EKU9003173C9',
  period: '2026-06',
  acreditablePagadoCents,
  ivaRetenidoTercerosCents,
  isrRetenidoTercerosCents: 0,
  expenseCount: acreditablePagadoCents > 0 ? 1 : 0,
})

// Mock de un income statement de un local: el monto es GROSS (IVA-incluido) y se desglosa al 16% como
// lo haría el read-model real (base + IVA por tasa). ivaFlujo SUMA estos campos ya calculados.
const income = (grossCents: number, salesCount = 1) => {
  const { netCents, taxCents } = splitIvaIncluded(grossCents, 0.16)
  return {
    revenue: {
      grossSalesCents: grossCents,
      refundsCents: 0,
      netRevenueCents: grossCents,
      taxableBaseCents: netCents,
      ivaCents: taxCents,
      taxByRate: taxCents ? { '0.16': taxCents } : {},
    },
    tips: { totalCents: 0 },
    metrics: { salesCount, refundCount: 0, averageTicketCents: 0 },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockScope.mockResolvedValue({ organizationId: 'org1', rfc: 'EKU9003173C9', venueType: 'FOOD_SERVICE' })
  p.cfdi.aggregate.mockResolvedValue({ _sum: { taxCents: 0 }, _count: { _all: 0 } })
  mockAcreditable.mockResolvedValue(acreditableResult(0)) // por defecto: sin gastos acreditables
})

it('periodo inválido (mes 13) → 400', async () => {
  await expect(getIvaCashflow('v1', '2026-13')).rejects.toThrow(BadRequestError)
})

it('sin RFC → needsFiscalSetup, no consulta ingresos', async () => {
  mockScope.mockResolvedValue(null)
  const r = await getIvaCashflow('v1', '2026-06')
  expect(r.needsFiscalSetup).toBe(true)
  expect(mockIncome).not.toHaveBeenCalled()
})

it('suma multi-venue del MISMO RFC la base y el IVA ya calculados por local (split por-pago, no del agregado)', async () => {
  // 2 locales del mismo RFC, misma org. Cada income statement ya trae su split al 16%; ivaFlujo SUMA.
  p.venue.findMany.mockResolvedValue([
    { id: 'v1', organizationId: 'org1', timezone: 'America/Mexico_City' },
    { id: 'v2', organizationId: 'org1', timezone: 'America/Mexico_City' },
  ])
  mockIncome.mockResolvedValueOnce(income(10000)).mockResolvedValueOnce(income(10001))

  const r = await getIvaCashflow('v1', '2026-06')

  // v1 10000 → base 8621, tax 1379 · v2 10001 → base 8622, tax 1379 · Σ tax 2758, Σ base 17243
  expect(r.ivaTrasladadoCobradoCents).toBe(2758)
  expect(r.baseGravableCents).toBe(17243)
  expect(r.ivaTrasladadoPorTasaCents).toEqual({ '0.16': 2758 })
  expect(r.venueIds).toEqual(['v1', 'v2'])
  expect(mockIncome).toHaveBeenCalledTimes(2)
})

it('sin gastos acreditables: acreditable=0 disponible, retención de ventas null (NUNCA 0), a pagar = trasladado', async () => {
  p.venue.findMany.mockResolvedValue([{ id: 'v1', organizationId: 'org1', timezone: 'America/Mexico_City' }])
  mockIncome.mockResolvedValue(income(116000))

  const r = await getIvaCashflow('v1', '2026-06')

  expect(r.acreditablePagadoCents).toBe(0) // disponible (lado gastos existe), 0 legítimo
  expect(r.acreditableDisponible).toBe(true)
  expect(r.incompletoPorFaltaDeGastos).toBe(false)
  expect(r.retencionesCents).toBeNull() // retención AL contribuyente (ventas) aún no capturada
  expect(r.saldoAFavorAplicadoCents).toBeNull()
  expect(r.computedAt16Percent).toBe(false) // IVA por tasa real; ya no es un 16% plano asumido
  // 116000 → split: base 100000, tax 16000; sin acreditable, a pagar == trasladado
  expect(r.ivaTrasladadoCobradoCents).toBe(16000)
  expect(r.ivaAPagarPreliminarCents).toBe(16000)
  expect(r.saldoAFavorDelPeriodoCents).toBe(0)
})

it('con IVA acreditable pagado: resta al IVA a cargo y reporta el IVA retenido a proveedores aparte', async () => {
  p.venue.findMany.mockResolvedValue([{ id: 'v1', organizationId: 'org1', timezone: 'America/Mexico_City' }])
  mockIncome.mockResolvedValue(income(116000)) // trasladado 16000
  mockAcreditable.mockResolvedValue(acreditableResult(10000, 500)) // acreditable 10000, IVA retenido a terceros 500

  const r = await getIvaCashflow('v1', '2026-06')

  expect(r.acreditablePagadoCents).toBe(10000)
  expect(r.ivaRetenidoTercerosCents).toBe(500) // obligación separada, NO resta al neto
  expect(r.ivaAPagarPreliminarCents).toBe(6000) // 16000 − 10000
  expect(r.saldoAFavorDelPeriodoCents).toBe(0)
})

it('acreditable > trasladado → saldo a favor del periodo (neto negativo)', async () => {
  p.venue.findMany.mockResolvedValue([{ id: 'v1', organizationId: 'org1', timezone: 'America/Mexico_City' }])
  mockIncome.mockResolvedValue(income(116000)) // trasladado 16000
  mockAcreditable.mockResolvedValue(acreditableResult(20000)) // acreditable 20000 > 16000

  const r = await getIvaCashflow('v1', '2026-06')
  expect(r.ivaAPagarPreliminarCents).toBe(0)
  expect(r.saldoAFavorDelPeriodoCents).toBe(4000) // 20000 − 16000
})

it('sin ventas cobradas → zeroActivity (recordar declarar en ceros)', async () => {
  p.venue.findMany.mockResolvedValue([{ id: 'v1', organizationId: 'org1', timezone: 'America/Mexico_City' }])
  mockIncome.mockResolvedValue(income(0, 0))

  const r = await getIvaCashflow('v1', '2026-06')
  expect(r.zeroActivity).toBe(true)
  expect(r.ivaTrasladadoCobradoCents).toBe(0)
})

it('RFC que abarca >1 organización → flag rfcSpansMultipleOrgs (igual se suman)', async () => {
  p.venue.findMany.mockResolvedValue([
    { id: 'v1', organizationId: 'org1', timezone: 'America/Mexico_City' },
    { id: 'v2', organizationId: 'org2', timezone: 'America/Mexico_City' },
  ])
  mockIncome.mockResolvedValue(income(58000))

  const r = await getIvaCashflow('v1', '2026-06')
  expect(r.rfcSpansMultipleOrgs).toBe(true)
  expect(r.venueIds).toHaveLength(2)
})

it('CFDI contraste: Σ Cfdi.taxCents se reporta como ivaAmparadoPorCfdi (NO como base)', async () => {
  p.venue.findMany.mockResolvedValue([{ id: 'v1', organizationId: 'org1', timezone: 'America/Mexico_City' }])
  mockIncome.mockResolvedValue(income(116000))
  p.cfdi.aggregate.mockResolvedValue({ _sum: { taxCents: 9999 }, _count: { _all: 3 } })

  const r = await getIvaCashflow('v1', '2026-06')
  expect(r.ivaAmparadoPorCfdiCents).toBe(9999)
  expect(r.cfdiCount).toBe(3)
  // el contraste NO cambia la base derivada de Payments
  expect(r.ivaTrasladadoCobradoCents).toBe(16000)
})
