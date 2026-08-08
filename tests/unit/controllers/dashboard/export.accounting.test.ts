/**
 * Accounting exports — expenses (Buzón) and the trial balance.
 *
 * The matrix answers "exportable" for accounting and it was not: the generic export helper
 * existed and was wired to exactly three listings (payments, orders, sales summary).
 *
 * The one risk that matters here is the UNIT. Every other listing in the platform is already
 * in pesos 1:1; the ledger and the expense records are the exception — they store whole CENTS.
 * A file shipping `123456` where the accountant expects `1234.56` loads cleanly into their
 * system and surfaces weeks later, if ever. So every money column is asserted, including the
 * zero and null edges, and the balance is checked to hold AFTER the conversion.
 */
import type { Request, Response } from 'express'
import { readFileSync } from 'fs'
import { join } from 'path'

const listExpenses = jest.fn()
jest.mock('@/services/fiscal/expense.service', () => ({ listExpenses }))

const getTrialBalance = jest.fn()
const currentPeriod = jest.fn(() => '2026-08')
jest.mock('@/services/fiscal/trialBalance.service', () => ({ getTrialBalance, currentPeriod }))

const encodeExport = jest.fn()
const sendExport = jest.fn()
jest.mock('@/services/dashboard/export.helpers', () => ({
  ...jest.requireActual('@/services/dashboard/export.helpers'),
  encodeExport,
  sendExport,
}))

import { exportExpenses, exportTrialBalance } from '@/controllers/dashboard/accounting.export.controller'

type Column = { id: string; label: string; value: (row: any) => string | number | null | undefined }

const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }) as unknown as Response
/**
 * The controllers declare a narrowly-typed `Request<{ venueId }, {}, {}, {...query}>`, so a
 * bare `as unknown as Request` does not satisfy them — the generic `Request` is not
 * assignable to the narrow one. `any` here is deliberate and contained: the double is a
 * hand-rolled stub, and mirroring each controller's exact query generic would couple every
 * test to a signature that is free to change.
 */
const req = (query: Record<string, string> = {}): any => ({
  params: { venueId: 'venue-1' },
  query,
  authContext: { venueId: 'venue-1', userId: 'staff-1' },
})

const columns = (): Column[] => encodeExport.mock.calls[0][1].allColumns
const column = (id: string): Column => {
  const found = columns().find(c => c.id === id)
  if (!found)
    throw new Error(
      `No export column with id '${id}'. Got: ${columns()
        .map(c => c.id)
        .join(', ')}`,
    )
  return found
}
const rows = (): any[] => encodeExport.mock.calls[0][1].rows

const expense = (over: Record<string, unknown> = {}) => ({
  id: 'exp-1',
  proveedorRfc: 'PRO010101AAA',
  proveedorNombre: 'Distribuidora del Bajío',
  tipoTercero: 'NACIONAL',
  comprobanteTipo: 'INGRESO',
  metodoPago: 'PUE',
  categoria: 'COSTO_MERCANCIA',
  fechaEmision: '2026-07-15',
  fechaPago: '2026-07-15',
  subtotalCents: 100_000,
  descuentoCents: 0,
  ivaCents: 16_000,
  iva16Cents: 16_000,
  iva8Cents: 0,
  iepsCents: 0,
  isrRetenidoCents: 0,
  ivaRetenidoCents: 0,
  totalCents: 116_000,
  deducible: true,
  ivaAcreditable: true,
  paymentStatus: 'PAID',
  paidCents: 116_000,
  paidPeriod: '2026-07',
  posted: false,
  uuid: 'B7E4C0A2-0000-4000-8000-000000000001',
  serie: 'A',
  folio: '123',
  source: 'MANUAL',
  status: 'REGISTERED',
  createdAt: '2026-07-15T18:00:00.000Z',
  ...over,
})

/**
 * Debits and credits that balance in cents but whose peso halves do NOT sum equal in binary
 * floating point (333.33 + 666.67 !== 1000). That is the point: the assertion has to hold to
 * the cent, not to the bit.
 */
