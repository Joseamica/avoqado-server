/**
 * Unit tests (mock-first) for el motor de pólizas de GASTOS (Expense) — Capa B.
 *  - planExpenseEntry: dicta el asiento por escenario y SIEMPRE cuadra (Σdebe == Σhaber).
 *    PUE pagado / retenciones / IVA no acreditable / PPD devengo / IEPS / efectivo / redondeo.
 *  - generateExpensePoliciesForVenue / postExpensePolicy: idempotencia, skip por mapeo faltante,
 *    marca posted + journalEntryId.
 */
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    expense: { findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  },
}))
jest.mock('../../../src/services/fiscal/journalEntry.service', () => ({ postJournalEntry: jest.fn() }))
jest.mock('../../../src/services/fiscal/accountMapping.service', () => ({ getMappings: jest.fn() }))
jest.mock('../../../src/services/fiscal/chartOfAccounts.service', () => ({ resolveScopeOrNull: jest.fn() }))
jest.mock('../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import prisma from '../../../src/utils/prismaClient'
import { postJournalEntry } from '../../../src/services/fiscal/journalEntry.service'
import { getMappings } from '../../../src/services/fiscal/accountMapping.service'
import { resolveScopeOrNull } from '../../../src/services/fiscal/chartOfAccounts.service'
import {
  planExpenseEntry,
  planExpensePayment,
  generateExpensePoliciesForVenue,
  postExpensePolicy,
  markExpensePaid,
} from '../../../src/services/fiscal/expensePosting.service'

const p = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  expense: { findMany: jest.Mock; findFirst: jest.Mock; update: jest.Mock }
}
const mPost = postJournalEntry as jest.Mock
const mMappings = getMappings as jest.Mock
const mScope = resolveScopeOrNull as jest.Mock

const sum = (lines: { debitCents: number; creditCents: number }[]) => ({
  debe: lines.reduce((n, l) => n + l.debitCents, 0),
  haber: lines.reduce((n, l) => n + l.creditCents, 0),
})
const byMov = (lines: { movement: string; debitCents: number; creditCents: number }[], m: string) => lines.find(l => l.movement === m)

// Expense mínimo para planExpenseEntry (defaults del caso común PUE pagado, acreditable).
const exp = (over: Record<string, unknown> = {}) => ({
  comprobanteTipo: 'INGRESO',
  subtotalCents: 100_00,
  descuentoCents: 0,
  ivaCents: 16_00,
  iepsCents: 0,
  isrRetenidoCents: 0,
  ivaRetenidoCents: 0,
  totalCents: 116_00,
  deducible: true,
  ivaAcreditable: true,
  paymentStatus: 'PAID',
  formaPago: null,
  categoria: 'GASTO_GENERAL',
  ledgerAccountId: null,
  ...over,
})

