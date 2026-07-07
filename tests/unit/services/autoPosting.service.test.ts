/**
 * Unit tests (mock-first) del motor de POSTEO AUTOMÁTICO de pólizas (slice 2).
 * Lock contable: cada póliza generada CUADRA (Σdebe==Σhaber), las cuentas correctas, idempotencia
 * (no re-postea), enrutado venta vs devolución por signo/type, reglas de exclusión, y falta-de-mapeo.
 */
import { PaymentMethod, PaymentType, OrderStatus } from '@prisma/client'

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    payment: { findMany: jest.fn() },
    fiscalEmisor: { findFirst: jest.fn() },
    journalEntry: { findMany: jest.fn() },
  },
}))
jest.mock('../../../src/services/fiscal/chartOfAccounts.service', () => ({ resolveScopeOrNull: jest.fn() }))
jest.mock('../../../src/services/fiscal/accountMapping.service', () => ({ getMappings: jest.fn() }))
jest.mock('../../../src/services/fiscal/journalEntry.service', () => ({ postJournalEntry: jest.fn() }))
jest.mock('date-fns-tz', () => ({ formatInTimeZone: () => '2026-06-15' }))

import prisma from '../../../src/utils/prismaClient'
import { resolveScopeOrNull } from '../../../src/services/fiscal/chartOfAccounts.service'
import { getMappings } from '../../../src/services/fiscal/accountMapping.service'
import { postJournalEntry } from '../../../src/services/fiscal/journalEntry.service'
import { generatePoliciesForVenue } from '../../../src/services/fiscal/autoPosting.service'

const p = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  payment: { findMany: jest.Mock }
  fiscalEmisor: { findFirst: jest.Mock }
  journalEntry: { findMany: jest.Mock }
}
const mockScope = resolveScopeOrNull as jest.Mock
const mockMappings = getMappings as jest.Mock
const mockPost = postJournalEntry as jest.Mock

const REQUIRED = ['SALES_REVENUE', 'SALES_RETURN', 'IVA_OUTPUT', 'CASH_RECEIPT', 'BANK_RECEIPT', 'TIPS_PAYABLE', 'PROCESSOR_FEE']
// account.id = `acc:${movementType}` para poder afirmar qué cuenta tocó cada línea.
const fullMappings = (omit: string[] = []) => ({
  needsFiscalSetup: false,
  catalogSeeded: true,
  organizationId: 'o1',
  rfc: 'RFC',
  mappings: REQUIRED.map(mt => ({ movementType: mt, account: omit.includes(mt) ? null : { id: `acc:${mt}`, code: mt } })),
})
const pay = (o: Partial<Record<string, unknown>>) => ({
  id: 'pay1',
  amount: 0,
  tipAmount: 0,
  feeAmount: 0,
  method: PaymentMethod.CREDIT_CARD,
  type: PaymentType.REGULAR,
  createdAt: new Date('2026-06-15T18:00:00Z'),
  order: { status: OrderStatus.COMPLETED, orderNumber: '123' },
  ...o,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockScope.mockResolvedValue({ organizationId: 'o1', rfc: 'RFC', venueType: 'X' })
  mockMappings.mockResolvedValue(fullMappings())
  p.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
  // Default en tests: venue OPTA por incluir el efectivo en los libros (para que las ventas en efectivo
  // sí posteen). El default real es false — su exclusión se cubre en un test dedicado abajo.
  p.fiscalEmisor.findFirst.mockResolvedValue({ includeCashInAccounting: true })
  p.journalEntry.findMany.mockResolvedValue([]) // nada posteado aún
  mockPost.mockResolvedValue({ id: 'je1' })
})

/** Última póliza enviada a postJournalEntry. */
const lastEntry = () => mockPost.mock.calls[mockPost.mock.calls.length - 1][1]
const sum = (lines: { debitCents: number; creditCents: number }[], k: 'debitCents' | 'creditCents') => lines.reduce((s, l) => s + l[k], 0)
const acctOf = (lines: { ledgerAccountId: string; debitCents: number; creditCents: number }[], id: string) =>
  lines.find(l => l.ledgerAccountId === id)

