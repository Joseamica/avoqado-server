/**
 * Máquina de efectivo 1a · Codex r1 #15: un Cambio que devuelve efectivo con DOS cobros — uno del cajón y uno de la máquina — tomaba el
 * turno al devolver la primera parte y la gaveta (`FOR UPDATE`) al llegar a la de la máquina: turno → caja. La devolución directa de
 * otra venta de la máquina toma caja → turno. Las dos a la vez se esperaban en cruz y una tenía que reintentarse.
 *
 * Con alguna parte que saca billetes de una venta de la máquina, el Cambio bloquea la gaveta UNA vez, justo después de los cobros y
 * ANTES de la venta nueva y de la primera parte (que reclama el turno). Aquí se para la transacción en ese candado para ver el orden.
 */
jest.mock('@/services/mobile/order.mobile.service', () => ({
  executeExchangeInTransaction: jest.fn(),
  cancelOrderInTransaction: jest.fn(),
  publishCancelledOrder: jest.fn(),
}))
jest.mock('@/services/storeCredit/storeCreditTender', () => ({
  ...jest.requireActual('@/services/storeCredit/storeCreditTender'),
  storeCreditAvailable: () => false,
}))

import { Prisma } from '@prisma/client'
import * as exchangeSale from '@/services/exchanges/exchangeSale'
import * as accountingAt from '@/services/exchanges/exchangeAccountingAt'
import * as creditTender from '@/services/exchanges/exchangeCreditTender'
import * as refundService from '@/services/dashboard/refund.dashboard.service'
import * as cajon from '@/services/shared/cashDrawerPosting'
import * as paymentShiftClaim from '@/services/shared/paymentShiftClaim'
import * as precios from '@/services/mobile/precioQueVioElCliente'
import { prepareExchangeInTx } from '@/services/exchanges/exchangeTx'
import * as destinoDelReembolso from '@/services/shared/destinoDelReembolso'
import type { MoneyShape } from '@/services/exchanges/exchangeRules'

const FOLIO = 'AQ0000000000AB'
const money = (over: Partial<MoneyShape> = {}): MoneyShape => ({
  method: 'CASH',
  source: 'POS',
  externalSource: null,
  fundsFlow: 'CASH_DRAWER',
  tenderTypeId: null,
  tenderCountsAsCash: null,
  tenderSatFormaPago: null,
  tenderSystemKind: null,
  ...over,
})
const DE_LA_MAQUINA = money({ fundsFlow: 'EXTERNAL_RECORDED', tenderSatFormaPago: '01', tenderCountsAsCash: false, cashMachineRef: FOLIO })

const pago = (id: string, cents: number, m: MoneyShape) => ({
  id,
  createdAt: new Date('2026-11-20T17:00:00Z'),
  amountCents: cents,
  tipCents: 0,
  processorData: {},
  refunds: [],
  money: m,
  rootPaymentId: id,
  rootMoney: m,
})

let orden: string[]
const espias: jest.SpyInstance[] = []
const tx = {
  $queryRaw: jest.fn(async () => [{ n: 1 }]),
  giftCard: { findFirst: jest.fn(async () => null) },
  exchange: { findUnique: jest.fn(async () => null) },
  venue: {
    findUnique: jest.fn(async () => ({
      id: 'v1',
      name: 'Tienda',
      salesEnabled: true,
      type: 'CLOTHING',
      settings: { exchangesEnabled: true },
    })),
  },
  venueSettings: { findUnique: jest.fn(async () => ({ storeCreditOnly: false })) },
  staffVenue: { findFirst: jest.fn(async () => ({ staffId: 'staff-1' })), findMany: jest.fn(async () => []) },
  payment: { count: jest.fn(async () => 0), findFirst: jest.fn(async () => ({ orderId: 'order-1' })) },
  exchangeCreditLink: { count: jest.fn(async () => 0) },
  cashDrawerSession: { findFirst: jest.fn(async () => (orden.push('caja-sin-candado'), { id: 'caja-1' })) },
}

