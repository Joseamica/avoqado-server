/**
 * Unit tests (mock-first) for the Catálogo de cuentas (Capa B) service.
 * Locks the invariants /full-testing + the adversarial review hardened:
 *  - scope resolves (org, rfc); no rfc → needsFiscalSetup
 *  - seed is INSERT-IF-ABSENT (never overwrites existing rows) + isPostable solo en hojas
 *  - createAccount hereda el tipo del padre + voltea isPostable del padre + rechaza dup/parent-inexistente
 *  - updateAccount está scoped por (org, rfc) → 404 fuera de alcance
 */
import { BadRequestError, NotFoundError } from '../../../src/errors/AppError'

jest.mock('../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    fiscalEmisor: { findFirst: jest.fn() },
    ledgerAccount: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(),
  },
}))

import prisma from '../../../src/utils/prismaClient'
import { createAccount, getCatalog, seedBaseChart, updateAccount } from '../../../src/services/fiscal/chartOfAccounts.service'

const p = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  fiscalEmisor: { findFirst: jest.Mock }
  ledgerAccount: { findMany: jest.Mock; findUnique: jest.Mock; findFirst: jest.Mock; update: jest.Mock }
  $transaction: jest.Mock
}

/** tx con create que devuelve {id-<code>, ...data} para inspeccionar las llamadas. */
function makeTx() {
  const create = jest.fn(({ data }: any) => Promise.resolve({ id: 'id-' + data.code, isActive: true, ...data }))
  const update = jest.fn().mockResolvedValue({})
  return { tx: { ledgerAccount: { create, update } }, create, update }
}

beforeEach(() => {
  jest.clearAllMocks()
  // scope por defecto: venue con RFC (servicios) → contribuyente resoluble
  p.venue.findUnique.mockResolvedValue({ organizationId: 'org1', rfc: 'TESC900101AAA', type: 'AUTO_SERVICE' })
  p.fiscalEmisor.findFirst.mockResolvedValue(null) // usa Venue.rfc
  p.ledgerAccount.findMany.mockResolvedValue([])
})

describe('getCatalog', () => {
  it('sin RFC/emisor → needsFiscalSetup', async () => {
    p.venue.findUnique.mockResolvedValue({ organizationId: 'org1', rfc: null, type: 'AUTO_SERVICE' })
    p.fiscalEmisor.findFirst.mockResolvedValue(null)
    const r = await getCatalog('venue-1')
    expect(r.needsFiscalSetup).toBe(true)
    expect(r.accounts).toEqual([])
  })

  it('con RFC + cuentas → seeded:true', async () => {
    p.ledgerAccount.findMany.mockResolvedValue([
      {
        id: '1',
        code: '101',
        satGroupingCode: '101',
        name: 'Caja',
        type: 'ACTIVO',
        nature: 'DEUDORA',
        level: 1,
        parentId: null,
        isPostable: false,
        isActive: true,
      },
    ])
    const r = await getCatalog('venue-1')
    expect(r.needsFiscalSetup).toBe(false)
    expect(r.rfc).toBe('TESC900101AAA')
    expect(r.seeded).toBe(true)
    expect(r.accounts).toHaveLength(1)
  })
})

