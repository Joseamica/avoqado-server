// tests/unit/services/online-ordering/schema.test.ts
import { OnlineOrderPaymentMode, OnlineOrderRejectReason, OnlineOrderStatus } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'

describe('esquema de pedidos en línea', () => {
  it('expone los estados de la v1 (los de la fase 2 se agregan después: es aditivo)', () => {
    expect(Object.values(OnlineOrderStatus).sort()).toEqual([
      'ACCEPTED',
      'CANCELLED_BY_CUSTOMER',
      'CANCELLED_BY_STAFF',
      'COMPLETED',
      'EXPIRED',
      'PENDING_ACCEPTANCE',
      'READY',
      'REJECTED',
    ])
  })

  it('sólo pagar al recoger, y los motivos de rechazo', () => {
    expect(Object.values(OnlineOrderPaymentMode)).toEqual(['PAY_AT_PICKUP'])
    expect(Object.values(OnlineOrderRejectReason).sort()).toEqual(['CLOSED', 'OTHER', 'OUT_OF_ITEMS', 'TOO_BUSY'])
  })

  it('el mock global de Prisma conoce los modelos nuevos (R21: es una lista fija)', () => {
    expect(prismaMock.onlineOrderingSettings.findUnique).toEqual(expect.any(Function))
    expect(prismaMock.onlineOrder.updateMany).toEqual(expect.any(Function))
  })
})
