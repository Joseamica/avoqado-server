/**
 * Spec §7 (Codex r2 N4): el motor registraría la venta de una tarjeta como venta con entrada a banco, y un cobro con saldo como venta
 * con BANK_RECEIPT. En la fase 1 NINGUNO se postea: quedan «pendientes de revisión contable». La póliza correcta (pasivo) es la fase 2.
 */
import { OrderStatus, PaymentMethod, PaymentType } from '@prisma/client'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    payment: { findMany: jest.fn() },
    fiscalEmisor: { findFirst: jest.fn() },
    journalEntry: { findMany: jest.fn() },
    organization: { findUnique: jest.fn() },
  },
}))
jest.mock('../../../../src/services/fiscal/chartOfAccounts.service', () => ({ resolveScopeOrNull: jest.fn() }))
jest.mock('../../../../src/services/fiscal/accountMapping.service', () => ({ getMappings: jest.fn() }))
jest.mock('../../../../src/services/fiscal/journalEntry.service', () => ({ postJournalEntry: jest.fn() }))
jest.mock('date-fns-tz', () => ({ ...jest.requireActual('date-fns-tz'), formatInTimeZone: () => '2026-10-14' }))

import prisma from '../../../../src/utils/prismaClient'
import { resolveScopeOrNull } from '../../../../src/services/fiscal/chartOfAccounts.service'
import { getMappings } from '../../../../src/services/fiscal/accountMapping.service'
import { postJournalEntry } from '../../../../src/services/fiscal/journalEntry.service'
import { esPendienteDeRevisionContable, generatePoliciesForVenue } from '../../../../src/services/fiscal/autoPosting.service'
import { ordenParaIvaSelect } from '../../../../src/services/fiscal/ivaDeOrden'

const p = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  payment: { findMany: jest.Mock }
  fiscalEmisor: { findFirst: jest.Mock }
  journalEntry: { findMany: jest.Mock }
  organization: { findUnique: jest.Mock }
}
const MOVIMIENTOS = ['SALES_REVENUE', 'SALES_RETURN', 'IVA_OUTPUT', 'CASH_RECEIPT', 'BANK_RECEIPT', 'TIPS_PAYABLE', 'PROCESSOR_FEE']
const renglonDe16 = { id: 'i1', quantity: 1, unitPrice: 116, total: 116, discountAmount: 0, giftCardId: null, product: { taxRate: 0.16 } }
const renglonDeTarjeta = { id: 'i2', quantity: 1, unitPrice: 500, total: 500, discountAmount: 0, giftCardId: 'gc1', product: null }
const cobro = (o: Record<string, unknown>) => ({
  id: 'pay1',
  amount: 116,
  tipAmount: 0,
  feeAmount: 0,
  method: PaymentMethod.CREDIT_CARD,
  type: PaymentType.REGULAR,
  createdAt: new Date('2026-10-14T18:00:00Z'),
  merchantAccount: null,
  ecommerceMerchant: null,
  tenderType: null,
  order: { status: OrderStatus.COMPLETED, orderNumber: '1', items: [renglonDe16], orderDiscounts: [], serviceCharges: [] },
  ...o,
})

beforeEach(() => {
  jest.clearAllMocks()
  ;(resolveScopeOrNull as jest.Mock).mockResolvedValue({ organizationId: 'o1', rfc: 'RFC', venueType: 'RETAIL' })
  ;(getMappings as jest.Mock).mockResolvedValue({
    mappings: MOVIMIENTOS.map(m => ({ movementType: m, account: { id: `acc:${m}`, code: m } })),
  })
  p.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
  p.fiscalEmisor.findFirst.mockResolvedValue({ includeCashInAccounting: true })
  p.journalEntry.findMany.mockResolvedValue([])
  p.organization.findUnique.mockResolvedValue({ ivaMixtoAlgunaVez: false })
  ;(postJournalEntry as jest.Mock).mockResolvedValue({ id: 'je1' })
})

