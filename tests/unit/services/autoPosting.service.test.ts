/**
 * Unit tests (mock-first) del motor de POSTEO AUTOMÁTICO de pólizas (slice 2).
 * Lock contable: cada póliza generada CUADRA (Σdebe==Σhaber), las cuentas correctas, idempotencia
 * (no re-postea), enrutado venta vs devolución por signo/type, reglas de exclusión, y falta-de-mapeo.
 */
import { PaymentMethod, PaymentType, OrderStatus, Prisma } from '@prisma/client'

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    payment: { findMany: jest.fn() },
    fiscalEmisor: { findFirst: jest.fn() },
    journalEntry: { findMany: jest.fn() },
    // Plan 4: aviso temprano de la pausa por IVA mixto (lectura sin candado de la marca).
    organization: { findUnique: jest.fn() },
  },
}))
jest.mock('../../../src/services/fiscal/chartOfAccounts.service', () => ({ resolveScopeOrNull: jest.fn() }))
jest.mock('../../../src/services/fiscal/accountMapping.service', () => ({ getMappings: jest.fn() }))
jest.mock('../../../src/services/fiscal/journalEntry.service', () => ({ postJournalEntry: jest.fn() }))
jest.mock('date-fns-tz', () => ({ formatInTimeZone: () => '2026-06-15' }))

import prisma from '../../../src/utils/prismaClient'
import logger from '../../../src/config/logger'
import { resolveScopeOrNull } from '../../../src/services/fiscal/chartOfAccounts.service'
import { getMappings } from '../../../src/services/fiscal/accountMapping.service'
import { postJournalEntry } from '../../../src/services/fiscal/journalEntry.service'
import { buildRefundLines, buildSaleLines, generatePoliciesForVenue } from '../../../src/services/fiscal/autoPosting.service'

