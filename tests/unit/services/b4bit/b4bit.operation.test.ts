jest.mock('@/services/mobile/areaTicketV7.mobile.service', () => ({
  lockAreaTicketCheckoutHierarchy: jest.fn().mockResolvedValue(null),
  cerrarSesionDeValesAlCerrarLaVenta: jest.fn().mockResolvedValue(false),
}))
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueuePaymentCommissionInTx: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/utils/prismaClient', () => {
  const client: any = {
    payment: {
      findUniqueOrThrow: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
    },
    order: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    // `findFirst`: el claim del turno pregunta si la orden es una cuenta de tarjetas de regalo (aquí, mercancía).
    orderItem: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    venue: { findUnique: jest.fn() },
    venueCryptoConfig: { findUnique: jest.fn() },
    venueSettings: { findUnique: jest.fn() },
    shift: { findFirst: jest.fn(), updateMany: jest.fn() },
    activityLog: { create: jest.fn() },
    terminal: { findFirst: jest.fn() },
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  }
  client.$transaction.mockImplementation((cb: any) => cb(client))
  return { __esModule: true, default: client }
})

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  socketManager: { broadcastToVenue: jest.fn() },
}))

jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({
  generateDigitalReceipt: jest.fn().mockResolvedValue({ accessKey: 'receipt-test' }),
  generateReceiptUrl: jest.fn().mockReturnValue('https://receipt.test/abc'),
}))

jest.mock('@/services/venueSalesGuard', () => ({
  assertVenueSalesEnabled: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/services/online-ordering/card/guards', () => ({
  assertNotCardOnlineOrderInTx: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  createSalePostingInTx: jest.fn().mockResolvedValue(null),
  applySalePosting: jest.fn().mockResolvedValue(null),
}))

jest.mock('@/services/referrals/referralQualification.service', () => ({
  onOrderPaid: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/services/access/access.service', () => ({
  getUserAccess: jest.fn().mockResolvedValue({}),
  hasPermission: jest.fn().mockReturnValue(true),
}))
import { initiateCryptoPayment, getCryptoOperationForVenue } from '@/services/b4bit/b4bit.service'
import { getUserAccess, hasPermission } from '@/services/access/access.service'
import { assertNotCardOnlineOrderInTx } from '@/services/online-ordering/card/guards'
import prisma from '@/utils/prismaClient'
const db = prisma as any
const V = 'c000000000000000000000001',
  A = 'c000000000000000000000003',
  K = 'c000000000000000000000004'