describe('generatePoliciesForVenue · tarjetas de regalo', () => {
  it('with cash excluded from accounting, a chain cash refund is excluded from autoposting like an ordinary cash refund', async () => {
    p.fiscalEmisor.findFirst.mockResolvedValue({ includeCashInAccounting: false })
    const refunds = [
      cobro({
        id: 'ordinary',
        amount: -116,
        method: PaymentMethod.CASH,
        type: PaymentType.REFUND,
        processorData: { originalPaymentId: 'cash', originalMethod: 'CASH' },
      }),
      cobro({
        id: 'chain',
        amount: -116,
        method: PaymentMethod.CASH,
        type: PaymentType.REFUND,
        processorData: {
          originalPaymentId: 'credit',
          rootPaymentId: 'cash',
          originalMethod: 'CASH',
          exchange: { exchangeId: 'exchange', role: 'CHAIN', rootPaymentId: 'cash' },
        },
      }),
    ]
    p.payment.findMany.mockResolvedValueOnce(refunds).mockResolvedValueOnce(refunds)
    expect(await generatePoliciesForVenue('v1')).toMatchObject({ candidates: 2, posted: 0, skipped: 2, pendientesDeRevision: 0 })
    expect(postJournalEntry).not.toHaveBeenCalled()
  })

  it('🔴 la VENTA de una tarjeta (cobro con tarjeta de una cuenta de tarjetas) no se postea: queda pendiente de revisión', async () => {
    p.payment.findMany.mockResolvedValueOnce([
      cobro({ id: 'p-venta', amount: 500, order: { status: OrderStatus.COMPLETED, orderNumber: 'GC', items: [renglonDeTarjeta] } }),
    ])
    const r = await generatePoliciesForVenue('v1')
    expect(r).toMatchObject({ candidates: 1, posted: 0, pendientesDeRevision: 1 })
    expect(postJournalEntry).not.toHaveBeenCalled()
  })

  it('🔴 el cobro CON SALDO (tender de sistema) tampoco se postea, aunque su cuenta sea de mercancía', async () => {
    p.payment.findMany.mockResolvedValueOnce([
      cobro({ id: 'p-saldo', method: PaymentMethod.OTHER, tenderType: { systemKind: 'GIFT_CARD' } }),
    ])
    const r = await generatePoliciesForVenue('v1')
    expect(r).toMatchObject({ posted: 0, pendientesDeRevision: 1 })
    expect(postJournalEntry).not.toHaveBeenCalled()
  })

  it('🔴 el REFUND de un cobro con saldo (hereda el tender) tampoco', async () => {
    p.payment.findMany
      .mockResolvedValueOnce([
        cobro({
          id: 'r-saldo',
          amount: -116,
          type: PaymentType.REFUND,
          method: PaymentMethod.OTHER,
          tenderType: { systemKind: 'GIFT_CARD' },
        }),
      ])
      .mockResolvedValue([])
    const r = await generatePoliciesForVenue('v1')
    expect(r).toMatchObject({ posted: 0, pendientesDeRevision: 1 })
  })

  it('regresión: una venta normal con tarjeta se postea igual y no hay pendientes', async () => {
    p.payment.findMany.mockResolvedValueOnce([cobro({})])
    const r = await generatePoliciesForVenue('v1')
    expect(r).toMatchObject({ posted: 1, pendientesDeRevision: 0 })
    expect(postJournalEntry).toHaveBeenCalledTimes(1)
  })

  it('el select pide la marca del tender y la de cada renglón', async () => {
    p.payment.findMany.mockResolvedValueOnce([])
    await generatePoliciesForVenue('v1')
    const select = p.payment.findMany.mock.calls[0][0].select
    expect(select.tenderType).toEqual({ select: { systemKind: true } })
    expect(select.order.select.items.select.giftCardId).toBe(true)
    // B4 r1 (fix 5): los MISMOS renglones que la póliza (mismo tope y mismo orden) y, además de la marca, los mismos campos.
    expect(select.order.select.items.take).toBe(ordenParaIvaSelect.items.take)
    expect(select.order.select.items.orderBy).toEqual(ordenParaIvaSelect.items.orderBy)
    expect(select.order.select.items.select).toEqual({ ...ordenParaIvaSelect.items.select, giftCardId: true })
  })

  it('B4 r1 (fix 5) · la venta de una tarjeta en EFECTIVO fuera de los libros (sin opt-in del efectivo) cuenta como pendiente, no como omitida', async () => {
    p.fiscalEmisor.findFirst.mockResolvedValue({ includeCashInAccounting: false })
    p.payment.findMany.mockResolvedValueOnce([
      cobro({
        id: 'p-venta-efectivo',
        amount: 500,
        method: PaymentMethod.CASH,
        order: { status: OrderStatus.COMPLETED, orderNumber: 'GC', items: [renglonDeTarjeta] },
      }),
    ])
    const r = await generatePoliciesForVenue('v1')
    // Mismo criterio que el listado del contador (que no filtra por alcance): lo que el motor salta por tarjetas, se cuenta ahí.
    expect(r).toMatchObject({ candidates: 1, posted: 0, skipped: 0, pendientesDeRevision: 1 })
    expect(postJournalEntry).not.toHaveBeenCalled()
  })
})

describe('esPendienteDeRevisionContable', () => {
  it.each([
    ['cobro con saldo', { tenderType: { systemKind: 'GIFT_CARD' }, order: { items: [renglonDe16] } }, true],
    ['venta de tarjetas', { tenderType: null, order: { items: [renglonDeTarjeta] } }, true],
    ['venta normal', { tenderType: null, order: { items: [renglonDe16] } }, false],
    ['tender propio (vale)', { tenderType: { systemKind: null }, order: { items: [renglonDe16] } }, false],
    ['sin orden ni tender (fila vieja)', {}, false],
  ])('%s', (_n, fila, esperado) => {
    expect(esPendienteDeRevisionContable(fila)).toBe(esperado)
  })
})