const balancedTrialBalance = () => ({
  needsFiscalSetup: false,
  organizationId: 'org-1',
  rfc: 'AVO240101AB1',
  period: '2026-07',
  rows: [
    {
      code: '101.01',
      name: 'Caja',
      type: 'ACTIVO',
      nature: 'DEUDORA',
      saldoInicialCents: 0,
      debeCents: 33_333,
      haberCents: 0,
      saldoFinalCents: 33_333,
    },
    {
      code: '102.01',
      name: 'Bancos',
      type: 'ACTIVO',
      nature: 'DEUDORA',
      saldoInicialCents: 0,
      debeCents: 66_667,
      haberCents: 0,
      saldoFinalCents: 66_667,
    },
    {
      code: '401.01',
      name: 'Ventas',
      type: 'INGRESO',
      nature: 'ACREEDORA',
      saldoInicialCents: 0,
      debeCents: 0,
      haberCents: 100_000,
      saldoFinalCents: -100_000,
    },
  ],
  totals: {
    debeCents: 100_000,
    haberCents: 100_000,
    saldoInicialDeudorCents: 0,
    saldoInicialAcreedorCents: 0,
    saldoFinalDeudorCents: 100_000,
    saldoFinalAcreedorCents: 100_000,
  },
  balanced: { movements: true, balances: true },
})

beforeEach(() => {
  jest.clearAllMocks()
  encodeExport.mockResolvedValue({ buffer: Buffer.from(''), contentType: 'text/csv', extension: 'csv' })
  currentPeriod.mockReturnValue('2026-08')
  listExpenses.mockResolvedValue({
    needsFiscalSetup: false,
    organizationId: 'org-1',
    rfc: 'AVO240101AB1',
    expenses: [expense()],
    summary: { count: 1, totalCents: 116_000, ivaCents: 16_000, deducibleCents: 100_000 },
  })
  getTrialBalance.mockResolvedValue(balancedTrialBalance())
})

