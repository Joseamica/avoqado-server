import { chainRefundSemanticsInTx } from '@/services/exchanges/exchangeTx'
import { prismaMock } from '../../../__helpers__/setup'

const root = {
  id: 'root',
  method: 'CASH',
  source: 'POS',
  fundsFlow: 'CASH_DRAWER',
  merchantAccountId: null,
  ecommerceMerchantId: null,
  tenderTypeId: null,
  tenderRevision: null,
  tenderLabel: null,
  tenderCountsAsCash: null,
  tenderCaptureTip: null,
  tenderSatFormaPago: null,
  tenderType: null,
}
beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.exchangeCreditLink.findFirst.mockResolvedValue({ exchangeId: 'exchange', originPaymentId: 'root' } as never)
})
describe('chainRefundSemanticsInTx', () => {
  it('inherits the frozen custom tender fields and derives legacy drawer flow without its commission', async () => {
    const snapshot = {
      method: 'OTHER',
      fundsFlow: null,
      tenderTypeId: 'voucher',
      tenderRevision: 2,
      tenderLabel: 'Vale',
      tenderCountsAsCash: true,
      tenderCaptureTip: false,
      tenderSatFormaPago: '99',
    }
    prismaMock.payment.findFirst.mockResolvedValue({
      ...root,
      ...snapshot,
      tenderCommissionPercent: 30,
      tenderType: { systemKind: null },
    } as never)
    const result = await chainRefundSemanticsInTx(prismaMock, 'venue', 'credit')
    expect(result).toEqual({
      kind: 'INHERIT',
      rootPaymentId: 'root',
      exchangeId: 'exchange',
      money: { ...snapshot, fundsFlow: 'CASH_DRAWER', merchantAccountId: null, source: 'POS' },
    })
  })

  it.each([{ merchantAccountId: 'merchant' }, { ecommerceMerchantId: 'ecommerce' }, { fundsFlow: 'AVOQADO_PROCESSED' }])(
    'blocks a processor root %o',
    async changes => {
      prismaMock.payment.findFirst.mockResolvedValue({ ...root, ...changes } as never)
      const result = await chainRefundSemanticsInTx(prismaMock, 'venue', 'credit')
      expect(result).toMatchObject({
        kind: 'BLOCKED',
        error: { code: 'EXCHANGE_CHAIN_NEEDS_TERMINAL', statusCode: 422, details: { reason: 'PROCESSOR_ROOT' } },
      })
      expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    },
  )
  it('inherits legacy cash through the canonical tender semantics without locking', async () => {
    prismaMock.payment.findFirst.mockResolvedValue({ ...root, fundsFlow: null } as never)
    expect(await chainRefundSemanticsInTx(prismaMock, 'venue', 'credit')).toMatchObject({
      kind: 'INHERIT',
      rootPaymentId: 'root',
      exchangeId: 'exchange',
      money: { method: 'CASH', fundsFlow: 'CASH_DRAWER', merchantAccountId: null },
    })
    expect(prismaMock.exchangeCreditLink.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'venue', creditPaymentId: 'credit' } }),
    )
    expect(prismaMock.payment.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: 'venue', id: 'root' } }))
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })
})
