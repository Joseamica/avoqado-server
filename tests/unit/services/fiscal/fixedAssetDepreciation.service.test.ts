/**
 * Unit tests — depreciación de activos fijos (línea recta), slice 2: cálculo puro + corrida por periodo.
 */
import { BadRequestError } from '../../../../src/errors/AppError'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    fixedAsset: { findMany: jest.fn(), update: jest.fn() },
    fixedAssetDepreciation: { upsert: jest.fn(), aggregate: jest.fn() },
  },
}))
jest.mock('../../../../src/services/fiscal/chartOfAccounts.service', () => ({ resolveScopeOrNull: jest.fn() }))

import prisma from '../../../../src/utils/prismaClient'
import { resolveScopeOrNull } from '../../../../src/services/fiscal/chartOfAccounts.service'
import {
  computeDepreciation,
  monthsElapsed,
  generateDepreciationForVenue,
  getYearDepreciationCents,
} from '../../../../src/services/fiscal/fixedAssetDepreciation.service'

const p = prisma as unknown as {
  fixedAsset: { findMany: jest.Mock; update: jest.Mock }
  fixedAssetDepreciation: { upsert: jest.Mock; aggregate: jest.Mock }
}
const mScope = resolveScopeOrNull as jest.Mock

// Laptop $30,000, cómputo 30% → base 3,000,000¢, mensual = 3,000,000×0.30/12 = 75,000¢ ($750), vida 40 meses.
const laptop = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  moiCents: 30_000_00,
  assetType: 'EQUIPO_COMPUTO',
  salvageValueCents: 0,
  annualRate: 0.3,
  inServiceDate: new Date('2026-03-15T12:00:00Z'),
  status: 'ACTIVE',
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  mScope.mockResolvedValue({ organizationId: 'org1', rfc: 'EKU9003173C9' })
})

describe('monthsElapsed', () => {
  it('cuenta meses completos desde el inicio de uso, 0 si es anterior', () => {
    const inService = new Date('2026-03-15T12:00:00Z')
    expect(monthsElapsed(inService, '2026-02')).toBe(0) // antes de usar
    expect(monthsElapsed(inService, '2026-03')).toBe(1) // el mes de inicio cuenta
    expect(monthsElapsed(inService, '2026-04')).toBe(2)
    expect(monthsElapsed(inService, '2027-03')).toBe(13)
  })
})

describe('computeDepreciation (línea recta)', () => {
  it('antes del inicio de uso → 0', () => {
    expect(computeDepreciation(laptop(), '2026-02').periodCents).toBe(0)
  })

  it('mes de inicio y siguientes → mensualidad constante ($750)', () => {
    expect(computeDepreciation(laptop(), '2026-03').periodCents).toBe(750_00)
    expect(computeDepreciation(laptop(), '2026-04').periodCents).toBe(750_00)
    expect(computeDepreciation(laptop(), '2026-04').accumulatedCents).toBe(1_500_00)
  })

  it('valor de rescate reduce la base depreciable', () => {
    // base = 30,000 − 6,000 = 24,000 → mensual = 24,000×0.30/12 = 600
    expect(computeDepreciation(laptop({ salvageValueCents: 6_000_00 }), '2026-03').periodCents).toBe(600_00)
  })

  it('auto arriba de $175k: base topada (art. 36-II)', () => {
    // base 17,500,000¢, 25% → mensual = 17,500,000×0.25/12 = 364,583.33 → 364,583¢
    const auto = laptop({ assetType: 'EQUIPO_TRANSPORTE', moiCents: 200_000_00, annualRate: 0.25 })
    expect(computeDepreciation(auto, '2026-03').baseCents).toBe(175_000_00)
    expect(computeDepreciation(auto, '2026-03').periodCents).toBe(364583)
  })

  it('el acumulado se topa a la base y marca fullyDepreciated en el último mes', () => {
    // vida 40 meses: inicio mar-2026 → mes 40 = jun-2029.
    const mes40 = computeDepreciation(laptop(), '2029-06')
    expect(mes40.accumulatedCents).toBe(30_000_00) // topado a la base
    expect(mes40.fullyDepreciated).toBe(true)
    const mes41 = computeDepreciation(laptop(), '2029-07')
    expect(mes41.periodCents).toBe(0) // ya no deprecia
  })

  it('telescopio: la suma de todos los meses = base exacta (sin deriva de redondeo)', () => {
    let suma = 0
    let y = 2026
    let m = 3
    for (let i = 0; i < 40; i++) {
      const period = `${y}-${String(m).padStart(2, '0')}`
      suma += computeDepreciation(laptop(), period).periodCents
      m++
      if (m > 12) {
        m = 1
        y++
      }
    }
    expect(suma).toBe(30_000_00) // cuadra al centavo con la base
  })
})

describe('generateDepreciationForVenue', () => {
  it('sin RFC → needsFiscalSetup, no consulta activos', async () => {
    mScope.mockResolvedValue(null)
    const r = await generateDepreciationForVenue('v1', '2026-04')
    expect(r.needsFiscalSetup).toBe(true)
    expect(p.fixedAsset.findMany).not.toHaveBeenCalled()
  })

  it('persiste el renglón del periodo (upsert idempotente) y suma el total', async () => {
    p.fixedAsset.findMany.mockResolvedValue([laptop()])
    const r = await generateDepreciationForVenue('v1', '2026-04')
    expect(r.assetsDepreciated).toBe(1)
    expect(r.totalPeriodCents).toBe(750_00)
    expect(p.fixedAssetDepreciation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { fixedAssetId_period: { fixedAssetId: 'a1', period: '2026-04' } },
        create: expect.objectContaining({ depreciationCents: 750_00, accumulatedCents: 1_500_00 }),
      }),
    )
    expect(p.fixedAsset.update).not.toHaveBeenCalled() // aún no se agota
  })

  it('salta activos que aún no entran en uso (no crea renglón en 0)', async () => {
    p.fixedAsset.findMany.mockResolvedValue([laptop({ inServiceDate: new Date('2026-09-15T12:00:00Z') })])
    const r = await generateDepreciationForVenue('v1', '2026-04')
    expect(r.assetsDepreciated).toBe(0)
    expect(p.fixedAssetDepreciation.upsert).not.toHaveBeenCalled()
  })

  it('marca FULLY_DEPRECIATED cuando el acumulado llega a la base', async () => {
    p.fixedAsset.findMany.mockResolvedValue([laptop()])
    await generateDepreciationForVenue('v1', '2029-06') // mes 40
    expect(p.fixedAsset.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'FULLY_DEPRECIATED' } }))
  })
})

describe('getYearDepreciationCents', () => {
  it('suma la depreciación del ejercicio hasta el periodo (deducción de inversiones acumulada)', async () => {
    p.fixedAssetDepreciation.aggregate.mockResolvedValue({ _sum: { depreciationCents: 2_250_00 } })
    const c = await getYearDepreciationCents('org1', 'EKU9003173C9', 2026, '2026-04')
    expect(c).toBe(2_250_00)
    expect(p.fixedAssetDepreciation.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ period: { gte: '2026-01', lte: '2026-04' }, fixedAsset: { organizationId: 'org1', rfc: 'EKU9003173C9' } }),
      }),
    )
  })

  it('sin renglones → 0', async () => {
    p.fixedAssetDepreciation.aggregate.mockResolvedValue({ _sum: { depreciationCents: null } })
    expect(await getYearDepreciationCents('org1', 'R', 2026, '2026-12')).toBe(0)
  })
})