describe('planExpenseEntry — cuadre + cuentas por escenario', () => {
  it('S1 PUE pagado simple: gasto + IVA acreditable, paga banco', () => {
    const { lines, movements } = planExpenseEntry(exp() as any)
    const s = sum(lines)
    expect(s.debe).toBe(s.haber)
    expect(s.debe).toBe(116_00)
    expect(byMov(lines, 'EXPENSE_GENERAL')!.debitCents).toBe(100_00)
    expect(byMov(lines, 'IVA_INPUT')!.debitCents).toBe(16_00)
    expect(byMov(lines, 'BANK_RECEIPT')!.creditCents).toBe(116_00)
    expect(movements).not.toContain('ROUNDING_DIFFERENCE')
  })

  it('S2 retenciones (serv. profesionales): cuadra con 216.10 + 216.04', () => {
    const { lines } = planExpenseEntry(
      exp({ subtotalCents: 10000_00, ivaCents: 1600_00, ivaRetenidoCents: 1066_67, isrRetenidoCents: 1000_00, totalCents: 9533_33 }) as any,
    )
    const s = sum(lines)
    expect(s.debe).toBe(s.haber)
    expect(byMov(lines, 'IVA_WITHHELD')!.creditCents).toBe(1066_67)
    expect(byMov(lines, 'ISR_WITHHELD')!.creditCents).toBe(1000_00)
    expect(byMov(lines, 'BANK_RECEIPT')!.creditCents).toBe(9533_33)
  })

  it('S3 IVA NO acreditable: el IVA se va al COSTO (sin 118.01)', () => {
    const { lines } = planExpenseEntry(exp({ ivaAcreditable: false }) as any)
    const s = sum(lines)
    expect(s.debe).toBe(s.haber)
    expect(byMov(lines, 'EXPENSE_GENERAL')!.debitCents).toBe(116_00) // gasto + IVA
    expect(byMov(lines, 'IVA_INPUT')).toBeUndefined()
  })

  it('S4 PPD a crédito: 119.01 pendiente + Proveedores 201.01', () => {
    const { lines, movements } = planExpenseEntry(exp({ paymentStatus: 'UNPAID' }) as any)
    const s = sum(lines)
    expect(s.debe).toBe(s.haber)
    expect(byMov(lines, 'IVA_INPUT_PENDING')!.debitCents).toBe(16_00)
    expect(byMov(lines, 'ACCOUNTS_PAYABLE')!.creditCents).toBe(116_00)
    expect(movements).not.toContain('IVA_INPUT')
  })

  it('S5 con IEPS: el IEPS entra a la base del gasto', () => {
    // sub 100 + ieps 50 = base 150; IVA 16% = 24; total 174
    const { lines } = planExpenseEntry(exp({ iepsCents: 50_00, ivaCents: 24_00, totalCents: 174_00 }) as any)
    const s = sum(lines)
    expect(s.debe).toBe(s.haber)
    expect(byMov(lines, 'EXPENSE_GENERAL')!.debitCents).toBe(150_00) // sub 100 + ieps 50
  })

  it('S6 efectivo (formaPago 01) → CASH_RECEIPT', () => {
    const { lines } = planExpenseEntry(exp({ formaPago: '01' }) as any)
    expect(byMov(lines, 'CASH_RECEIPT')!.creditCents).toBe(116_00)
    expect(byMov(lines, 'BANK_RECEIPT')).toBeUndefined()
  })

  it('S7 residuo de 1¢ → línea ROUNDING_DIFFERENCE para cuadrar', () => {
    // breakdown: sub 100 + iva 16 = 11600¢ debe; total 11599¢ → residuo 1¢ → rounding credit 1
    const { lines, movements } = planExpenseEntry(exp({ totalCents: 115_99 }) as any)
    const s = sum(lines)
    expect(s.debe).toBe(s.haber)
    expect(movements).toContain('ROUNDING_DIFFERENCE')
    expect(byMov(lines, 'ROUNDING_DIFFERENCE')!.creditCents).toBe(1)
  })

  it('S8 descuadre > 1¢ → unbalanceable, sin líneas', () => {
    const r = planExpenseEntry(exp({ totalCents: 100_00 }) as any)
    expect(r.unbalanceable).toBe(true)
    expect(r.lines).toHaveLength(0)
  })

  it('COSTO_MERCANCIA → débito a COST_OF_GOODS_SOLD', () => {
    const { lines } = planExpenseEntry(exp({ categoria: 'COSTO_MERCANCIA' }) as any)
    expect(byMov(lines, 'COST_OF_GOODS_SOLD')!.debitCents).toBe(100_00)
    expect(byMov(lines, 'EXPENSE_GENERAL')).toBeUndefined()
  })

  it('routing por categoría: ARRENDAMIENTO→EXPENSE_RENT, COMBUSTIBLE→EXPENSE_FUEL', () => {
    expect(byMov(planExpenseEntry(exp({ categoria: 'ARRENDAMIENTO' }) as any).lines, 'EXPENSE_RENT')!.debitCents).toBe(100_00)
    expect(byMov(planExpenseEntry(exp({ categoria: 'COMBUSTIBLE' }) as any).lines, 'EXPENSE_FUEL')!.debitCents).toBe(100_00)
    // HONORARIOS / SERVICIOS → 601.84 (las retenciones van en sus propias líneas)
    expect(byMov(planExpenseEntry(exp({ categoria: 'HONORARIOS' }) as any).lines, 'EXPENSE_GENERAL')!.debitCents).toBe(100_00)
  })

  it('comprobante EGRESO (nota de crédito) → skipReason, NO se postea como gasto', () => {
    const r = planExpenseEntry(exp({ comprobanteTipo: 'EGRESO' }) as any)
    expect(r.skipReason).toMatch(/EGRESO/)
    expect(r.lines).toHaveLength(0)
  })

  it('comprobante PAGO (REP) → skipReason', () => {
    expect(planExpenseEntry(exp({ comprobanteTipo: 'PAGO' }) as any).skipReason).toMatch(/PAGO/)
  })
})

