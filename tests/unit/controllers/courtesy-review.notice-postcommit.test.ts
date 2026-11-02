/** Controller real con dominio financiero controlado: verifica avisos postcommit, no una transacción Postgres. */
import cuid = require('cuid')
import { reviewPendingCourtesy } from '@/controllers/mobile/order.mobile.controller'
import { prismaMock } from '../../__helpers__/setup'
import { ids, internalOriginal, internalSnapshot, appliedReply } from '../../__helpers__/courtesyReview.adapter.fixture'
import logger from '@/config/logger'

const mockReview = jest.fn(),
  mockNotify = jest.fn()
jest.mock('@/services/mobile/cortesia-pendiente.mobile.service', () => ({
  ...jest.requireActual('@/services/mobile/cortesia-pendiente.mobile.service'),
  revisarCortesiaPendiente: (...a: unknown[]) => mockReview(...a),
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: (...a: unknown[]) => mockNotify(...a),
}))

const customerId = cuid(),
  discountId = cuid(),
  rewardId = cuid(),
  transactionId = cuid()
const ownAudit = {
  id: cuid(),
  venueId: ids.venue,
  entity: 'OrderItem',
  entityId: ids.line,
  action: 'ORDER_ITEM_COMPED',
  data: {
    orderId: ids.order,
    originalPaymentKey: ids.key,
    discountBenefits: [
      {
        orderDiscountId: discountId,
        loyaltyRefund: { pointsRefunded: 1000, customerId, transactionId },
        stampRefund: { rewardId, customerId, rewardLabel: 'Premio sintético' },
      },
    ],
  },
}
function invocation() {
  const req = { params: { venueId: ids.venue }, authContext: { userId: ids.actor, isImpersonating: false } }
  const res: any = { locals: { courtesyReviewInput: { ...internalOriginal, confirm: true, expected: internalSnapshot } } }
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  const next = jest.fn()
  return { req, res, next, run: () => reviewPendingCourtesy(req as any, res, next) }
}
const flushNotices = () => new Promise<void>(resolve => setImmediate(resolve))

beforeEach(() => {
  jest.clearAllMocks()
  mockNotify.mockResolvedValue({ notified: 1 })
  // Dos beneficios para el MISMO cliente: un único aviso, conservando ambos refunds financieros.
  prismaMock.activityLog.findMany.mockResolvedValue([ownAudit] as any)
})

it('sólo después del commit lee refs de esta cuenta/K/líneas con sentinel101 y avisa una vez por cliente', async () => {
  let resolve!: (reply: ReturnType<typeof appliedReply>) => void
  let committed = false
  const financial = new Promise<ReturnType<typeof appliedReply>>(done => {
    resolve = done
  })
  mockReview.mockReturnValue(financial)
  prismaMock.activityLog.findMany.mockImplementation(async () => {
    expect(committed).toBe(true)
    return [ownAudit] as any
  })
  const f = invocation(),
    response = f.run()
  expect(prismaMock.activityLog.findMany).not.toHaveBeenCalled()
  expect(mockNotify).not.toHaveBeenCalled()
  committed = true
  resolve(appliedReply())
  await response
  await flushNotices()
  expect(f.next).not.toHaveBeenCalled()
  expect(f.res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: expect.objectContaining({ outcome: 'APPLIED' }) }))
  expect(prismaMock.activityLog.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        venueId: ids.venue,
        action: 'ORDER_ITEM_COMPED',
        entity: 'OrderItem',
        entityId: { in: [ids.line] },
        AND: expect.arrayContaining([
          { data: { path: ['orderId'], equals: ids.order } },
          { data: { path: ['originalPaymentKey'], equals: ids.key } },
        ]),
      }),
      take: 101,
    }),
  )
  expect(mockNotify).toHaveBeenCalledTimes(1)
  expect(mockNotify).toHaveBeenCalledWith(ids.venue, customerId)
  expect(prismaMock.payment.create).not.toHaveBeenCalled()
  expect(prismaMock.orderItem.update).not.toHaveBeenCalled()
})

it('fallo financiero/rollback no lee referencias ni emite aviso ni respuesta de éxito', async () => {
  const fault = new Error('owned-financial-rollback')
  mockReview.mockRejectedValue(fault)
  const f = invocation()
  await f.run()
  await flushNotices()
  expect(f.next).toHaveBeenCalledWith(fault)
  expect(f.res.json).not.toHaveBeenCalled()
  expect(prismaMock.activityLog.findMany).not.toHaveBeenCalled()
  expect(mockNotify).not.toHaveBeenCalled()
})

