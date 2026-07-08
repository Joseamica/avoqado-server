/**
 * Unit tests (mock-first) — Activos fijos (Capa B), slice 1: catálogo de tasas + registro (opt-in) + listado.
 * La depreciación en sí (línea recta, póliza) es slice 2.
 */
import { Prisma } from '@prisma/client'

import { BadRequestError } from '../../../../src/errors/AppError'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { fixedAsset: { create: jest.fn(), findMany: jest.fn() } },
}))
jest.mock('../../../../src/services/fiscal/chartOfAccounts.service', () => ({ resolveScopeOrNull: jest.fn() }))
jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import prisma from '../../../../src/utils/prismaClient'
import { resolveScopeOrNull } from '../../../../src/services/fiscal/chartOfAccounts.service'
import { logAction } from '../../../../src/services/dashboard/activity-log.service'
import { registerFixedAsset, listFixedAssets } from '../../../../src/services/fiscal/fixedAsset.service'
import { cappedMoiCents, getAssetType, suggestsFixedAsset } from '../../../../src/services/fiscal/assetTypeCatalog'

const p = prisma as unknown as { fixedAsset: { create: jest.Mock; findMany: jest.Mock } }
const mScope = resolveScopeOrNull as jest.Mock
const mLog = logAction as jest.Mock

const BASE = {
  description: 'Laptop Dell',
  assetType: 'EQUIPO_COMPUTO',
  moiCents: 30_000_00,
  acquisitionDate: '2026-03-15',
}

beforeEach(() => {
  jest.clearAllMocks()
  mScope.mockResolvedValue({ organizationId: 'org1', rfc: 'EKU9003173C9' })
  // El create devuelve la fila creada (echo del data + id/fechas).
  p.fixedAsset.create.mockImplementation(({ data }: any) =>
    Promise.resolve({ id: 'fa1', ...data, createdAt: new Date('2026-03-15T18:00:00Z'), updatedAt: new Date('2026-03-15T18:00:00Z') }),
  )
})

describe('assetTypeCatalog', () => {
  it('las tasas oficiales por tipo están cargadas', () => {
    expect(getAssetType('EQUIPO_COMPUTO')?.annualRate).toBe(0.3)
    expect(getAssetType('CONSTRUCCION')?.annualRate).toBe(0.05)
    expect(getAssetType('EQUIPO_TRANSPORTE')?.annualRate).toBe(0.25)
    expect(getAssetType('NO_EXISTE')).toBeUndefined()
  })

  it('cappedMoiCents topa autos a $175,000 (art. 36-II), otros sin tope', () => {
    expect(cappedMoiCents(200_000_00, 'EQUIPO_TRANSPORTE')).toBe(175_000_00) // topado
    expect(cappedMoiCents(100_000_00, 'EQUIPO_TRANSPORTE')).toBe(100_000_00) // por debajo del tope
    expect(cappedMoiCents(500_000_00, 'CONSTRUCCION')).toBe(500_000_00) // sin tope
  })

  it('suggestsFixedAsset: solo SUGIERE arriba del umbral (no decide)', () => {
    expect(suggestsFixedAsset(4_999_99)).toBe(false)
    expect(suggestsFixedAsset(5_000_00)).toBe(true)
    expect(suggestsFixedAsset(1_000_00, 500_00)).toBe(true) // umbral custom
  })
})