// Mapeos completos (movimiento → cuenta) para la orquestación.
const FULL_MAPPINGS = {
  mappings: [
    'EXPENSE_GENERAL',
    'COST_OF_GOODS_SOLD',
    'IVA_INPUT',
    'IVA_INPUT_PENDING',
    'IVA_WITHHELD',
    'ISR_WITHHELD',
    'EXPENSE_RENT',
    'EXPENSE_FUEL',
    'BANK_RECEIPT',
    'CASH_RECEIPT',
    'ACCOUNTS_PAYABLE',
    'ROUNDING_DIFFERENCE',
  ].map(m => ({ movementType: m, account: { id: 'acc-' + m } })),
}
const dbExpense = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  proveedorNombre: 'Prov',
  proveedorRfc: 'AAA010101AAA',
  uuid: 'UUID1234ABCD',
  folio: null,
  fechaEmision: new Date('2026-06-10T12:00:00.000Z'),
  posted: false,
  ...exp(over),
})

describe('generateExpensePoliciesForVenue', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mScope.mockResolvedValue({ organizationId: 'org1', rfc: 'EKU9003173C9', venueType: 'AUTO_SERVICE' })
    mMappings.mockResolvedValue(FULL_MAPPINGS)
    p.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
    mPost.mockResolvedValue({ id: 'je1' })
    p.expense.update.mockResolvedValue({})
  })

  it('sin RFC → needsFiscalSetup', async () => {
    mScope.mockResolvedValue(null)
    const r = await generateExpensePoliciesForVenue('v1')
    expect(r.needsFiscalSetup).toBe(true)
  })

  it('postea cada gasto y marca posted + journalEntryId', async () => {
    p.expense.findMany.mockResolvedValue([dbExpense({}), dbExpense({ id: 'e2', paymentStatus: 'UNPAID' })])
    const r = await generateExpensePoliciesForVenue('v1', { period: '2026-06' })
    expect(r.posted).toBe(2)
    expect(mPost).toHaveBeenCalledTimes(2)
    expect(p.expense.update).toHaveBeenCalledWith({ where: { id: 'e1' }, data: { posted: true, journalEntryId: 'je1' } })
    // verifica que las líneas que se postearon cuadran
    const lines = mPost.mock.calls[0][1].lines
    expect(sum(lines).debe).toBe(sum(lines).haber)
  })

  it('gasto ya posteado → alreadyPosted, no re-postea', async () => {
    p.expense.findMany.mockResolvedValue([dbExpense({ posted: true })])
    const r = await generateExpensePoliciesForVenue('v1')
    expect(r.alreadyPosted).toBe(1)
    expect(mPost).not.toHaveBeenCalled()
  })

  it('mapeo faltante (sin IVA_INPUT) → salta ese gasto y lo reporta, no bloquea', async () => {
    mMappings.mockResolvedValue({ mappings: FULL_MAPPINGS.mappings.filter(m => m.movementType !== 'IVA_INPUT') })
    p.expense.findMany.mockResolvedValue([dbExpense({})])
    const r = await generateExpensePoliciesForVenue('v1')
    expect(r.posted).toBe(0)
    expect(r.skipped).toBe(1)
    expect(r.missingMappings).toContain('IVA_INPUT')
    expect(mPost).not.toHaveBeenCalled()
  })

  it('gasto con cuenta explícita (ledgerAccountId) no requiere mapeo de EXPENSE_GENERAL', async () => {
    mMappings.mockResolvedValue({ mappings: FULL_MAPPINGS.mappings.filter(m => m.movementType !== 'EXPENSE_GENERAL') })
    p.expense.findMany.mockResolvedValue([dbExpense({ ledgerAccountId: 'acc-custom' })])
    const r = await generateExpensePoliciesForVenue('v1')
    expect(r.posted).toBe(1)
    const lines = mPost.mock.calls[0][1].lines
    expect(lines[0].ledgerAccountId).toBe('acc-custom') // la línea del gasto usa la cuenta explícita
  })
})

