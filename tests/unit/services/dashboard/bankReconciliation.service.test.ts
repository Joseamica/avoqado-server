jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { payment: { findMany: jest.fn() } },
}))

import { matchLines, parseBankCsv, type DepositCandidate, type ParsedBankLine } from '../../../../src/services/dashboard/bankReconciliation.service'

const noon = (ymd: string): Date => new Date(`${ymd}T12:00:00`)
const line = (
  rowIndex: number,
  ymd: string,
  amountCents: number,
  opts: { reference?: string | null; direction?: 'CREDIT' | 'DEBIT' } = {},
): ParsedBankLine => ({
  rowIndex,
  postedDate: noon(ymd),
  description: 'deposito',
  reference: opts.reference ?? null,
  amountCents,
  direction: opts.direction ?? 'CREDIT',
})
const cand = (ymd: string, netCents: number): DepositCandidate => ({ key: ymd, date: noon(ymd), netCents, paymentCount: 1 })

describe('bankReconciliation — matchLines (the moat)', () => {
  // ---------- NEW FEATURE ----------
  it('exact match: same amount + same day → MATCHED, score 1', () => {
    const r = matchLines([line(0, '2026-06-10', 55_75)], [cand('2026-06-10', 55_75)])
    expect(r[0]).toMatchObject({ matchStatus: 'MATCHED', matchScore: 1, matchedKey: '2026-06-10' })
  })

  it('within date window: bank posts +2 days → MATCHED', () => {
    const r = matchLines([line(0, '2026-06-12', 11_084)], [cand('2026-06-10', 11_084)])
    expect(r[0].matchStatus).toBe('MATCHED')
  })

  it('outside date window: +3 days (default window 2) → UNMATCHED', () => {
    const r = matchLines([line(0, '2026-06-13', 11_084)], [cand('2026-06-10', 11_084)])
    expect(r[0].matchStatus).toBe('UNMATCHED')
  })

  it('amount tolerance: within amountTolCents → MATCHED, score 0.9', () => {
    const r = matchLines([line(0, '2026-06-10', 10_000)], [cand('2026-06-10', 10_002)], { amountTolCents: 5 })
    expect(r[0]).toMatchObject({ matchStatus: 'MATCHED', matchScore: 0.9 })
  })

  it('duplicate: identical (amount, day, ref) appearing twice → second is DUPLICATE', () => {
    const r = matchLines(
      [line(0, '2026-06-10', 5000, { reference: 'ABC' }), line(1, '2026-06-10', 5000, { reference: 'ABC' })],
      [cand('2026-06-10', 5000)],
    )
    expect(r[0].matchStatus).toBe('MATCHED')
    expect(r[1].matchStatus).toBe('DUPLICATE')
  })

  it('one candidate consumed once: two equal deposits, one expected day → 1 MATCHED, 1 UNMATCHED', () => {
    const r = matchLines([line(0, '2026-06-10', 5000, { reference: 'A' }), line(1, '2026-06-10', 5000, { reference: 'B' })], [cand('2026-06-10', 5000)])
    const statuses = r.map(x => x.matchStatus).sort()
    expect(statuses).toEqual(['MATCHED', 'UNMATCHED'])
  })

  it('unmatched: deposit with no candidate (cash deposit / external income) → UNMATCHED', () => {
    const r = matchLines([line(0, '2026-06-10', 9999)], [cand('2026-06-10', 5000)])
    expect(r[0].matchStatus).toBe('UNMATCHED')
  })

  // ---------- REGRESSION / INVARIANTS ----------
  it('DEBIT lines are out of scope → UNMATCHED (never consume a candidate)', () => {
    const r = matchLines([line(0, '2026-06-10', -5000, { direction: 'DEBIT' }), line(1, '2026-06-10', 5000)], [cand('2026-06-10', 5000)])
    expect(r[0].matchStatus).toBe('UNMATCHED') // the debit
    expect(r[1].matchStatus).toBe('MATCHED') // the credit still got the candidate
  })

  it('empty inputs → empty result (no throw)', () => {
    expect(matchLines([], [])).toEqual([])
  })
})

describe('bankReconciliation — parseBankCsv', () => {
  it('parses separate cargo/abono columns (Banorte/BBVA style)', () => {
    const csv = ['Fecha,Concepto,Referencia,Cargo,Abono', '10/06/2026,DEPOSITO TPV,REF123,,"1,234.56"', '11/06/2026,COMISION,REF124,50.00,'].join('\n')
    const lines = parseBankCsv(csv)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ amountCents: 123_456, direction: 'CREDIT', reference: 'REF123' })
    expect(lines[1]).toMatchObject({ amountCents: -5000, direction: 'DEBIT' })
  })

  it('parses a single signed monto column', () => {
    const csv = ['fecha,descripcion,monto', '2026-06-10,Deposito,1500.00', '2026-06-11,Retiro,(200.00)'].join('\n')
    const lines = parseBankCsv(csv)
    expect(lines[0]).toMatchObject({ amountCents: 150_000, direction: 'CREDIT' })
    expect(lines[1]).toMatchObject({ amountCents: -20_000, direction: 'DEBIT' })
  })

  it('skips rows without a valid date (headers/saldos)', () => {
    const csv = ['Fecha,Concepto,Abono', 'Saldo inicial,,', '10/06/2026,Deposito,"500.00"'].join('\n')
    expect(parseBankCsv(csv)).toHaveLength(1)
  })
})
