/**
 * Unit tests (mock-first) para ISR — pago provisional (Capa B).
 *  - RESICO: ingresos del mes × tasa por tramo (1%–2.5%), sin deducciones.
 *  - GENERAL: (ingresos − deducciones) acumulado × tarifa art-96 acumulada − pagos previos.
 *  - tope RESICO $3.5M anual; periodo inválido → 400.
 */
import { BadRequestError } from '../../../src/errors/AppError'

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findMany: jest.fn(), findUnique: jest.fn() },
    expense: { aggregate: jest.fn() },
  },
}))
jest.mock('../../../src/services/fiscal/chartOfAccounts.service', () => ({ resolveScopeOrNull: jest.fn() }))
jest.mock('../../../src/services/dashboard/accounting.dashboard.service', () => ({ getIncomeStatement: jest.fn() }))
jest.mock('../../../src/services/fiscal/salesRetention.service', () => ({ getSalesRetentionCents: jest.fn() }))
jest.mock('../../../src/services/fiscal/cogs.service', () => ({ computePeriodCogsCentsRange: jest.fn() }))

import prisma from '../../../src/utils/prismaClient'
import { resolveScopeOrNull } from '../../../src/services/fiscal/chartOfAccounts.service'
import { getIncomeStatement } from '../../../src/services/dashboard/accounting.dashboard.service'
import { getSalesRetentionCents } from '../../../src/services/fiscal/salesRetention.service'
import { computePeriodCogsCentsRange } from '../../../src/services/fiscal/cogs.service'
import { getIsrProvisional } from '../../../src/services/fiscal/isr.service'

const p = prisma as unknown as {
  venue: { findMany: jest.Mock; findUnique: jest.Mock }
  expense: { aggregate: jest.Mock }
}
const mScope = resolveScopeOrNull as jest.Mock
const mIncome = getIncomeStatement as jest.Mock
const mSalesRet = getSalesRetentionCents as jest.Mock
const mCogs = computePeriodCogsCentsRange as jest.Mock

// La base de ISR es SIN IVA → el monto representa `taxableBaseCents` (lo que ISR usa como ingreso).
const income = (baseCents: number, salesCount = 1) => {
  const rev = {
    grossSalesCents: baseCents,
    refundsCents: 0,
    netRevenueCents: baseCents,
    taxableBaseCents: baseCents,
    ivaCents: 0,
    taxByRate: {} as Record<string, number>,
  }
  // Sin exclusiones de alcance → la vista fiscal espeja la gerencial (ISR lee fiscalRevenue).
  return {
    revenue: rev,
    fiscalRevenue: rev,
    tips: { totalCents: 0 },
    metrics: { salesCount, refundCount: 0, averageTicketCents: 0 },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mScope.mockResolvedValue({ organizationId: 'org1', rfc: 'EKU9003173C9', venueType: 'AUTO_SERVICE' })
  p.venue.findMany.mockResolvedValue([{ id: 'v1', organizationId: 'org1' }])
  p.expense.aggregate.mockResolvedValue({ _sum: { subtotalCents: 0, descuentoCents: 0, iepsCents: 0 } })
  mSalesRet.mockResolvedValue(null) // sin retención capturada por default
  mCogs.mockResolvedValue(0) // sin costo de ventas por default (RESICO lo ignora)
})

describe('getIsrProvisional — RESICO', () => {
  it('periodo inválido → BadRequestError', async () => {
    await expect(getIsrProvisional('v1', '2026-13', 'RESICO')).rejects.toThrow(BadRequestError)
  })

  it('sin RFC → needsFiscalSetup', async () => {
    mScope.mockResolvedValue(null)
    const r = await getIsrProvisional('v1', '2026-06', 'RESICO')
    expect(r.needsFiscalSetup).toBe(true)
  })

  it('$20,000/mes → tasa 1% → ISR $200', async () => {
    mIncome.mockResolvedValue(income(20_000_00))
    const r = await getIsrProvisional('v1', '2026-06', 'RESICO')
    expect(r.tasaResico).toBe(0.01)
    expect(r.isrCausadoCents).toBe(200_00)
    expect(r.isrAPagarCents).toBe(200_00)
  })

  it('resta la retención de ISR en ventas capturada del periodo', async () => {
    mIncome.mockResolvedValue(income(20_000_00)) // ISR causado $200
    mSalesRet.mockResolvedValue({ isrRetenidoCents: 50_00, ivaRetenidoCents: 0 }) // le retuvieron $50
    const r = await getIsrProvisional('v1', '2026-06', 'RESICO')
    expect(r.retencionesIsrCents).toBe(50_00)
    expect(r.isrAPagarCents).toBe(150_00) // 200 − 50
  })

  it('$60,000/mes → tasa 1.5% → ISR $900', async () => {
    mIncome.mockResolvedValue(income(60_000_00))
    const r = await getIsrProvisional('v1', '2026-06', 'RESICO')
    expect(r.tasaResico).toBe(0.015)
    expect(r.isrCausadoCents).toBe(900_00)
  })

  it('marca excedeTopeResico si los ingresos ACUMULADOS rebasan $3.5M', async () => {
    mIncome.mockResolvedValue(income(4_000_000_00))
    const r = await getIsrProvisional('v1', '2026-06', 'RESICO')
    expect(r.excedeTopeResico).toBe(true)
  })

  it('sin ventas → zeroActivity, ISR 0', async () => {
    mIncome.mockResolvedValue(income(0, 0))
    const r = await getIsrProvisional('v1', '2026-06', 'RESICO')
    expect(r.zeroActivity).toBe(true)
    expect(r.isrCausadoCents).toBe(0)
  })
})