describe('postExpensePolicy (uno)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mScope.mockResolvedValue({ organizationId: 'org1', rfc: 'EKU9003173C9', venueType: 'AUTO_SERVICE' })
    mMappings.mockResolvedValue(FULL_MAPPINGS)
    p.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
    mPost.mockResolvedValue({ id: 'je9' })
    p.expense.update.mockResolvedValue({})
  })

  it('gasto inexistente / de otro contribuyente → 0 candidatos', async () => {
    p.expense.findFirst.mockResolvedValue(null)
    const r = await postExpensePolicy('v1', 'nope', { staffId: 's' })
    expect(r.candidates).toBe(0)
    expect(r.posted).toBe(0)
  })

  it('postea uno y devuelve posted:1', async () => {
    p.expense.findFirst.mockResolvedValue(dbExpense({}))
    const r = await postExpensePolicy('v1', 'e1', { staffId: 's' })
    expect(r.posted).toBe(1)
    expect(mPost).toHaveBeenCalledTimes(1)
  })
})

describe('planExpensePayment — póliza de pago PPD', () => {
  it('201.01→banco + 119.01→118.01, cuadra', () => {
    const { lines, movements } = planExpensePayment(exp({ paymentStatus: 'UNPAID' }) as any)
    const s = sum(lines)
    expect(s.debe).toBe(s.haber)
    expect(byMov(lines, 'ACCOUNTS_PAYABLE')!.debitCents).toBe(116_00)
    expect(byMov(lines, 'BANK_RECEIPT')!.creditCents).toBe(116_00)
    expect(byMov(lines, 'IVA_INPUT')!.debitCents).toBe(16_00)
    expect(byMov(lines, 'IVA_INPUT_PENDING')!.creditCents).toBe(16_00)
    expect(movements).toContain('ACCOUNTS_PAYABLE')
  })

  it('efectivo (formaPago 01) → CASH_RECEIPT', () => {
    expect(byMov(planExpensePayment(exp({ formaPago: '01' }) as any).lines, 'CASH_RECEIPT')!.creditCents).toBe(116_00)
  })

  it('IVA no acreditable → sin líneas de IVA (sólo 201.01 ↔ banco)', () => {
    const { lines } = planExpensePayment(exp({ ivaAcreditable: false }) as any)
    expect(byMov(lines, 'IVA_INPUT')).toBeUndefined()
    expect(byMov(lines, 'IVA_INPUT_PENDING')).toBeUndefined()
    expect(sum(lines).debe).toBe(sum(lines).haber)
  })
})