describe('registerFixedAsset (opt-in: registrar = confirmar)', () => {
  it('tipo inválido → BadRequestError', async () => {
    await expect(registerFixedAsset('v1', { ...BASE, assetType: 'XXX' })).rejects.toThrow(BadRequestError)
  })

  it('MOI ≤ 0 → BadRequestError', async () => {
    await expect(registerFixedAsset('v1', { ...BASE, moiCents: 0 })).rejects.toThrow(BadRequestError)
  })

  it('tasa fuera de (0,1] → BadRequestError', async () => {
    await expect(registerFixedAsset('v1', { ...BASE, annualRate: 1.5 })).rejects.toThrow(BadRequestError)
    await expect(registerFixedAsset('v1', { ...BASE, annualRate: 0 })).rejects.toThrow(BadRequestError)
  })

  it('fecha mal formada → BadRequestError', async () => {
    await expect(registerFixedAsset('v1', { ...BASE, acquisitionDate: '15/03/2026' })).rejects.toThrow(BadRequestError)
  })

  it('inicio de uso anterior a la adquisición → BadRequestError', async () => {
    await expect(registerFixedAsset('v1', { ...BASE, inServiceDate: '2026-01-01' })).rejects.toThrow(BadRequestError)
  })

  it('sin RFC configurado → BadRequestError', async () => {
    mScope.mockResolvedValue(null)
    await expect(registerFixedAsset('v1', BASE)).rejects.toThrow(BadRequestError)
  })

  it('OK: toma la tasa DEFAULT del catálogo (cómputo 30%), audita y devuelve la vista', async () => {
    const r = await registerFixedAsset('v1', BASE, 'staff1')
    expect(r.annualRate).toBe(0.3) // default del catálogo
    expect(r.assetTypeLabel).toBe('Equipo de cómputo')
    expect(r.depreciableBaseCents).toBe(30_000_00) // sin tope, sin rescate
    expect(r.acquisitionDate).toBe('2026-03-15') // ancla mediodía → fecha estable
    expect(r.inServiceDate).toBe('2026-03-15') // default = adquisición
    expect(mLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'FIXED_ASSET_REGISTERED', staffId: 'staff1' }))
  })

  it('OK: respeta la tasa CUSTOM (editable) y el valor de rescate', async () => {
    const r = await registerFixedAsset('v1', { ...BASE, annualRate: 0.2, salvageValueCents: 2_000_00 }, 'staff1')
    expect(r.annualRate).toBe(0.2)
    expect(r.depreciableBaseCents).toBe(28_000_00) // 30,000 − 2,000 rescate
  })

  it('auto arriba de $175k: la BASE depreciable se topa, el MOI original se conserva', async () => {
    const r = await registerFixedAsset('v1', { ...BASE, assetType: 'EQUIPO_TRANSPORTE', moiCents: 200_000_00 }, 'staff1')
    expect(r.moiCents).toBe(200_000_00) // original intacto
    expect(r.depreciableBaseCents).toBe(175_000_00) // topado art. 36-II
    expect(r.annualRate).toBe(0.25) // default transporte
  })

  it('persiste con Prisma.Decimal en annualRate y scope del contribuyente', async () => {
    await registerFixedAsset('v1', BASE, 'staff1')
    const data = p.fixedAsset.create.mock.calls[0][0].data
    expect(data.organizationId).toBe('org1')
    expect(data.rfc).toBe('EKU9003173C9')
    expect(data.annualRate).toBeInstanceOf(Prisma.Decimal)
    expect(Number(data.annualRate)).toBe(0.3)
  })
})

describe('listFixedAssets', () => {
  it('sin RFC → needsFiscalSetup, no consulta', async () => {
    mScope.mockResolvedValue(null)
    const r = await listFixedAssets('v1')
    expect(r.needsFiscalSetup).toBe(true)
    expect(r.assets).toEqual([])
    expect(p.fixedAsset.findMany).not.toHaveBeenCalled()
  })

  it('con RFC → lista mapeada a la vista, scopeada por (org, rfc)', async () => {
    p.fixedAsset.findMany.mockResolvedValue([
      {
        id: 'fa1',
        organizationId: 'org1',
        rfc: 'EKU9003173C9',
        venueId: 'v1',
        description: 'Laptop',
        assetType: 'EQUIPO_COMPUTO',
        moiCents: 30_000_00,
        annualRate: new Prisma.Decimal(0.3),
        acquisitionDate: new Date('2026-03-15T18:00:00Z'),
        inServiceDate: new Date('2026-03-15T18:00:00Z'),
        salvageValueCents: 0,
        status: 'ACTIVE',
        sourceExpenseId: null,
        createdAt: new Date('2026-03-15T18:00:00Z'),
      },
    ])
    const r = await listFixedAssets('v1')
    expect(r.needsFiscalSetup).toBe(false)
    expect(r.assets).toHaveLength(1)
    expect(r.assets[0].assetTypeLabel).toBe('Equipo de cómputo')
    expect(p.fixedAsset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org1', rfc: 'EKU9003173C9' } }),
    )
  })
})