it('sin RFC → needsFiscalSetup, no postea', async () => {
  mockScope.mockResolvedValue(null)
  const r = await generatePoliciesForVenue('v1')
  expect(r.needsFiscalSetup).toBe(true)
  expect(mockPost).not.toHaveBeenCalled()
})

it('falta un mapeo requerido → missingMappings, NO postea nada', async () => {
  mockMappings.mockResolvedValue(fullMappings(['IVA_OUTPUT']))
  p.payment.findMany.mockResolvedValue([pay({ amount: 100 })])
  const r = await generatePoliciesForVenue('v1')
  expect(r.missingMappings).toContain('IVA_OUTPUT')
  expect(r.posted).toBe(0)
  expect(mockPost).not.toHaveBeenCalled()
})

it('VENTA tarjeta (amount+tip+fee) → 5 líneas que CUADRAN al centavo', async () => {
  // amount 116, tip 20, fee 1.16 → bank=116+20-1.16=134.84(13484); fee 116; ventas 10000; iva 1600; tips 2000
  p.payment.findMany.mockResolvedValue([pay({ amount: 116, tipAmount: 20, feeAmount: 1.16, method: PaymentMethod.CREDIT_CARD })])
  const r = await generatePoliciesForVenue('v1')
  expect(r.posted).toBe(1)
  const e = lastEntry()
  expect(e.source).toBe('PAYMENT')
  expect(e.idempotencyKey).toBe('pay:pay1:v1')
  expect(sum(e.lines, 'debitCents')).toBe(sum(e.lines, 'creditCents')) // CUADRA
  expect(sum(e.lines, 'debitCents')).toBe(13600)
  expect(acctOf(e.lines, 'acc:BANK_RECEIPT')!.debitCents).toBe(13484)
  expect(acctOf(e.lines, 'acc:PROCESSOR_FEE')!.debitCents).toBe(116)
  expect(acctOf(e.lines, 'acc:SALES_REVENUE')!.creditCents).toBe(10000)
  expect(acctOf(e.lines, 'acc:IVA_OUTPUT')!.creditCents).toBe(1600)
  expect(acctOf(e.lines, 'acc:TIPS_PAYABLE')!.creditCents).toBe(2000)
})

it('VENTA efectivo → caja (G+T), sin línea de comisión, cuadra', async () => {
  p.payment.findMany.mockResolvedValue([pay({ amount: 100, tipAmount: 0, feeAmount: 5, method: PaymentMethod.CASH })])
  await generatePoliciesForVenue('v1')
  const e = lastEntry()
  expect(sum(e.lines, 'debitCents')).toBe(sum(e.lines, 'creditCents'))
  expect(acctOf(e.lines, 'acc:CASH_RECEIPT')!.debitCents).toBe(10000) // efectivo ignora la comisión
  expect(acctOf(e.lines, 'acc:PROCESSOR_FEE')).toBeUndefined()
  expect(acctOf(e.lines, 'acc:BANK_RECEIPT')).toBeUndefined()
})

it('DEVOLUCIÓN (type=REFUND, monto negativo) → 402.01, espejo invertido, cuadra', async () => {
  p.payment.findMany.mockResolvedValue([
    pay({ id: 'r1', amount: -116, tipAmount: 0, feeAmount: 0, type: PaymentType.REFUND, method: PaymentMethod.CREDIT_CARD }),
  ])
  const r = await generatePoliciesForVenue('v1')
  expect(r.posted).toBe(1)
  const e = lastEntry()
  expect(e.source).toBe('REFUND')
  expect(e.idempotencyKey).toBe('refund:r1:v1')
  expect(sum(e.lines, 'debitCents')).toBe(sum(e.lines, 'creditCents'))
  expect(acctOf(e.lines, 'acc:SALES_RETURN')!.debitCents).toBe(10000)
  expect(acctOf(e.lines, 'acc:IVA_OUTPUT')!.debitCents).toBe(1600)
  expect(acctOf(e.lines, 'acc:BANK_RECEIPT')!.creditCents).toBe(11600)
})