describe('markExpensePaid', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mScope.mockResolvedValue({ organizationId: 'org1', rfc: 'EKU9003173C9', venueType: 'AUTO_SERVICE' })
    mMappings.mockResolvedValue(FULL_MAPPINGS)
    p.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
    mPost.mockResolvedValue({ id: 'jepay' })
    p.expense.update.mockResolvedValue({})
  })

  it('gasto inexistente → notFound', async () => {
    p.expense.findFirst.mockResolvedValue(null)
    const r = await markExpensePaid('v1', 'nope', { fechaPago: '2026-06-20' }, { staffId: 's' })
    expect(r.notFound).toBe(true)
    expect(p.expense.update).not.toHaveBeenCalled()
  })

  it('ya pagado → alreadyPaid, no re-postea', async () => {
    p.expense.findFirst.mockResolvedValue(dbExpense({ paymentStatus: 'PAID' }))
    const r = await markExpensePaid('v1', 'e1', { fechaPago: '2026-06-20' }, { staffId: 's' })
    expect(r.alreadyPaid).toBe(true)
    expect(p.expense.update).not.toHaveBeenCalled()
  })

  it('PPD no posteado → sólo flipa estado (paidPeriod del pago), sin póliza de pago', async () => {
    p.expense.findFirst.mockResolvedValue(dbExpense({ paymentStatus: 'UNPAID', posted: false }))
    const r = await markExpensePaid('v1', 'e1', { fechaPago: '2026-07-05' }, { staffId: 's' })
    expect(r.marked).toBe(true)
    expect(r.paymentPosted).toBe(false)
    expect(mPost).not.toHaveBeenCalled()
    expect(p.expense.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ paymentStatus: 'PAID', paidPeriod: '2026-07', paidCents: 116_00 }) }),
    )
  })

  it('PPD ya posteado en devengo → postea la póliza de pago (cuadra)', async () => {
    p.expense.findFirst.mockResolvedValue(dbExpense({ paymentStatus: 'UNPAID', posted: true }))
    const r = await markExpensePaid('v1', 'e1', { fechaPago: '2026-07-05' }, { staffId: 's' })
    expect(r.paymentPosted).toBe(true)
    expect(mPost).toHaveBeenCalledTimes(1)
    const call = mPost.mock.calls[0][1]
    expect(call.idempotencyKey).toBe('expense-pay:e1:v1')
    const lines = call.lines
    expect(lines.reduce((n: number, l: any) => n + l.debitCents, 0)).toBe(lines.reduce((n: number, l: any) => n + l.creditCents, 0))
  })

  it('mapeo faltante (sin ACCOUNTS_PAYABLE) en PPD ya posteado → NO marca pagado (un gasto pagado SIN póliza de pago sería irrecuperable), reporta faltanMapeos', async () => {
    mMappings.mockResolvedValue({ mappings: FULL_MAPPINGS.mappings.filter(m => m.movementType !== 'ACCOUNTS_PAYABLE') })
    p.expense.findFirst.mockResolvedValue(dbExpense({ paymentStatus: 'UNPAID', posted: true }))
    const r = await markExpensePaid('v1', 'e1', { fechaPago: '2026-07-05' }, { staffId: 's' })
    expect(r.marked).toBe(false)
    expect(r.paymentPosted).toBe(false)
    expect(r.missingMappings).toContain('ACCOUNTS_PAYABLE')
    expect(mPost).not.toHaveBeenCalled()
    // no se debe flipar a PAID: como no hay otro camino que postee `expense-pay:<id>`,
    // marcarlo pagado dejaría Proveedores/IVA-pendiente abiertos para siempre.
    expect(p.expense.update).not.toHaveBeenCalled()
  })

  it('PPD ya posteado: si el posteo de la póliza de pago FALLA, NO deja el gasto en PAID (sin huérfano, reintentable)', async () => {
    p.expense.findFirst.mockResolvedValue(dbExpense({ paymentStatus: 'UNPAID', posted: true }))
    mPost.mockRejectedValueOnce(new Error('serialization failure'))
    await expect(markExpensePaid('v1', 'e1', { fechaPago: '2026-07-05' }, { staffId: 's' })).rejects.toThrow()
    // el flip a PAID NO debe haberse commiteado antes de que la póliza de pago exista
    expect(p.expense.update).not.toHaveBeenCalled()
  })

  it('fecha inválida → BadRequestError', async () => {
    await expect(markExpensePaid('v1', 'e1', { fechaPago: '2026/07/05' }, { staffId: 's' })).rejects.toThrow()
  })
})
