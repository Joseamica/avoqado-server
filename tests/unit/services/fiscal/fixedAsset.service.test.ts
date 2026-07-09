/**
 * Unit tests (mock-first) — Activos fijos (Capa B), slice 1: catálogo de tasas + registro (opt-in) + listado.
 * La depreciación en sí (línea recta, póliza) es slice 2.
 */
import { Prisma } from '@prisma/client'

import { BadRequestError, NotFoundError } from '../../../../src/errors/AppError'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    fixedAsset: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    fixedAssetDepreciation: { aggregate: jest.fn() },
    ledgerAccount: { findFirst: jest.fn() },
    journalEntry: { findUnique: jest.fn() },
  },
}))
jest.mock('../../../../src/services/fiscal/journalEntry.service', () => ({ postJournalEntry: jest.fn() }))
jest.mock('../../../../src/services/fiscal/chartOfAccounts.service', () => ({ resolveScopeOrNull: jest.fn() }))
jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import prisma from '../../../../src/utils/prismaClient'
import { postJournalEntry } from '../../../../src/services/fiscal/journalEntry.service'
import { resolveScopeOrNull } from '../../../../src/services/fiscal/chartOfAccounts.service'
import { logAction } from '../../../../src/services/dashboard/activity-log.service'
import {
  registerFixedAsset,
  listFixedAssets,
  updateFixedAsset,
  disposeFixedAsset,
} from '../../../../src/services/fiscal/fixedAsset.service'
import { cappedMoiCents, getAssetType, suggestsFixedAsset } from '../../../../src/services/fiscal/assetTypeCatalog'

const p = prisma as unknown as {
  fixedAsset: { create: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock; update: jest.Mock }
  fixedAssetDepreciation: { aggregate: jest.Mock }
  ledgerAccount: { findFirst: jest.Mock }
  journalEntry: { findUnique: jest.Mock }
}
const mPost = postJournalEntry as jest.Mock
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
  // Póliza (alta/baja): cuentas del catálogo resueltas por código; sin alta previa; posteo OK.
  p.ledgerAccount.findFirst.mockImplementation(({ where }: any) => Promise.resolve({ id: 'acc-' + where.code }))
  p.journalEntry.findUnique.mockResolvedValue(null)
  mPost.mockResolvedValue({ id: 'je1' })
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
    expect(p.fixedAsset.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: 'org1', rfc: 'EKU9003173C9' } }))
  })
})

const assetRow = (over: Record<string, unknown> = {}) => ({
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
  inpcFactor: null,
  status: 'ACTIVE',
  sourceExpenseId: null,
  disposalDate: null,
  disposalProceedsCents: null,
  createdAt: new Date('2026-03-15T18:00:00Z'),
  ...over,
})

describe('updateFixedAsset', () => {
  it('activo no encontrado → NotFoundError', async () => {
    p.fixedAsset.findFirst.mockResolvedValue(null)
    await expect(updateFixedAsset('v1', 'fa1', { description: 'x' })).rejects.toThrow(NotFoundError)
  })

  it('activo dado de baja → no se puede editar (BadRequestError)', async () => {
    p.fixedAsset.findFirst.mockResolvedValue(assetRow({ status: 'DISPOSED' }))
    await expect(updateFixedAsset('v1', 'fa1', { description: 'x' })).rejects.toThrow(BadRequestError)
  })

  it('tasa inválida → BadRequestError', async () => {
    p.fixedAsset.findFirst.mockResolvedValue(assetRow())
    await expect(updateFixedAsset('v1', 'fa1', { annualRate: 2 })).rejects.toThrow(BadRequestError)
  })

  it('actualiza SOLO los campos enviados y audita', async () => {
    p.fixedAsset.findFirst.mockResolvedValue(assetRow())
    p.fixedAsset.update.mockImplementation(({ data }: any) => Promise.resolve(assetRow(data)))
    const r = await updateFixedAsset('v1', 'fa1', { annualRate: 0.2, description: 'Laptop nueva' }, 'staff1')
    expect(r.annualRate).toBe(0.2)
    expect(Object.keys(p.fixedAsset.update.mock.calls[0][0].data).sort()).toEqual(['annualRate', 'description'])
    expect(mLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'FIXED_ASSET_UPDATED' }))
  })
})

describe('disposeFixedAsset (dar de baja)', () => {
  it('ya dado de baja → BadRequestError', async () => {
    p.fixedAsset.findFirst.mockResolvedValue(assetRow({ status: 'DISPOSED' }))
    await expect(disposeFixedAsset('v1', 'fa1', { disposalDate: '2026-06-01' })).rejects.toThrow(BadRequestError)
  })

  it('venta con GANANCIA: precio de venta > valor en libros', async () => {
    // base 30,000 − acumulada 12,000 = valor en libros 18,000; precio 20,000 → ganancia 2,000
    p.fixedAsset.findFirst.mockResolvedValue(assetRow())
    p.fixedAssetDepreciation.aggregate.mockResolvedValue({ _sum: { depreciationCents: 12_000_00 } })
    p.fixedAsset.update.mockImplementation(({ data }: any) => Promise.resolve(assetRow(data)))
    const r = await disposeFixedAsset('v1', 'fa1', { disposalDate: '2026-06-01', proceedsCents: 20_000_00 }, 'staff1')
    expect(r.bookValueCents).toBe(18_000_00)
    expect(r.gainLossCents).toBe(2_000_00)
    expect(r.asset.status).toBe('DISPOSED')
    expect(mLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'FIXED_ASSET_DISPOSED' }))
  })

  it('baja sin venta (obsolescencia): PÉRDIDA = valor en libros', async () => {
    p.fixedAsset.findFirst.mockResolvedValue(assetRow())
    p.fixedAssetDepreciation.aggregate.mockResolvedValue({ _sum: { depreciationCents: 12_000_00 } })
    p.fixedAsset.update.mockImplementation(({ data }: any) => Promise.resolve(assetRow(data)))
    const r = await disposeFixedAsset('v1', 'fa1', { disposalDate: '2026-06-01' }) // sin precio
    expect(r.bookValueCents).toBe(18_000_00)
    expect(r.gainLossCents).toBe(-18_000_00) // pérdida total
  })
})

