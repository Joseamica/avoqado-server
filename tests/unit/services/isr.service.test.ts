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

import prisma from '../../../src/utils/prismaClient'
import { resolveScopeOrNull } from '../../../src/services/fiscal/chartOfAccounts.service'
import { getIncomeStatement } from '../../../src/services/dashboard/accounting.dashboard.service'
import { getSalesRetentionCents } from '../../../src/services/fiscal/salesRetention.service'
import { getIsrProvisional } from '../../../src/services/fiscal/isr.service'

const p = prisma as unknown as {
  venue: { findMany: jest.Mock; findUnique: jest.Mock }
  expense: { aggregate: jest.Mock }
}
const mScope = resolveScopeOrNull as jest.Mock
const mIncome = getIncomeStatement as jest.Mock
const mSalesRet = getSalesRetentionCents as jest.Mock

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
})
