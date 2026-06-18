/**
 * Unit tests (mock-first) para el Auxiliar de cuenta (libro mayor por cuenta, Capa B).
 *  - saldo inicial = neto (cargo−abono) de periodos anteriores;
 *  - movimientos del periodo con SALDO CORRIDO (+ = deudor) y totales;
 *  - saldoFinal = inicial + Σ(cargo−abono); cuenta inexistente → notFound; sin RFC → needsFiscalSetup.
 */
import { BadRequestError } from '../../../src/errors/AppError'

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    ledgerAccount: { findUnique: jest.fn() },
    journalLine: { aggregate: jest.fn(), findMany: jest.fn() },
  },
}))
jest.mock('../../../src/services/fiscal/chartOfAccounts.service', () => ({ resolveScopeOrNull: jest.fn() }))

import prisma from '../../../src/utils/prismaClient'
import { resolveScopeOrNull } from '../../../src/services/fiscal/chartOfAccounts.service'
import { getAccountLedger } from '../../../src/services/fiscal/accountLedger.service'

const p = prisma as unknown as {
  ledgerAccount: { findUnique: jest.Mock }
  journalLine: { aggregate: jest.Mock; findMany: jest.Mock }
}
const mScope = resolveScopeOrNull as jest.Mock

const line = (over: Record<string, unknown> = {}) => ({
  description: null,
  debitCents: 0,
  creditCents: 0,
  journalEntry: { date: new Date('2026-06-10T12:00:00Z'), folio: 1, concept: 'Venta del día', source: 'AUTO_PAYMENT' },
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  mScope.mockResolvedValue({ organizationId: 'org1', rfc: 'EKU9003173C9', venueType: 'AUTO_SERVICE' })
  p.ledgerAccount.findUnique.mockResolvedValue({ id: 'acc1', code: '102.01', name: 'Bancos', type: 'ACTIVO', nature: 'DEUDORA' })
  p.journalLine.aggregate.mockResolvedValue({ _sum: { debitCents: 0, creditCents: 0 } })
  p.journalLine.findMany.mockResolvedValue([])
})

it('periodo inválido → BadRequestError', async () => {
  await expect(getAccountLedger('v1', '102.01', '2026-13')).rejects.toThrow(BadRequestError)
})

it('código vacío → BadRequestError', async () => {
  await expect(getAccountLedger('v1', '  ', '2026-06')).rejects.toThrow(BadRequestError)
})

it('sin RFC → needsFiscalSetup (no busca la cuenta)', async () => {
  mScope.mockResolvedValue(null)
  const r = await getAccountLedger('v1', '102.01', '2026-06')
  expect(r.needsFiscalSetup).toBe(true)
  expect(p.ledgerAccount.findUnique).not.toHaveBeenCalled()
})

it('cuenta inexistente → notFound', async () => {
  p.ledgerAccount.findUnique.mockResolvedValue(null)
  const r = await getAccountLedger('v1', '999.99', '2026-06')
  expect(r.notFound).toBe(true)
  expect(r.account).toBeNull()
})

it('saldo inicial + movimientos con saldo corrido + totales + saldo final', async () => {
  p.journalLine.aggregate.mockResolvedValue({ _sum: { debitCents: 50_000, creditCents: 0 } }) // saldo inicial $500 deudor
  p.journalLine.findMany.mockResolvedValue([
    line({
      debitCents: 116_000,
      creditCents: 0,
      description: 'Cobro',
      journalEntry: { date: new Date('2026-06-05T12:00:00Z'), folio: 3, concept: 'Venta', source: 'AUTO_PAYMENT' },
    }),
    line({
      debitCents: 0,
      creditCents: 30_000,
      description: 'Pago proveedor',
      journalEntry: { date: new Date('2026-06-20T12:00:00Z'), folio: 8, concept: 'Gasto', source: 'AUTO_EXPENSE' },
    }),
  ])
  const r = await getAccountLedger('v1', '102.01', '2026-06')
  expect(r.saldoInicialCents).toBe(50_000)
  expect(r.movements).toHaveLength(2)
  // saldo corrido: 50000 +116000 = 166000 ; 166000 −30000 = 136000
  expect(r.movements[0].saldoCents).toBe(166_000)
  expect(r.movements[0].date).toBe('2026-06-05')
  expect(r.movements[0].concept).toBe('Venta')
  expect(r.movements[0].description).toBe('Cobro')
  expect(r.movements[1].saldoCents).toBe(136_000)
  expect(r.totalDebeCents).toBe(116_000)
  expect(r.totalHaberCents).toBe(30_000)
  expect(r.saldoFinalCents).toBe(136_000) // inicial + cargos − abonos
  expect(r.account).toEqual({ code: '102.01', name: 'Bancos', type: 'ACTIVO', nature: 'DEUDORA' })
})

it('sin movimientos pero con saldo inicial → saldoFinal == saldoInicial', async () => {
  p.journalLine.aggregate.mockResolvedValue({ _sum: { debitCents: 0, creditCents: 20_000 } }) // inicial −$200 (acreedor)
  const r = await getAccountLedger('v1', '102.01', '2026-06')
  expect(r.movements).toHaveLength(0)
  expect(r.saldoInicialCents).toBe(-20_000)
  expect(r.saldoFinalCents).toBe(-20_000)
})

it('filtra por POSTED + cuenta + periodo (where correcto)', async () => {
  await getAccountLedger('v1', '102.01', '2026-06')
  const findWhere = p.journalLine.findMany.mock.calls[0][0].where
  expect(findWhere).toMatchObject({
    ledgerAccountId: 'acc1',
    journalEntry: { organizationId: 'org1', rfc: 'EKU9003173C9', status: 'POSTED', period: '2026-06' },
  })
  const aggWhere = p.journalLine.aggregate.mock.calls[0][0].where
  expect(aggWhere.journalEntry.period).toEqual({ lt: '2026-06' }) // saldo inicial = periodos anteriores
})
