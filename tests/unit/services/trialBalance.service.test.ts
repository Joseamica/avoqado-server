/**
 * Unit tests (mock-first) for the Balanza de comprobación (trial balance) read-model.
 * Lock: saldo inicial = acumulado anterior, saldo final = inicial + cargos − abonos, y el
 * CUADRE (Σcargos == Σabonos, saldo deudor == saldo acreedor).
 */
import { BadRequestError } from '../../../src/errors/AppError'

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    fiscalEmisor: { findFirst: jest.fn() },
    journalLine: { groupBy: jest.fn() },
    ledgerAccount: { findMany: jest.fn() },
  },
}))

import prisma from '../../../src/utils/prismaClient'
import { getTrialBalance, currentPeriod } from '../../../src/services/fiscal/trialBalance.service'

const p = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  fiscalEmisor: { findFirst: jest.Mock }
  journalLine: { groupBy: jest.Mock }
  ledgerAccount: { findMany: jest.Mock }
}

beforeEach(() => {
  jest.clearAllMocks()
  p.venue.findUnique.mockResolvedValue({ organizationId: 'org1', rfc: 'TESC900101AAA', type: 'AUTO_SERVICE' })
  p.fiscalEmisor.findFirst.mockResolvedValue(null)
})

it('periodo inválido → 400', async () => {
  await expect(getTrialBalance('v1', '2026-6')).rejects.toThrow(BadRequestError)
})

describe('currentPeriod — VENUE-LOCAL month (regression: UTC rollover posted to the wrong month)', () => {
  afterEach(() => jest.useRealTimers())

  it('at month-end evening in Mexico (already next month in UTC) returns the MEXICO month', () => {
    // 2026-06-30 23:30 America/Mexico_City == 2026-07-01 05:30 UTC. The old getUTCMonth()
    // logic returned '2026-07' here; venue-local must return '2026-06'.
    jest.useFakeTimers().setSystemTime(new Date('2026-07-01T05:30:00.000Z'))
    expect(currentPeriod()).toBe('2026-06') // default tz = America/Mexico_City
    expect(currentPeriod('UTC')).toBe('2026-07') // proves it's the tz, not the wall clock, that decides
  })

  it('is host-timezone independent (same result regardless of the Node process TZ)', () => {
    // Mid-month, unambiguous — the default must be the Mexico month no matter the host tz.
    jest.useFakeTimers().setSystemTime(new Date('2026-03-15T12:00:00.000Z'))
    expect(currentPeriod()).toBe('2026-03')
  })
})

it('sin RFC → needsFiscalSetup', async () => {
  p.venue.findUnique.mockResolvedValue({ organizationId: 'org1', rfc: null, type: 'AUTO_SERVICE' })
  const r = await getTrialBalance('v1', '2026-06')
  expect(r.needsFiscalSetup).toBe(true)
  expect(r.rows).toEqual([])
})

it('sin movimientos → balanza vacía que cuadra', async () => {
  p.journalLine.groupBy.mockResolvedValue([])
  const r = await getTrialBalance('v1', '2026-06')
  expect(r.rows).toEqual([])
  expect(r.balanced).toEqual({ movements: true, balances: true })
})

it('calcula saldo inicial (acumulado), cargos/abonos del periodo, saldo final y el cuadre', async () => {
  // periodo (1ª llamada) y acumulado anterior (2ª llamada)
  p.journalLine.groupBy
    .mockResolvedValueOnce([
      { ledgerAccountId: 'caja', _sum: { debitCents: 3000, creditCents: 0 } },
      { ledgerAccountId: 'ventas', _sum: { debitCents: 0, creditCents: 3000 } },
    ])
    .mockResolvedValueOnce([
      { ledgerAccountId: 'caja', _sum: { debitCents: 1000, creditCents: 0 } },
      { ledgerAccountId: 'ventas', _sum: { debitCents: 0, creditCents: 1000 } },
    ])
  p.ledgerAccount.findMany.mockResolvedValue([
    { id: 'caja', code: '101.01', name: 'Caja', type: 'ACTIVO', nature: 'DEUDORA' },
    { id: 'ventas', code: '401.01', name: 'Ventas', type: 'INGRESO', nature: 'ACREEDORA' },
  ])

  const r = await getTrialBalance('v1', '2026-06')
  const row = (code: string) => r.rows.find(x => x.code === code)!

  expect(row('101.01').saldoInicialCents).toBe(1000) // acumulado anterior (cargo)
  expect(row('101.01').debeCents).toBe(3000)
  expect(row('101.01').haberCents).toBe(0)
  expect(row('101.01').saldoFinalCents).toBe(4000) // 1000 + 3000 - 0
  expect(row('401.01').saldoInicialCents).toBe(-1000) // acreedor (negativo)
  expect(row('401.01').saldoFinalCents).toBe(-4000)

  expect(r.totals.debeCents).toBe(3000)
  expect(r.totals.haberCents).toBe(3000)
  expect(r.totals.saldoFinalDeudorCents).toBe(4000)
  expect(r.totals.saldoFinalAcreedorCents).toBe(4000)
  expect(r.balanced).toEqual({ movements: true, balances: true }) // CUADRA
})