describe('exportExpenses', () => {
  it('🔴 converts cents to pesos — a 100x file is the whole risk of this task', async () => {
    // The expense records store whole cents. Everything leaving for a human divides by 100.
    // This is one of the two places in the platform where money is not already pesos 1:1.
    await exportExpenses(req(), res(), jest.fn())

    expect(column('total').value({ totalCents: 123_456 })).toBe(1234.56)
    expect(column('subtotal').value({ subtotalCents: 123_456 })).toBe(1234.56)
    expect(column('vat').value({ ivaCents: 123_456 })).toBe(1234.56)
  })

  it('a zero-cent amount exports as 0, not blank', async () => {
    await exportExpenses(req(), res(), jest.fn())
    expect(column('total').value({ totalCents: 0 })).toBe(0)
  })

  it('a null amount exports as 0, not NaN', async () => {
    await exportExpenses(req(), res(), jest.fn())
    expect(column('total').value({ totalCents: null })).toBe(0)
    expect(column('total').value({})).toBe(0)
  })

  it('🔴 exports the SAME filters the screen is showing', async () => {
    // Exporting "everything" while the user looks at a filtered view is found late and badly:
    // the file is plausible, just wrong.
    await exportExpenses(req({ period: '2026-07', paymentStatus: 'PAID', proveedorRfc: 'pro010101aaa' }), res(), jest.fn())

    expect(listExpenses).toHaveBeenCalledWith(
      'venue-1',
      expect.objectContaining({ period: '2026-07', paymentStatus: 'PAID', proveedorRfc: 'pro010101aaa' }),
    )
  })

  it('🔴 refuses at the listing ceiling instead of shipping a truncated file', async () => {
    // `listExpenses` hard-caps at 500 rows. At the ceiling we cannot tell "exactly 500" from
    // "the first 500 of many", and a file with the first N rows reads as complete.
    listExpenses.mockResolvedValue({
      needsFiscalSetup: false,
      organizationId: 'org-1',
      rfc: 'AVO240101AB1',
      expenses: Array.from({ length: 500 }, (_, i) => expense({ id: `exp-${i}` })),
      summary: { count: 500, totalCents: 0, ivaCents: 0, deducibleCents: 0 },
    })
    const r = res()

    await exportExpenses(req(), r, jest.fn())

    expect(r.status).toHaveBeenCalledWith(413)
    expect(encodeExport).not.toHaveBeenCalled()
  })

  it('🔴 refuses when the venue has no fiscal RFC instead of shipping an empty file', async () => {
    // An empty file reads as "there were no expenses". The truth is "this venue was never set
    // up for CFDI" — a different problem with a different fix.
    listExpenses.mockResolvedValue({
      needsFiscalSetup: true,
      organizationId: null,
      rfc: null,
      expenses: [],
      summary: { count: 0, totalCents: 0, ivaCents: 0, deducibleCents: 0 },
    })
    const r = res()

    await exportExpenses(req(), r, jest.fn())

    expect(r.status).toHaveBeenCalledWith(400)
    expect(encodeExport).not.toHaveBeenCalled()
  })

  it('reports the payment status in Spanish, not the enum', async () => {
    // "PARTIALLY_PAID" in a column an accountant reads is our schema leaking into their report.
    await exportExpenses(req(), res(), jest.fn())

    const col = column('paymentStatus')
    expect(col.value({ paymentStatus: 'PAID' })).toBe('Pagado')
    expect(col.value({ paymentStatus: 'UNPAID' })).toBe('Pendiente')
    expect(col.value({ paymentStatus: 'PARTIALLY_PAID' })).toBe('Parcial')
  })

  it('ships the columns a deduction review needs, labelled in Spanish', async () => {
    await exportExpenses(req(), res(), jest.fn())

    expect(columns().map(c => c.id)).toEqual(
      expect.arrayContaining(['issueDate', 'supplierRfc', 'supplierName', 'uuid', 'subtotal', 'vat', 'total', 'deductible']),
    )
    expect(columns().map(c => c.label)).toContain('Total')
  })

  it('TENANT: only ever asks for the venue in the request', async () => {
    await exportExpenses(req(), res(), jest.fn())
    expect(listExpenses).toHaveBeenCalledWith('venue-1', expect.anything())
  })
})