const params = (over: Record<string, unknown> = {}) => ({
  venueId: V,
  orgId: 'org',
  staffId: 'declared',
  actorStaffId: A,
  terminalSerialNumber: 'AVQD-auth',
  idempotencyKey: K,
  amount: 5000,
  ...over,
})
let row: any
const provider = jest.fn()
const initiate = (over: Record<string, unknown> = {}) => initiateCryptoPayment(params(over) as any)
beforeEach(() => {
  jest.clearAllMocks()
  row = null
  ;(hasPermission as jest.Mock).mockReturnValue(true)
  ;(getUserAccess as jest.Mock).mockResolvedValue({})
  db.$queryRaw.mockResolvedValue([{ id: K }])
  db.payment.findUnique.mockImplementation(async ({ where }: any) =>
    row && (where.venueId_idempotencyKey?.venueId ?? where.venueId) === row.venueId ? { ...row } : null,
  )
  db.payment.findUniqueOrThrow.mockImplementation(async () => ({ ...row }))
  db.payment.findFirst.mockImplementation(async ({ where }: any) => (row && where.venueId === row.venueId ? { ...row } : null))
  db.terminal.findFirst.mockResolvedValue({ id: 'terminal-own' })
  db.shift.findFirst.mockResolvedValue(null)
  db.venueCryptoConfig.findUnique.mockResolvedValue({ status: 'ACTIVE', b4bitDeviceId: 'stub-device' })
  db.order.create.mockResolvedValue({ id: 'order-own', orderNumber: 'test' })
  db.payment.create.mockImplementation(async ({ data }: any) => (row = { id: 'legacy-generated', ...data }))
  db.payment.update.mockImplementation(async ({ data }: any) => (row = { ...row, ...data }))
  db.payment.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (
      (where.status && where.status !== row.status) ||
      (!where.processorData?.path && where.processorData?.equals && where.processorData.equals !== row.processorData) ||
      (where.processorData?.path && row.processorData?.cryptoOperation?.phase !== where.processorData.equals)
    )
      return { count: 0 }
    row = { ...row, ...data }
    return { count: 1 }
  })
  provider.mockImplementation(async (_url: string, options: any) =>
    options.method === 'POST'
      ? {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          text: async () => JSON.stringify({ identifier: 'request-own', web_url: 'https://pay.test/own' }),
        }
      : { json: async () => ({ status: 'PE' }) },
  )
  global.fetch = provider as any
})
describe('crypto operation correlation', () => {
  it('persists K as PK + key, actor/session terminal, contract before exactly one POST; replay after PIN returns same operation', async () => {
    const first = await initiate()
    const replay = await initiate({ actorStaffId: 'another-authorized', staffId: 'another-declared' })
    expect(first.paymentId).toBe(K)
    expect(replay.paymentId).toBe(K)
    expect(db.order.create).toHaveBeenCalledTimes(1)
    expect(db.payment.create).toHaveBeenCalledTimes(1)
    expect(row).toMatchObject({
      id: K,
      idempotencyKey: K,
      processedById: A,
      terminalId: 'terminal-own',
      processorData: { cryptoOperation: { phase: 'READY', terminalSerial: 'AVQD-auth' } },
    })
    expect(provider.mock.calls.filter(c => c[1].method === 'POST')).toHaveLength(1)
    expect(first).toMatchObject({ operation: { financialStatus: 'PENDING', emissionStatus: 'READY' } })
  })
  it('provider sees durable SENDING before network; timeout never retries or claims negative', async () => {
    provider.mockImplementation(async () => {
      expect(row.processorData.cryptoOperation.phase).toBe('SENDING')
      throw Error('lost response')
    })
    const first = await initiate()
    const replay = await initiate()
    expect(provider).toHaveBeenCalledTimes(1)
    expect(first).toMatchObject({
      requestId: null,
      paymentUrl: null,
      operation: { emissionStatus: 'SENDING', requiresReview: true, financialStatus: 'PENDING' },
    })
    expect(replay).toMatchObject({ operation: { requiresReview: true } })
    expect(row.status).toBe('PENDING')
  })
  it.each([{ amount: 6000 }, { terminalSerialNumber: 'AVQD-other' }, { orderId: 'c000000000000000000000009' }])(
    'same key contradictory contract rejects %p',
    async over => {
      await initiate()
      await expect(initiate(over)).rejects.toMatchObject({ statusCode: 409 })
      expect(provider.mock.calls.filter(c => c[1].method === 'POST')).toHaveLength(1)
    },
  )
  it('own legacy/other-method collision rejects before provider', async () => {
    row = { id: K, venueId: V, idempotencyKey: K, method: 'CASH', processor: null, processorData: {} }
    await expect(initiate()).rejects.toMatchObject({ statusCode: 409 })
    expect(provider).not.toHaveBeenCalled()
  })
  it.each([K, undefined])('new crypto emission keeps the online-card guard with key %s, before any write or provider call', async key => {
    const orderId = 'c000000000000000000000009'
    db.order.findUnique.mockResolvedValueOnce({ id: orderId, status: 'CONFIRMED', paymentStatus: 'PENDING', thirdPartyCashDue: null })
    ;(assertNotCardOnlineOrderInTx as jest.Mock).mockRejectedValueOnce(Error('Cuenta con tarjeta en línea'))
    await expect(initiate({ orderId, idempotencyKey: key })).rejects.toThrow('Cuenta con tarjeta en línea')
    expect(assertNotCardOnlineOrderInTx).toHaveBeenCalledWith(db, { venueId: V, orderId })
    expect(db.order.create).not.toHaveBeenCalled()
    expect(db.payment.create).not.toHaveBeenCalled()
    expect(provider).not.toHaveBeenCalled()
  })
  it('P2002 in payment create propagates outside tx as generic conflict with no provider', async () => {
    db.payment.create.mockRejectedValueOnce({ code: 'P2002' })
    await expect(initiate()).rejects.toMatchObject({ statusCode: 409 })
    expect(db.order.create).toHaveBeenCalledTimes(1)
    expect(provider).not.toHaveBeenCalled()
  })
  it.each([{ actorStaffId: undefined }, { terminalSerialNumber: undefined }, { idempotencyKey: 'not-cuid' }])(
    'new contract requires auth/valid key %p',
    async over => {
      await expect(initiate(over)).rejects.toThrow()
      expect(provider).not.toHaveBeenCalled()
    },
  )
  it('current authority denial is permanent but infrastructure remains retryable', async () => {
    ;(getUserAccess as jest.Mock).mockRejectedValueOnce(Error(`User ${A} has no access to venue ${V}`))
    await expect(initiate()).rejects.toMatchObject({ statusCode: 403 })
    ;(getUserAccess as jest.Mock).mockRejectedValueOnce(Error('database down'))
    await expect(initiate()).rejects.toThrow('database down')
    expect(provider).not.toHaveBeenCalled()
  })
  it('exact recovery separates positive provider evidence from locally FAILED/PENDING money and strips internals', async () => {
    await initiate()
    row.status = 'FAILED'
    row.processorData.cancelledBy = 'TPV_USER'
    row.processorData.secret = 'never expose'
    provider.mockResolvedValue({ json: async () => ({ status: 'CO', tx_hash: 'evidence' }) })
    const result = await getCryptoOperationForVenue(V, K, 'AVQD-auth', A)
    expect(result).toMatchObject({
      operation: { financialStatus: 'FAILED', providerStatus: 'CO', requiresReview: true, reviewOwner: 'VENUE_MANAGER' },
    })
    expect(JSON.stringify(result)).not.toMatch(/stub-device|secret|fingerprint|declaredStaffId/)
    expect(row.status).toBe('FAILED')
    await expect(getCryptoOperationForVenue(V, K, 'AVQD-other', A)).rejects.toThrow()
  })
  it('unknown provider fields cannot escape in the safe projection', async () => {
    await initiate()
    provider.mockResolvedValue({ json: async () => ({ status: { secret: 'untrusted-provider-field' } }) })
    const result = await getCryptoOperationForVenue(V, K, 'AVQD-auth', A)
    expect(result.operation.providerStatus).toBeNull()
    expect(JSON.stringify(result)).not.toContain('untrusted-provider-field')
  })
  it('an invalid durable phase never looks resolved or permits emission', async () => {
    await initiate()
    row.processorData.cryptoOperation.phase = 'INVALID'
    await expect(getCryptoOperationForVenue(V, K, 'AVQD-auth', A)).rejects.toMatchObject({ statusCode: 409 })
    await expect(initiate()).rejects.toMatchObject({ statusCode: 409 })
  })
})
