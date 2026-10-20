/**
 * El detalle de un cobro que lee el POS para ofrecer «Devolver con»: un cobro con saldo NUNCA ofrece escoger (spec §5.5), y la app
 * nueva (1b) recibe `refundToGiftCardBalance` para decir «regresa al saldo de la tarjeta». Aditivo: nada se quita.
 */
import prisma from '@/utils/prismaClient'
import * as refundService from '@/services/dashboard/refund.dashboard.service'
import { getTransactionDetail } from '@/services/mobile/transaction.mobile.service'

jest.mock('@/services/dashboard/refund.dashboard.service', () => ({ listRefundsForPayment: jest.fn() }))

const prismaMock = prisma as any
const cobro = (over: Record<string, unknown> = {}) => ({
  id: 'pay_gc',
  amount: 200,
  tipAmount: 0,
  method: 'OTHER',
  source: 'POS',
  externalSource: null,
  tenderSatFormaPago: '01',
  fundsFlow: 'EXTERNAL_RECORDED',
  tenderTypeId: 'tender-gc',
  tenderCountsAsCash: false,
  tenderLabel: 'Tarjeta de regalo',
  status: 'COMPLETED',
  cardBrand: null,
  maskedPan: null,
  referenceNumber: null,
  authorizationNumber: null,
  createdAt: new Date('2026-10-14T18:00:00.000Z'),
  processorData: null,
  orderId: null,
  processedBy: null,
  order: null,
  tenderType: { systemKind: 'GIFT_CARD' },
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  ;(refundService.listRefundsForPayment as jest.Mock).mockResolvedValue([])
})

describe('getTransactionDetail · tarjeta de regalo', () => {
  it('🔴 un cobro con saldo no deja escoger efectivo ni transferencia y avisa que regresa al saldo', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(cobro())
    const detalle = await getTransactionDetail('venue_1', 'pay_gc')
    expect(detalle).toMatchObject({ canChooseRefundMethod: false, refundToGiftCardBalance: true })
  })

  it('regresión: un vale (tender propio) sí deja escoger y no es saldo de regalo', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(cobro({ tenderType: { systemKind: null }, tenderSatFormaPago: '99' }))
    const detalle = await getTransactionDetail('venue_1', 'pay_gc')
    expect(detalle).toMatchObject({ canChooseRefundMethod: true, refundToGiftCardBalance: false })
  })

  it('el select pide la marca del tender', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(cobro())
    await getTransactionDetail('venue_1', 'pay_gc')
    expect(prismaMock.payment.findFirst.mock.calls[0][0].select.tenderType).toEqual({ select: { systemKind: true } })
  })
})