describe('exportTrialBalance', () => {
  it('🔴 converts cents to pesos — a 100x file is the whole risk of this task', async () => {
    // The ledger stores whole cents. Everything leaving for a human divides by 100.
    await exportTrialBalance(req(), res(), jest.fn())

    expect(column('debit').value({ debeCents: 123_456 })).toBe(1234.56)
    expect(column('credit').value({ haberCents: 123_456 })).toBe(1234.56)
    expect(column('closingBalance').value({ saldoFinalCents: -123_456 })).toBe(-1234.56)
  })

  it('a zero-cent amount exports as 0, not blank', async () => {
    await exportTrialBalance(req(), res(), jest.fn())
    expect(column('debit').value({ debeCents: 0 })).toBe(0)
  })

  it('a null amount exports as 0, not NaN', async () => {
    await exportTrialBalance(req(), res(), jest.fn())
    expect(column('debit').value({ debeCents: null })).toBe(0)
    expect(column('debit').value({})).toBe(0)
  })

  it('🔴 the trial balance still balances after conversion', async () => {
    // If rounding breaks the debit/credit equality, the file is worthless to an accountant —
    // and worse, it looks fine until they try to load it. Asserted to the CENT, because the
    // peso halves of a balanced ledger do not sum equal in binary floating point.
    await exportTrialBalance(req(), res(), jest.fn())

    const debit = column('debit')
    const credit = column('credit')
    const sum = (col: Column) => rows().reduce((acc, row) => acc + Number(col.value(row)), 0)

    expect(Math.round(sum(debit) * 100)).toBe(Math.round(sum(credit) * 100))
    expect(Math.round(sum(debit) * 100)).toBe(100_000)
  })

  it('uses the requested period, and the current one when none is given', async () => {
    await exportTrialBalance(req({ period: '2026-07' }), res(), jest.fn())
    expect(getTrialBalance).toHaveBeenCalledWith('venue-1', '2026-07')

    jest.clearAllMocks()
    encodeExport.mockResolvedValue({ buffer: Buffer.from(''), contentType: 'text/csv', extension: 'csv' })
    currentPeriod.mockReturnValue('2026-08')
    getTrialBalance.mockResolvedValue(balancedTrialBalance())

    await exportTrialBalance(req(), res(), jest.fn())
    expect(getTrialBalance).toHaveBeenCalledWith('venue-1', '2026-08')
  })

  it('🔴 refuses over the cap instead of truncating', async () => {
    // PDF is capped harder than the sheet formats; a chart of accounts can exceed it.
    getTrialBalance.mockResolvedValue({
      ...balancedTrialBalance(),
      rows: Array.from({ length: 1001 }, (_, i) => ({
        code: `5${String(i).padStart(4, '0')}`,
        name: `Cuenta ${i}`,
        type: 'GASTO',
        nature: 'DEUDORA',
        saldoInicialCents: 0,
        debeCents: 100,
        haberCents: 0,
        saldoFinalCents: 100,
      })),
    })
    const r = res()

    await exportTrialBalance(req({ format: 'pdf' }), r, jest.fn())

    expect(r.status).toHaveBeenCalledWith(413)
    expect(encodeExport).not.toHaveBeenCalled()
  })

  it('🔴 refuses when the venue has no fiscal RFC instead of shipping an empty file', async () => {
    getTrialBalance.mockResolvedValue({
      needsFiscalSetup: true,
      organizationId: null,
      rfc: null,
      period: '2026-08',
      rows: [],
      totals: {
        debeCents: 0,
        haberCents: 0,
        saldoInicialDeudorCents: 0,
        saldoInicialAcreedorCents: 0,
        saldoFinalDeudorCents: 0,
        saldoFinalAcreedorCents: 0,
      },
      balanced: { movements: true, balances: true },
    })
    const r = res()

    await exportTrialBalance(req(), r, jest.fn())

    expect(r.status).toHaveBeenCalledWith(400)
    expect(encodeExport).not.toHaveBeenCalled()
  })

  it('ships the account identity next to the numbers, labelled in Spanish', async () => {
    await exportTrialBalance(req(), res(), jest.fn())

    expect(columns().map(c => c.id)).toEqual(
      expect.arrayContaining(['code', 'name', 'type', 'openingBalance', 'debit', 'credit', 'closingBalance']),
    )
    expect(columns().map(c => c.label)).toContain('Cargos')
  })

  it('TENANT: only ever asks for the venue in the request', async () => {
    await exportTrialBalance(req(), res(), jest.fn())
    expect(getTrialBalance).toHaveBeenCalledWith('venue-1', expect.any(String))
  })
})

/**
 * The accounting exports had no route guard at all — the inventory ones do. A controller that
 * works and a route Express never reaches look identical from a unit test, which is how
 * `/purchase-orders/stats` shipped dead.
 */
describe('accounting export routes', () => {
  const source = readFileSync(join(__dirname, '../../../../src/routes/dashboard/accounting.routes.ts'), 'utf8')

  it('🔴 /expenses/export is declared before any /expenses/:expenseId route', () => {
    const at = source.indexOf("'/expenses/export'")
    expect(at).toBeGreaterThan(-1)
    const firstDynamic = source.indexOf("'/expenses/:expenseId")
    expect(firstDynamic).toBeGreaterThan(-1)
    expect(at).toBeLessThan(firstDynamic)
  })

  it('🔴 both exports carry the CFDI plan lock and accounting:read', () => {
    // An export that skips the lock on the module feeding it is a plan hole: the numbers leave
    // the building for a venue that never paid for the fiscal layer.
    for (const path of ["'/expenses/export'", "'/trial-balance/export'"]) {
      const at = source.indexOf(path)
      expect(at).toBeGreaterThan(-1)
      const declaration = source.slice(at, at + 250)
      expect(declaration).toContain("checkFeatureAccess('CFDI')")
      expect(declaration).toContain("checkPermission('accounting:read')")
    }
  })
})