it('retry ALREADY_APPLIED recupera refs durables; un fallo de push observable conserva la respuesta financiera sin otro refund', async () => {
  mockReview.mockResolvedValue({ ...appliedReply(), outcome: 'ALREADY_APPLIED' })
  mockNotify.mockResolvedValue({ notified: 0, failed: true })
  const f = invocation()
  await f.run()
  await flushNotices()
  expect(mockNotify).toHaveBeenCalledTimes(1)
  expect(mockNotify).toHaveBeenCalledWith(ids.venue, customerId)
  expect(f.next).not.toHaveBeenCalled()
  expect(f.res.json).toHaveBeenCalledWith(
    expect.objectContaining({ success: true, data: expect.objectContaining({ outcome: 'ALREADY_APPLIED' }) }),
  )
  expect((logger.warn as jest.Mock).mock.calls.length + (logger.error as jest.Mock).mock.calls.length).toBeGreaterThan(0)
  expect(prismaMock.loyaltyTransaction.create).not.toHaveBeenCalled()
  expect(prismaMock.stampReward.update).not.toHaveBeenCalled()
})

it('un aviso wallet lento no retrasa la respuesta financiera ni bloquea el POS', async () => {
  let release: ((value: { notified: number }) => void) | undefined
  mockReview.mockResolvedValue(appliedReply())
  mockNotify.mockImplementation(
    () =>
      new Promise(done => {
        release = done
      }),
  )
  const f = invocation()
  let replied = false
  const response = f.run().then(() => {
    replied = true
  })
  try {
    await flushNotices()
    expect(mockNotify).toHaveBeenCalledTimes(1)
    expect(replied).toBe(true)
    expect(f.next).not.toHaveBeenCalled()
    expect(f.res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }))
  } finally {
    release?.({ notified: 1 })
    await response
    await flushNotices()
  }
})

function auditWithCustomers(customers: string[], twoPerBenefit = false) {
  return {
    ...ownAudit,
    data: {
      ...ownAudit.data,
      discountBenefits: customers.map(id => ({
        orderDiscountId: cuid(),
        stampRefund: { rewardId: cuid(), customerId: id, rewardLabel: 'Premio sintético' },
        ...(twoPerBenefit ? { loyaltyRefund: { pointsRefunded: 1, transactionId: cuid(), customerId: cuid() } } : {}),
      })),
    },
  }
}

it('frontera100: avisa a todos los100 clientes sin truncar y conserva el éxito financiero', async () => {
  const customers = Array.from({ length: 100 }, () => cuid())
  prismaMock.activityLog.findMany.mockResolvedValue([auditWithCustomers(customers)] as any)
  mockReview.mockResolvedValue(appliedReply())
  const f = invocation()
  await f.run()
  await flushNotices()
  expect(mockNotify).toHaveBeenCalledTimes(100)
  for (const id of customers) expect(mockNotify).toHaveBeenCalledWith(ids.venue, id)
  expect(f.res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }))
  expect(f.next).not.toHaveBeenCalled()
  expect(logger.warn).not.toHaveBeenCalled()
})

it.each([
  ['101 referencias del mismo cliente en un audit', () => [auditWithCustomers(Array(101).fill(customerId))]],
  [
    '120 referencias repartidas entre dos audits',
    () => [auditWithCustomers(Array.from({ length: 60 }, () => cuid())), auditWithCustomers(Array.from({ length: 60 }, () => cuid()))],
  ],
] as const)('%s: omite todo el aviso y deja visible el límite, sin cambiar la respuesta financiera', async (_name, audits) => {
  prismaMock.activityLog.findMany.mockResolvedValue(audits() as any)
  mockReview.mockResolvedValue(appliedReply())
  const f = invocation()
  await f.run()
  await flushNotices()
  expect(mockNotify).not.toHaveBeenCalled()
  expect(logger.warn).toHaveBeenCalledWith(
    'COURTESY_BENEFIT_NOTICE_LIMIT',
    expect.objectContaining({
      venueId: ids.venue,
      orderId: ids.order,
      kind: 'references',
    }),
  )
  expect(f.next).not.toHaveBeenCalled()
  expect(f.res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }))
  expect(prismaMock.loyaltyTransaction.create).not.toHaveBeenCalled()
  expect(prismaMock.stampReward.update).not.toHaveBeenCalled()
})

it('51 referencias con102 clientes distintos limitan el fanout completo antes del primer push', async () => {
  prismaMock.activityLog.findMany.mockResolvedValue([
    auditWithCustomers(
      Array.from({ length: 51 }, () => cuid()),
      true,
    ),
  ] as any)
  mockReview.mockResolvedValue(appliedReply())
  const f = invocation()
  await f.run()
  await flushNotices()
  expect(mockNotify).not.toHaveBeenCalled()
  expect(logger.warn).toHaveBeenCalledWith(
    'COURTESY_BENEFIT_NOTICE_LIMIT',
    expect.objectContaining({
      venueId: ids.venue,
      orderId: ids.order,
      kind: 'customers',
    }),
  )
  expect(f.next).not.toHaveBeenCalled()
  expect(f.res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }))
  expect(prismaMock.loyaltyTransaction.create).not.toHaveBeenCalled()
  expect(prismaMock.stampReward.update).not.toHaveBeenCalled()
})