beforeEach(() => {
  orden = []
  espias.push(
    jest.spyOn(paymentShiftClaim, 'lockExistingOrderForPayment').mockResolvedValue(true as never),
    jest.spyOn(paymentShiftClaim, 'claimShiftForRefund').mockImplementation((async () => {
      orden.push('turno')
      throw new Error('NO_DEBE_RECLAMAR_EL_TURNO_ANTES_DE_LA_CAJA')
    }) as never),
    jest.spyOn(accountingAt, 'exchangeAccountingAt').mockResolvedValue(new Date('2026-11-20T18:00:00Z')),
    jest.spyOn(precios, 'resolverPreciosDeLineas').mockResolvedValue([{ unitPriceCents: 3000 }] as never),
    jest.spyOn(creditTender, 'ensureExchangeCreditTender').mockResolvedValue(undefined as never),
    jest.spyOn(creditTender, 'resolveExchangeCreditTenderInTx').mockResolvedValue({
      method: 'OTHER',
      fundsFlow: 'EXTERNAL_RECORDED',
      tenderTypeId: 'tt-ec',
      tenderRevision: 1,
      tenderLabel: 'Crédito de cambio',
      tenderCountsAsCash: false,
      tenderCaptureTip: false,
      tenderSatFormaPago: null,
    } as never),
    jest.spyOn(refundService, 'bloquearCobroParaReembolso').mockImplementation((async (_t: unknown, i: { paymentId: string }) => {
      orden.push(`cobro:${i.paymentId}`)
      return {
        original: { amount: i.paymentId === 'pay-cajon' ? 50 : 100, tipAmount: 0, processorData: {} },
        existingRefunds: [],
        unclassifiedPriorRefundCents: 0,
      }
    }) as never),
    jest.spyOn(cajon, 'cajaParaDevolverEnTx').mockImplementation((async () => {
      orden.push('caja')
      throw new Error('ALTO_EN_LA_CAJA')
    }) as never),
    jest.spyOn(exchangeSale, 'loadSaleForExchange').mockResolvedValue({
      order: { id: 'order-1', orderNumber: 'A-1', status: 'COMPLETED', paymentStatus: 'PAID', source: 'POS', type: 'COUNTER' },
      lines: [
        {
          id: 'item-1',
          productId: 'prod-viejo',
          productName: 'Pastel',
          quantity: 1,
          orderPromotionId: null,
          giftCardId: null,
          serialized: false,
          product: { type: 'REGULAR', soldByWeight: false, priceCents: 15000, deletedAt: null, productGroupId: null },
        },
      ],
      charged: { atribuible: true, motivo: null, renglones: [], cobradoCents: new Map([['item-1', 15000]]) },
      returnedByLine: new Map(),
      chainByPaymentId: new Map(),
      catalogProducts: new Map([
        [
          'prod-1',
          {
            id: 'prod-1',
            name: 'Galleta',
            deletedAt: null,
            active: true,
            type: 'REGULAR',
            soldByWeight: false,
            productGroupId: null,
            price: new Prisma.Decimal(30),
          },
        ],
      ]),
      // $50 del cajón y $100 de la máquina: devolver $120 en efectivo usa los dos.
      payments: [pago('pay-cajon', 5000, money()), pago('pay-maquina', 10000, DE_LA_MAQUINA)],
    } as never),
  )
})
afterEach(() => espias.splice(0).forEach(s => s.mockRestore()))

it('🔴 Codex r1 #15: con una parte de la máquina, la gaveta se bloquea UNA vez después de los cobros y ANTES del turno', async () => {
  await expect(
    prepareExchangeInTx(
      tx as never,
      {
        venueId: 'v1',
        actorStaffId: 'staff-1',
        requestHash: 'huella-1',
        originalOrderId: 'order-1',
        body: {
          idempotencyKey: 'llave-cambio-maquina',
          originalPaymentId: 'pay-maquina',
          returned: [{ orderItemId: 'item-1', quantity: 1, restock: true, reason: 'SIZE' }],
          taken: [{ productId: 'prod-1', quantity: 1 }],
          settlement: { kind: 'PAYOUT', method: 'CASH', expectedDifferenceCents: -12000, cashFromNonCash: true },
          staffId: 'staff-1',
          deviceId: 'caja-1',
          createdAtLocal: '2026-11-20T12:00:00-06:00',
        },
      } as never,
    ),
  ).rejects.toThrow('ALTO_EN_LA_CAJA')
  expect(orden).toEqual(['cobro:pay-cajon', 'cobro:pay-maquina', 'caja'])
  expect(tx.cashDrawerSession.findFirst).not.toHaveBeenCalled()
})

it('🔴 Codex r2 (familia B): el Cambio decide la gaveta con LA función de destino de cada parte que devuelve', async () => {
  const espia = jest.spyOn(destinoDelReembolso, 'decidirDestinoDelReembolso')
  await expect(
    prepareExchangeInTx(
      tx as never,
      {
        venueId: 'v1',
        actorStaffId: 'staff-1',
        requestHash: 'huella-1',
        originalOrderId: 'order-1',
        body: {
          idempotencyKey: 'llave-cambio-maquina',
          originalPaymentId: 'pay-maquina',
          returned: [{ orderItemId: 'item-1', quantity: 1, restock: true, reason: 'SIZE' }],
          taken: [{ productId: 'prod-1', quantity: 1 }],
          settlement: { kind: 'PAYOUT', method: 'CASH', expectedDifferenceCents: -12000, cashFromNonCash: true },
          staffId: 'staff-1',
          deviceId: 'caja-1',
          createdAtLocal: '2026-11-20T12:00:00-06:00',
        },
      } as never,
    ),
  ).rejects.toThrow('ALTO_EN_LA_CAJA')
  expect(espia).toHaveBeenCalledWith({ entrada: 'POS', origen: 'MAQUINA', medio: 'CASH', esCreditoDeCambio: false })
  espia.mockRestore()
})
