/**
 * Unit tests (mock-first) para IVA en flujo de efectivo (Capa B).
 * Lock fiscal: (1) suma multi-venue por RFC y hace el split de IVA UNA sola vez a nivel
 * contribuyente (Σ(splits) ≠ split(Σ)); (2) acreditable/retenciones/DIOT = null/false, NUNCA 0;
 * (3) periodo inválido → 400; (4) zeroActivity recuerda declarar en ceros.
 */
import { BadRequestError } from '../../../src/errors/AppError'

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
jest.mock('../../../src/utils/datetime', () => ({
  parseDbDateRange: () => ({ from: new Date('2026-06-01T06:00:00Z'), to: new Date('2026-07-01T05:59:59Z') }),
}))

import prisma from '../../../src/utils/prismaClient'
import { resolveScopeOrNull } from '../../../src/services/fiscal/chartOfAccounts.service'
import { getIncomeStatement } from '../../../src/services/dashboard/accounting.dashboard.service'
import { getIvaCashflow } from '../../../src/services/fiscal/ivaFlujo.service'

const p = prisma as unknown as {
  venue: { findMany: jest.Mock; findUnique: jest.Mock }
  cfdi: { aggregate: jest.Mock }
}
const mockScope = resolveScopeOrNull as jest.Mock
const mockIncome = getIncomeStatement as jest.Mock

const income = (netRevenueCents: number, salesCount = 1) => ({
  revenue: { grossSalesCents: netRevenueCents, refundsCents: 0, netRevenueCents, taxableBaseCents: 0, ivaCents: 0 },
  tips: { totalCents: 0 },
  metrics: { salesCount, refundCount: 0, averageTicketCents: 0 },
})

beforeEach(() => {
  jest.clearAllMocks()
  mockScope.mockResolvedValue({ organizationId: 'org1', rfc: 'EKU9003173C9', venueType: 'FOOD_SERVICE' })
  p.cfdi.aggregate.mockResolvedValue({ _sum: { taxCents: 0 }, _count: { _all: 0 } })
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

it('suma multi-venue del MISMO RFC y hace el split de IVA UNA vez a nivel contribuyente', async () => {
  // 2 locales del mismo RFC, misma org. Números elegidos para que Σ(splits) ≠ split(Σ).
  p.venue.findMany.mockResolvedValue([
    { id: 'v1', organizationId: 'org1', timezone: 'America/Mexico_City' },
    { id: 'v2', organizationId: 'org1', timezone: 'America/Mexico_City' },
  ])
  mockIncome.mockResolvedValueOnce(income(10000)).mockResolvedValueOnce(income(10001))

  const r = await getIvaCashflow('v1', '2026-06')

  // split(20001, 0.16): base = round(20001/1.16)=17242, tax = 20001-17242 = 2759
  // (Σ de splits por local daría 2758 — DISTINTO → prueba que el split es único)
  expect(r.ivaTrasladadoCobradoCents).toBe(2759)
  expect(r.baseGravableCents).toBe(17242)
  expect(r.venueIds).toEqual(['v1', 'v2'])
  expect(mockIncome).toHaveBeenCalledTimes(2)
})

it('placeholders Fase 2 = null (NUNCA 0) y el "a pagar" preliminar = trasladado (techo)', async () => {
  p.venue.findMany.mockResolvedValue([{ id: 'v1', organizationId: 'org1', timezone: 'America/Mexico_City' }])
  mockIncome.mockResolvedValue(income(116000))

  const r = await getIvaCashflow('v1', '2026-06')

  expect(r.acreditablePagadoCents).toBeNull()
  expect(r.retencionesCents).toBeNull()
  expect(r.saldoAFavorAplicadoCents).toBeNull()
  expect(r.incompletoPorFaltaDeGastos).toBe(true)
  expect(r.diot.disponible).toBe(false)
  expect(r.computedAt16Percent).toBe(true)
  // 116000 → split: base 100000, tax 16000; a pagar preliminar == trasladado (acreditable null→0)
  expect(r.ivaTrasladadoCobradoCents).toBe(16000)
  expect(r.ivaAPagarPreliminarCents).toBe(16000)
  expect(r.saldoAFavorDelPeriodoCents).toBe(0)
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