describe('seedBaseChart', () => {
  it('siembra el catálogo del giro (servicios = 104 cuentas) con isPostable solo en hojas', async () => {
    const { tx, create } = makeTx()
    p.$transaction.mockImplementation(async (cb: any) => cb(tx))

    await seedBaseChart('venue-1', { staffId: 'staff-1' })

    expect(create).toHaveBeenCalledTimes(104) // 102 base (incl. activo fijo 152-157 + .09, 701.09) + 3 extras de 'servicios' − 1 (156 ahora vive en el base y el dedupe absorbe la del giro)
    const byCode = (code: string) => create.mock.calls.find(c => c[0].data.code === code)?.[0].data
    expect(byCode('101').isPostable).toBe(false) // 101 (Caja) tiene hijos → acumulativa
    expect(byCode('101.01').isPostable).toBe(true) // hoja
    expect(byCode('102.01').isPostable).toBe(true) // hoja
    // las cuentas-puente de IVA en flujo se siembran
    for (const c of ['118.01', '119.01', '208.01', '209.01']) expect(byCode(c)).toBeTruthy()
    // padres antes que hijos
    const idx = (c: string) => create.mock.calls.findIndex(call => call[0].data.code === c)
    expect(idx('101')).toBeLessThan(idx('101.01'))
  })

  it('INSERT-IF-ABSENT: no recrea cuentas existentes (preserva ediciones del usuario)', async () => {
    // El usuario ya tiene 101 (con hijo en DB) y 101.01 → el re-seed NO los toca.
    p.ledgerAccount.findMany.mockResolvedValue([
      { id: 'e1', code: '101', parentId: null },
      { id: 'e2', code: '101.01', parentId: 'e1' },
    ])
    const { tx, create } = makeTx()
    p.$transaction.mockImplementation(async (cb: any) => cb(tx))

    await seedBaseChart('venue-1', { staffId: 'staff-1' })

    const createdCodes = create.mock.calls.map(c => c[0].data.code)
    expect(createdCodes).not.toContain('101') // existente → preservado
    expect(createdCodes).not.toContain('101.01')
    expect(create).toHaveBeenCalledTimes(102) // 104 - 2 existentes
  })
})

describe('createAccount', () => {
  it('hereda el tipo del padre y voltea isPostable del padre (de hoja a acumulativa)', async () => {
    p.ledgerAccount.findUnique
      .mockResolvedValueOnce(null) // chequeo de existencia (code libre)
      .mockResolvedValueOnce({ id: 'pid', isPostable: true, level: 1, type: 'GASTO' }) // padre
    const { tx, create, update } = makeTx()
    p.$transaction.mockImplementation(async (cb: any) => cb(tx))

    // mando type ACTIVO a propósito; debe heredar GASTO del padre
    const acc = await createAccount(
      'venue-1',
      { code: '601.99', name: 'Sub', satGroupingCode: '601', type: 'ACTIVO', parentCode: '601' },
      { staffId: 's' },
    )

    expect(create.mock.calls[0][0].data.type).toBe('GASTO') // heredado
    expect(acc.level).toBe(2) // parent.level + 1
    expect(update).toHaveBeenCalledWith({ where: { id: 'pid' }, data: { isPostable: false } })
  })

  it('rechaza código duplicado con 400', async () => {
    p.ledgerAccount.findUnique.mockResolvedValueOnce({ id: 'exists' })
    await expect(
      createAccount('venue-1', { code: '101', name: 'dup', satGroupingCode: '101', type: 'ACTIVO' }, { staffId: 's' }),
    ).rejects.toThrow(BadRequestError)
  })

  it('rechaza cuenta padre inexistente con 400', async () => {
    p.ledgerAccount.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null) // libre + padre no existe
    await expect(
      createAccount('venue-1', { code: '999.01', name: 'x', satGroupingCode: '1', type: 'GASTO', parentCode: 'ZZZ' }, { staffId: 's' }),
    ).rejects.toThrow(/cuenta padre/i)
  })
})

describe('updateAccount', () => {
  it('cuenta fuera del (org, rfc) → 404 (aislamiento de tenant)', async () => {
    p.ledgerAccount.findFirst.mockResolvedValue(null)
    await expect(updateAccount('venue-1', 'acct-de-otro', { name: 'hack' }, { staffId: 's' })).rejects.toThrow(NotFoundError)
    // se buscó SCOPED por (org, rfc)
    expect(p.ledgerAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'acct-de-otro', organizationId: 'org1', rfc: 'TESC900101AAA' }) }),
    )
  })

  it('actualiza una cuenta del catálogo', async () => {
    p.ledgerAccount.findFirst.mockResolvedValue({ id: 'a1' })
    p.ledgerAccount.update.mockResolvedValue({
      id: 'a1',
      code: '101.01',
      satGroupingCode: '101',
      name: 'Caja MI NEGOCIO',
      type: 'ACTIVO',
      nature: 'DEUDORA',
      level: 2,
      parentId: 'p',
      isPostable: true,
      isActive: true,
    })
    const r = await updateAccount('venue-1', 'a1', { name: 'Caja MI NEGOCIO' }, { staffId: 's' })
    expect(r.name).toBe('Caja MI NEGOCIO')
  })
})