describe('getIsrProvisional — RESICO tabla de tasas por tramo (fronteras exactas)', () => {
  // `resicoTasa` usa `<=`: la frontera (tope) pertenece al tramo INFERIOR; un centavo más salta al siguiente.
  // Tabla 2024/2025: ≤25k→1% · ≤50k→1.1% · ≤83,333.33→1.5% · ≤208,333.33→2% · resto→2.5%.
  const casos: [string, number, number][] = [
    ['$1 (piso)', 1_00, 0.01],
    ['$25,000 exacto → tope del 1%', 25_000_00, 0.01],
    ['$25,000.01 → salta a 1.1%', 25_000_01, 0.011],
    ['$40,000 → dentro del 1.1%', 40_000_00, 0.011],
    ['$50,000 exacto → tope del 1.1%', 50_000_00, 0.011],
    ['$50,000.01 → salta a 1.5%', 50_000_01, 0.015],
    ['$83,333.33 exacto → tope del 1.5%', 83_333_33, 0.015],
    ['$83,333.34 → salta a 2%', 83_333_34, 0.02],
    ['$208,333.33 exacto → tope del 2%', 208_333_33, 0.02],
    ['$208,333.34 → salta a 2.5%', 208_333_34, 0.025],
    ['$300,000 → dentro del 2.5%', 300_000_00, 0.025],
  ]
  it.each(casos)('%s', async (_label, ingresoCents, tasaEsperada) => {
    mIncome.mockResolvedValue(income(ingresoCents))
    const r = await getIsrProvisional('v1', '2026-06', 'RESICO')
    expect(r.tasaResico).toBe(tasaEsperada)
    expect(r.isrCausadoCents).toBe(Math.round(ingresoCents * tasaEsperada))
    expect(r.excedeTopeResico).toBe(false) // ningún caso rebasa el tope anual $3.5M
  })
})

describe('getIsrProvisional — GENERAL (art 96)', () => {
  it('enero: utilidad = ingresos − deducciones; ISR por tarifa art-96 (exacto)', async () => {
    mIncome.mockResolvedValue(income(30_000_00)) // ingresos acum ene = $30,000
    p.expense.aggregate.mockResolvedValue({ _sum: { subtotalCents: 10_000_00, descuentoCents: 0, iepsCents: 0 } }) // deducciones $10,000
    const r = await getIsrProvisional('v1', '2026-01', 'GENERAL')
    expect(r.deduccionesAcumCents).toBe(10_000_00)
    expect(r.utilidadFiscalCents).toBe(20_000_00) // $20,000
    // tarifa mensual: renglón limInf $15,487.72 cuota $1,640.18 16... 21.36%
    // ISR = 164018 + (2,000,000 − 1,548,772) × 0.2136 = 260,400 centavos = $2,604.00
    expect(r.isrCausadoCents).toBe(260_400)
    expect(r.pagosProvisionalesPreviosCents).toBe(0) // enero no tiene previos
    expect(r.isrAPagarCents).toBe(260_400)
  })

  it('utilidad 0 (deducciones ≥ ingresos) → ISR 0', async () => {
    mIncome.mockResolvedValue(income(10_000_00))
    p.expense.aggregate.mockResolvedValue({ _sum: { subtotalCents: 15_000_00, descuentoCents: 0, iepsCents: 0 } })
    const r = await getIsrProvisional('v1', '2026-01', 'GENERAL')
    expect(r.utilidadFiscalCents).toBe(0)
    expect(r.isrCausadoCents).toBe(0)
  })

  it('el costo de ventas acumulado reduce la utilidad fiscal (deducible en GENERAL)', async () => {
    mIncome.mockResolvedValue(income(30_000_00)) // ingresos $30,000
    p.expense.aggregate.mockResolvedValue({ _sum: { subtotalCents: 10_000_00, descuentoCents: 0, iepsCents: 0 } }) // gastos $10,000
    mCogs.mockResolvedValue(5_000_00) // costo de ventas $5,000
    const r = await getIsrProvisional('v1', '2026-01', 'GENERAL')
    expect(r.costoVentasAcumCents).toBe(5_000_00)
    expect(r.utilidadFiscalCents).toBe(15_000_00) // 30,000 − 10,000 − 5,000
  })
})

describe('getIsrProvisional — RESICO ignora el costo de ventas', () => {
  it('RESICO grava ingresos brutos: el COGS NO reduce el ISR', async () => {
    mIncome.mockResolvedValue(income(20_000_00)) // ISR causado $200 (1%)
    mCogs.mockResolvedValue(5_000_00) // aunque haya costo de ventas...
    const r = await getIsrProvisional('v1', '2026-06', 'RESICO')
    expect(r.costoVentasAcumCents).toBe(0) // ...RESICO no lo considera
    expect(r.isrCausadoCents).toBe(200_00)
  })
})