const p = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  payment: { findMany: jest.Mock }
  fiscalEmisor: { findFirst: jest.Mock }
  journalEntry: { findMany: jest.Mock }
  organization: { findUnique: jest.Mock }
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
  p.organization.findUnique.mockResolvedValue({ ivaMixtoAlgunaVez: false })
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

  it('🔴 venta por TRANSFERENCIA devuelta en EFECTIVO (efectivo fuera de los libros): la devolución SÍ se postea', async () => {
    p.fiscalEmisor.findFirst.mockResolvedValue({ includeCashInAccounting: false })
    p.payment.findMany
      .mockResolvedValueOnce([pay({ id: 'r9', amount: -100, type: PaymentType.REFUND, method: PaymentMethod.CASH })])
      .mockResolvedValueOnce([{ id: 'r9', processorData: { originalMethod: 'BANK_TRANSFER' } }])
    const r = await generatePoliciesForVenue('v1')
    expect(r.posted).toBe(1)
  })

  it('🔴 venta en EFECTIVO devuelta por TRANSFERENCIA (efectivo fuera de los libros): la devolución se salta', async () => {
    p.fiscalEmisor.findFirst.mockResolvedValue({ includeCashInAccounting: false })
    p.payment.findMany
      .mockResolvedValueOnce([pay({ id: 'r8', amount: -100, type: PaymentType.REFUND, method: PaymentMethod.BANK_TRANSFER })])
      .mockResolvedValueOnce([{ id: 'r8', processorData: { originalMethod: 'CASH' } }])
    const r = await generatePoliciesForVenue('v1')
    expect(r.posted).toBe(0)
    expect(r.skipped).toBe(1)
    expect(mockPost).not.toHaveBeenCalled()
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

// IVA por producto, plan 4 (Ruling R9): con un producto ≠ 16 % la organización queda marcada y la contabilidad se
// pausa, así que las pruebas de integración de reparto por tasa ya no pueden leer la póliza. Su aritmética se movió
// AQUÍ, con los mismos importes, sobre los constructores puros de líneas:
//  - autoPostingRetiro.integration.test.ts → las cuatro pruebas del REFUND de reparto;
//  - lectoresConRetiro.test.ts → «estado de resultados: el IVA de la compensación es el que posteó la póliza».
describe('R9 · reparto por tasa (aritmética movida de las pruebas de integración de reparto)', () => {
  type Fila = Parameters<typeof buildSaleLines>[0]
  const acct = (m: string) => `acc:${m}`
  const renglon = (unitPrice: number, taxRate: number, discountAmount = 0) => ({
    quantity: 1,
    unitPrice: new Prisma.Decimal(unitPrice),
    discountAmount: new Prisma.Decimal(discountAmount),
    product: { taxRate: new Prisma.Decimal(taxRate) },
  })
  const fila = (o: Partial<Fila>): Fila => ({
    id: 'p1',
    amount: new Prisma.Decimal(0),
    tipAmount: new Prisma.Decimal(0),
    feeAmount: new Prisma.Decimal(0),
    method: PaymentMethod.OTHER,
    type: PaymentType.FAST,
    createdAt: new Date('2026-06-15T18:00:00Z'),
    merchantAccount: null,
    ecommerceMerchant: null,
    order: null,
    ...o,
  })
  const devolucion = (id: string, pesos: number, items: NonNullable<Fila['order']>['items'], propina = 0) =>
    fila({
      id,
      amount: new Prisma.Decimal(-pesos),
      tipAmount: new Prisma.Decimal(-propina),
      type: PaymentType.REFUND,
      order: { status: OrderStatus.COMPLETED, orderNumber: '1', items },
    })
  /** Pedido de $200: $100 gravado al 16 % + $100 al 0 % (autoPostingRetiro). */
  const mitadYMitad = [renglon(100, 0.16), renglon(100, 0)]
  const linea = (lines: { ledgerAccountId: string; debitCents: number; creditCents: number }[], m: string) =>
    lines.find(l => l.ledgerAccountId === acct(m))
  const cuadra = (lines: { debitCents: number; creditCents: number }[]) =>
    lines.reduce((s, l) => s + l.debitCents, 0) === lines.reduce((s, l) => s + l.creditCents, 0)
  const ivaNeto = (lines: { ledgerAccountId: string; debitCents: number; creditCents: number }[]) =>
    (linea(lines, 'IVA_OUTPUT')?.creditCents ?? 0) - (linea(lines, 'IVA_OUTPUT')?.debitCents ?? 0)

  it('REFUND con fiscalByRateCents: la póliza lleva ESE reparto (1379), no la mezcla de la orden (690)', () => {
    const fiscal = { '0.16': 1379 } // forma VIEJA, como la escribía el servidor antes del plan 4b
    const { lines } = buildRefundLines(devolucion('r1', 100, mitadYMitad), acct, {
      provenance: 'PROVIDER_ADJUSTMENT',
      fiscalByRateCents: fiscal,
    })!
    expect(cuadra(lines)).toBe(true)
    expect(linea(lines, 'IVA_OUTPUT')!.debitCents).toBe(1379)
    expect(linea(lines, 'SALES_RETURN')!.debitCents).toBe(8621)
  })

  it('plan 4b · REFUND con la forma nueva (v2, base e IVA por tratamiento): la póliza lleva ESE IVA (1379)', () => {
    const { lines } = buildRefundLines(devolucion('r5', 100, mitadYMitad), acct, {
      provenance: 'PROVIDER_ADJUSTMENT',
      fiscalByRateCents: { v: 2, porTratamiento: { IVA_16: { baseCents: 8621, ivaCents: 1379 } } },
    })!
    expect(cuadra(lines)).toBe(true)
    expect(linea(lines, 'IVA_OUTPUT')!.debitCents).toBe(1379)
    expect(linea(lines, 'SALES_RETURN')!.debitCents).toBe(8621)
  })

  it('REFUND sin fiscalByRateCents: como hoy, con la mezcla de la orden (IVA 690)', () => {
    const { lines } = buildRefundLines(devolucion('r2', 100, mitadYMitad), acct, undefined)!
    expect(cuadra(lines)).toBe(true)
    expect(linea(lines, 'IVA_OUTPUT')!.debitCents).toBe(690) // $100 → 50/50 → IVA de $50 al 16 %
    expect(linea(lines, 'SALES_RETURN')!.debitCents).toBe(9310)
  })

  it('ajuste del proveedor SIN fiscalByRateCents: como hoy (690) y grita 🚨 con el id', () => {
    const { lines } = buildRefundLines(devolucion('r3', 100, mitadYMitad), acct, { provenance: 'PROVIDER_ADJUSTMENT' })!
    expect(linea(lines, 'IVA_OUTPUT')!.debitCents).toBe(690)
    expect((logger.error as jest.Mock).mock.calls.some(([msg]) => String(msg).includes('🚨') && String(msg).includes('r3'))).toBe(true)
  })

  it('ajuste con IVA fuera de [0, venta] NUNCA queda sin póliza: 🚨 y mezcla de la orden, propina incluida', () => {
    // Composición que el reconciliador SÍ puede producir: la diferencia de IVA sale NEGATIVA ({'0.16': -689}).
    const { lines } = buildRefundLines(devolucion('r4', 100, mitadYMitad, 5), acct, {
      provenance: 'PROVIDER_ADJUSTMENT',
      fiscalByRateCents: { '0.16': -689 },
    })!
    expect(cuadra(lines)).toBe(true)
    expect(linea(lines, 'IVA_OUTPUT')!.debitCents).toBe(690) // mezcla de la orden
    expect(linea(lines, 'SALES_RETURN')!.debitCents).toBe(9310)
    expect(linea(lines, 'TIPS_PAYABLE')!.debitCents).toBe(500)
    expect((logger.error as jest.Mock).mock.calls.some(([msg]) => String(msg).includes('🚨') && String(msg).includes('r4'))).toBe(true)
  })

  it('lectoresConRetiro: el IVA neto de las cuatro pólizas es 4191 (la cifra que el estado de resultados debe igualar)', () => {
    // A · $200 (Latte $150 al 16 % + Pan $50 al 0 % con $5 de descuento, retirado por Uber) y su compensación de $50.
    const pedidoA = [renglon(150, 0.16), renglon(50, 0, 5)]
    const fiscalA = {} // retirar lo del 0 % no devuelve IVA (forma vieja)
    const ventaA = buildSaleLines(
      fila({ id: 'a', amount: new Prisma.Decimal(200), order: { status: OrderStatus.COMPLETED, orderNumber: 'A', items: pedidoA } }),
      acct,
    )!
    const retiroA = buildRefundLines(devolucion('a-r', 50, pedidoA), acct, {
      provenance: 'PROVIDER_ADJUSTMENT',
      fiscalByRateCents: fiscalA,
    })!
    // B · $200 sin renglones (16 % de siempre) y un reembolso MANUAL de $50.
    const ventaB = buildSaleLines(
      fila({ id: 'b', amount: new Prisma.Decimal(200), order: { status: OrderStatus.COMPLETED, orderNumber: 'B', items: [] } }),
      acct,
    )!
    const manualB = buildRefundLines(devolucion('b-r', 50, []), acct, undefined)!

    expect([ventaA, retiroA, ventaB, manualB].every(p => cuadra(p.lines))).toBe(true)
    expect([ventaA, retiroA, ventaB, manualB].map(p => ivaNeto(p.lines))).toEqual([2122, 0, 2759, -690])
    expect([ventaA, retiroA, ventaB, manualB].reduce((s, p) => s + ivaNeto(p.lines), 0)).toBe(4191)
  })
})
