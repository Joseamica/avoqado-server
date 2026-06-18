/**
 * Unit tests (mock-first) for Configuración contable (AccountMapping) service.
 *  - getMappings devuelve SIEMPRE los 28 movimientos (needsFiscalSetup / catalogSeeded)
 *  - seed resuelve cada default a su cuenta del catálogo, es insert-if-absent, exige catálogo
 *  - setMapping valida: movimiento válido, cuenta del contribuyente, cuenta AFECTABLE (hoja)
 */
import { BadRequestError } from '../../../src/errors/AppError'
import { MOVEMENT_TYPES } from '../../../src/services/fiscal/accountMapping.catalog'

jest.mock('../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    fiscalEmisor: { findFirst: jest.fn() },
    ledgerAccount: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
    accountMapping: { findMany: jest.fn(), create: jest.fn(), upsert: jest.fn() },
  },
}))

import prisma from '../../../src/utils/prismaClient'
import { getMappings, seedDefaultMappings, setMapping } from '../../../src/services/fiscal/accountMapping.service'

const p = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  fiscalEmisor: { findFirst: jest.Mock }
  ledgerAccount: { findMany: jest.Mock; count: jest.Mock; findFirst: jest.Mock; findUnique: jest.Mock }
  accountMapping: { findMany: jest.Mock; create: jest.Mock; upsert: jest.Mock }
}

const DEFAULT_CODES = [...new Set(MOVEMENT_TYPES.map(m => m.defaultCode))]
const CATALOG_ACCOUNTS = DEFAULT_CODES.map(code => ({ id: 'acc-' + code, code }))

beforeEach(() => {
  jest.clearAllMocks()
  p.venue.findUnique.mockResolvedValue({ organizationId: 'org1', rfc: 'TESC900101AAA', type: 'AUTO_SERVICE' })
  p.fiscalEmisor.findFirst.mockResolvedValue(null)
  p.accountMapping.findMany.mockResolvedValue([])
  p.ledgerAccount.count.mockResolvedValue(86)
  p.ledgerAccount.findMany.mockResolvedValue(CATALOG_ACCOUNTS)
  p.accountMapping.create.mockResolvedValue({})
  p.accountMapping.upsert.mockResolvedValue({})
})

describe('getMappings', () => {
  it('sin RFC → needsFiscalSetup', async () => {
    p.venue.findUnique.mockResolvedValue({ organizationId: 'org1', rfc: null, type: 'AUTO_SERVICE' })
    const r = await getMappings('v1')
    expect(r.needsFiscalSetup).toBe(true)
    expect(r.mappings).toEqual([])
  })

  it('devuelve los 28 movimientos; sin mapeos → todos sin cuenta', async () => {
    const r = await getMappings('v1')
    expect(r.needsFiscalSetup).toBe(false)
    expect(r.catalogSeeded).toBe(true)
    expect(r.mappings).toHaveLength(28)
    expect(r.mappings.every(m => m.account === null)).toBe(true)
  })

  it('refleja la cuenta asignada de cada movimiento', async () => {
    p.accountMapping.findMany.mockResolvedValue([
      { movementType: 'SALES_REVENUE', ledgerAccount: { id: 'x', code: '401.01', name: 'Ventas', satGroupingCode: '401', isActive: true } },
    ])
    const r = await getMappings('v1')
    expect(r.mappings.find(m => m.movementType === 'SALES_REVENUE')!.account?.code).toBe('401.01')
    expect(r.mappings.find(m => m.movementType === 'COST_OF_GOODS_SOLD')!.account).toBeNull()
  })

  it('catálogo vacío → catalogSeeded:false', async () => {
    p.ledgerAccount.count.mockResolvedValue(0)
    const r = await getMappings('v1')
    expect(r.catalogSeeded).toBe(false)
  })
})

describe('seedDefaultMappings', () => {
  it('sin catálogo → rechaza', async () => {
    p.ledgerAccount.findMany.mockResolvedValue([])
    await expect(seedDefaultMappings('v1', { staffId: 's' })).rejects.toThrow(BadRequestError)
  })

  it('crea los 28 mapeos resolviendo cada default a su cuenta', async () => {
    await seedDefaultMappings('v1', { staffId: 's' })
    expect(p.accountMapping.create).toHaveBeenCalledTimes(28)
    const byType = (mt: string) => p.accountMapping.create.mock.calls.find(c => c[0].data.movementType === mt)?.[0].data
    expect(byType('SALES_REVENUE').ledgerAccountId).toBe('acc-401.01')
    expect(byType('COST_OF_GOODS_SOLD').ledgerAccountId).toBe('acc-501.01')
    expect(byType('TIPS_PAYABLE').ledgerAccountId).toBe('acc-205.06')
  })

  it('insert-if-absent: no recrea un mapeo que el usuario ya tiene', async () => {
    p.accountMapping.findMany.mockResolvedValue([{ movementType: 'SALES_REVENUE' }])
    await seedDefaultMappings('v1', { staffId: 's' })
    const createdTypes = p.accountMapping.create.mock.calls.map(c => c[0].data.movementType)
    expect(createdTypes).not.toContain('SALES_REVENUE')
    expect(p.accountMapping.create).toHaveBeenCalledTimes(27)
  })
})

describe('setMapping', () => {
  it('movementType inválido → 400', async () => {
    await expect(setMapping('v1', 'INVENTADO', null, { staffId: 's' })).rejects.toThrow(/no v[aá]lido/i)
  })

  it('cuenta no afectable (acumulativa) → 400', async () => {
    p.ledgerAccount.findFirst.mockResolvedValue({ id: 'a', isPostable: false })
    await expect(setMapping('v1', 'SALES_REVENUE', 'a', { staffId: 's' })).rejects.toThrow(/afectable/i)
  })

  it('cuenta de otro contribuyente → 400', async () => {
    p.ledgerAccount.findFirst.mockResolvedValue(null)
    await expect(setMapping('v1', 'SALES_REVENUE', 'ajena', { staffId: 's' })).rejects.toThrow(/no pertenece/i)
  })

  it('asigna una cuenta afectable y devuelve el row', async () => {
    p.ledgerAccount.findFirst.mockResolvedValue({ id: 'a', isPostable: true })
    p.ledgerAccount.findUnique.mockResolvedValue({ id: 'a', code: '401.04', name: 'Ventas 0%', satGroupingCode: '401', isActive: true })
    const row = await setMapping('v1', 'SALES_REVENUE', 'a', { staffId: 's' })
    expect(p.accountMapping.upsert).toHaveBeenCalled()
    expect(row.movementType).toBe('SALES_REVENUE')
    expect(row.account?.code).toBe('401.04')
  })

  it('limpiar (null) no valida cuenta y hace upsert', async () => {
    const row = await setMapping('v1', 'SALES_REVENUE', null, { staffId: 's' })
    expect(p.ledgerAccount.findFirst).not.toHaveBeenCalled()
    expect(p.accountMapping.upsert).toHaveBeenCalled()
    expect(row.account).toBeNull()
  })
})