describe('póliza de ALTA al libro (registro)', () => {
  it('postea DEBE Activo({grupo}.09) / HABER Bancos(102.01) por el MOI, idempotente por activo', async () => {
    const r = await registerFixedAsset('v1', BASE, 'staff1')
    expect(r.ledgerPosted).toBe(true)
    expect(mPost).toHaveBeenCalledWith(
      'v1',
      expect.objectContaining({
        source: 'DEPRECIATION',
        idempotencyKey: 'fa-alta:fa1',
        lines: [
          { ledgerAccountId: 'acc-156.09', debitCents: 30_000_00, creditCents: 0 },
          { ledgerAccountId: 'acc-102.01', debitCents: 0, creditCents: 30_000_00 },
        ],
      }),
      { staffId: 'staff1' },
    )
  })

  it('compra ligada a un gasto → NO postea (el gasto ya movió el banco)', async () => {
    const r = await registerFixedAsset('v1', { ...BASE, sourceExpenseId: 'exp1' }, 'staff1')
    expect(r.ledgerPosted).toBe(false)
    expect(r.ledgerReason).toBe('linkedExpense')
    expect(mPost).not.toHaveBeenCalled()
  })

  it('faltan cuentas (catálogo sembrado antes) → best-effort: registra sin póliza', async () => {
    p.ledgerAccount.findFirst.mockResolvedValue(null)
    const r = await registerFixedAsset('v1', BASE, 'staff1')
    expect(r.ledgerPosted).toBe(false)
    expect(r.ledgerReason).toBe('missingAccounts')
  })
})

describe('póliza de BAJA al libro', () => {
  const disposedSetup = () => {
    p.fixedAsset.findFirst.mockResolvedValue(assetRow())
    p.fixedAssetDepreciation.aggregate.mockResolvedValue({ _sum: { depreciationCents: 12_000_00 } })
    p.fixedAsset.update.mockImplementation(({ data }: any) => Promise.resolve(assetRow(data)))
  }

  it('con ALTA previa y venta con ganancia: cancela activo por MOI, revierte acumulada, ganancia a 403.01', async () => {
    disposedSetup()
    p.journalEntry.findUnique.mockResolvedValue({ id: 'je-alta' }) // la alta existe
    const r = await disposeFixedAsset('v1', 'fa1', { disposalDate: '2026-06-01', proceedsCents: 20_000_00 }, 'staff1')
    expect(r.ledgerPosted).toBe(true)
    // plug = 30,000 − 12,000 − 20,000 = −2,000 → ganancia (HABER 403.01)
    expect(mPost).toHaveBeenCalledWith(
      'v1',
      expect.objectContaining({
        idempotencyKey: 'fa-baja:fa1',
        lines: [
          { ledgerAccountId: 'acc-171.09', debitCents: 12_000_00, creditCents: 0 },
          { ledgerAccountId: 'acc-107.05', debitCents: 20_000_00, creditCents: 0 },
          { ledgerAccountId: 'acc-156.09', debitCents: 0, creditCents: 30_000_00 },
          { ledgerAccountId: 'acc-403.01', debitCents: 0, creditCents: 2_000_00 },
        ],
      }),
      { staffId: 'staff1' },
    )
  })

  it('pérdida (obsolescencia): el cuadre va a 701.09 y el asiento balancea', async () => {
    disposedSetup()
    p.journalEntry.findUnique.mockResolvedValue({ id: 'je-alta' })
    await disposeFixedAsset('v1', 'fa1', { disposalDate: '2026-06-01' }, 'staff1') // sin venta
    const input = mPost.mock.calls[0][1]
    expect(input.lines).toEqual([
      { ledgerAccountId: 'acc-171.09', debitCents: 12_000_00, creditCents: 0 },
      { ledgerAccountId: 'acc-701.09', debitCents: 18_000_00, creditCents: 0 },
      { ledgerAccountId: 'acc-156.09', debitCents: 0, creditCents: 30_000_00 },
    ])
  })

  it('sin ALTA en libros → NO postea la baja (abonar el activo desbalancearía la cuenta)', async () => {
    disposedSetup()
    const r = await disposeFixedAsset('v1', 'fa1', { disposalDate: '2026-06-01' })
    expect(r.ledgerPosted).toBe(false)
    expect(r.ledgerReason).toBe('noAcquisitionEntry')
    expect(mPost).not.toHaveBeenCalled()
  })
})

describe('factor INPC (actualización fiscal, art. 31)', () => {
  it('register: factor fuera de rango → BadRequestError', async () => {
    await expect(registerFixedAsset('v1', { ...BASE, inpcFactor: 20 })).rejects.toThrow(BadRequestError)
  })

  it('update: número persiste como Decimal; null lo borra', async () => {
    p.fixedAsset.findFirst.mockResolvedValue(assetRow())
    p.fixedAsset.update.mockImplementation(({ data }: any) => Promise.resolve(assetRow(data)))
    await updateFixedAsset('v1', 'fa1', { inpcFactor: 1.0832 })
    expect(Number(p.fixedAsset.update.mock.calls[0][0].data.inpcFactor)).toBeCloseTo(1.0832)
    await updateFixedAsset('v1', 'fa1', { inpcFactor: null })
    expect(p.fixedAsset.update.mock.calls[1][0].data.inpcFactor).toBeNull()
  })
})