it('monto NEGATIVO sin type=REFUND también se enruta a devolución (no se cuenta como venta positiva)', async () => {
  p.payment.findMany.mockResolvedValue([pay({ id: 'v0', amount: -50, type: PaymentType.REGULAR, method: PaymentMethod.CASH })])
  await generatePoliciesForVenue('v1')
  const e = lastEntry()
  expect(e.source).toBe('REFUND')
  expect(acctOf(e.lines, 'acc:SALES_RETURN')).toBeDefined() // contra-revenue, NO 401.01
})

it('reglas de exclusión: TEST / ADJUSTMENT / CRYPTO / cero / orden cancelada → skipped, no postea', async () => {
  p.payment.findMany.mockResolvedValue([
    pay({ id: 'a', amount: 100, type: PaymentType.TEST }),
    pay({ id: 'b', amount: 100, type: PaymentType.ADJUSTMENT }),
    pay({ id: 'c', amount: 100, method: PaymentMethod.CRYPTOCURRENCY }),
    pay({ id: 'd', amount: 0, tipAmount: 0 }),
    pay({ id: 'e', amount: 100, order: { status: OrderStatus.CANCELLED, orderNumber: '9' } }),
  ])
  const r = await generatePoliciesForVenue('v1')
  expect(r.posted).toBe(0)
  expect(r.skipped).toBe(5)
  expect(mockPost).not.toHaveBeenCalled()
})

it('idempotencia: una clave ya posteada → alreadyPosted, NO re-postea', async () => {
  p.payment.findMany.mockResolvedValue([pay({ id: 'x', amount: 100 }), pay({ id: 'y', amount: 100 })])
  p.journalEntry.findMany.mockResolvedValue([{ idempotencyKey: 'pay:x:v1' }]) // x ya existe
  const r = await generatePoliciesForVenue('v1')
  expect(r.alreadyPosted).toBe(1)
  expect(r.posted).toBe(1) // solo y
  expect(mockPost).toHaveBeenCalledTimes(1)
  expect(lastEntry().idempotencyKey).toBe('pay:y:v1')
})

describe('alcance fiscal configurable', () => {
  it('EFECTIVO no se postea cuando includeCashInAccounting=false (default real)', async () => {
    p.fiscalEmisor.findFirst.mockResolvedValue({ includeCashInAccounting: false })
    p.payment.findMany.mockResolvedValue([pay({ amount: 100, method: PaymentMethod.CASH })])
    const r = await generatePoliciesForVenue('v1')
    expect(r.posted).toBe(0)
    expect(r.skipped).toBe(1)
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('EFECTIVO sí se postea cuando el venue optó (includeCashInAccounting=true)', async () => {
    p.fiscalEmisor.findFirst.mockResolvedValue({ includeCashInAccounting: true })
    p.payment.findMany.mockResolvedValue([pay({ amount: 100, method: PaymentMethod.CASH })])
    const r = await generatePoliciesForVenue('v1')
    expect(r.posted).toBe(1)
  })

  it('un MERCHANT con includeInAccounting=false queda fuera de las pólizas', async () => {
    p.payment.findMany.mockResolvedValue([
      pay({ id: 'in', amount: 100, method: PaymentMethod.CREDIT_CARD }),
      pay({
        id: 'out',
        amount: 100,
        method: PaymentMethod.CREDIT_CARD,
        merchantAccount: { fiscalConfig: { includeInAccounting: false } },
      }),
    ])
    const r = await generatePoliciesForVenue('v1')
    expect(r.posted).toBe(1) // solo 'in'
    expect(r.skipped).toBe(1) // 'out' excluido del libro
    expect(lastEntry().idempotencyKey).toBe('pay:in:v1')
  })
})
