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
import { cancelCryptoPayment } from '@/services/b4bit/b4bit.service'
import prisma from '@/utils/prismaClient'
import { socketManager } from '@/communication/sockets/managers/socketManager'
const db = prisma as any
const V = 'c000000000000000000000001'
const P = 'c000000000000000000000002'
const A = 'c000000000000000000000003'
const pending = () => ({
  id: P,
  venueId: V,
  status: 'PENDING',
  method: 'CRYPTOCURRENCY',
  processor: 'B4BIT',
  externalId: 'request-own',
  processorData: { operation: { phase: 'READY' }, keep: true },
})
const cancel = (over: Record<string, unknown> = {}) => (cancelCryptoPayment as any)({ venueId: V, paymentId: P, staffId: A, ...over })
beforeEach(() => {
  jest.clearAllMocks()
  db.$queryRaw.mockResolvedValue([{ id: P }])
  db.payment.findFirst.mockResolvedValue(pending())
  db.payment.findUnique.mockResolvedValue(pending())
  db.payment.updateMany.mockResolvedValue({ count: 1 })
  db.activityLog.create.mockResolvedValue({})
})
describe('cancelación cripto scope/CAS', () => {
  it.each([null, { ...pending(), method: 'CASH' }, { ...pending(), processor: 'OTHER' }])(
    'no cambia un pago ajeno o de otro método: %p',
    async row => {
      db.payment.findFirst.mockResolvedValue(row)
      await expect(cancel()).rejects.toThrow()
      expect(db.payment.updateMany).not.toHaveBeenCalled()
      expect(db.payment.update).not.toHaveBeenCalled()
    },
  )
  it('resuelve ambos ids juntos dentro del venue, sin atribuir requestId ajeno', async () => {
    await cancel({ requestId: 'request-own' })
    expect(db.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: P, externalId: 'request-own', venueId: V, method: 'CRYPTOCURRENCY', processor: 'B4BIT' } }),
    )
  })
  it('gana sólo PENDING y audita al actor real antes del socket', async () => {
    await cancel()
    expect(db.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: P, venueId: V, method: 'CRYPTOCURRENCY', processor: 'B4BIT', status: 'PENDING' },
        data: expect.objectContaining({
          status: 'FAILED',
          processorData: expect.objectContaining({ keep: true, operation: { phase: 'READY' }, cancelledByStaffId: A }),
        }),
      }),
    )
    expect(db.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ venueId: V, staffId: A, entityId: P }) }),
    )
    expect(socketManager.broadcastToVenue).toHaveBeenCalledTimes(1)
    expect(db.activityLog.create.mock.invocationCallOrder[0]).toBeLessThan(
      (socketManager.broadcastToVenue as jest.Mock).mock.invocationCallOrder[0],
    )
  })
  it('la confirmación concurrente gana y no se pisa ni emite cancelación', async () => {
    db.payment.findUnique.mockResolvedValue({ ...pending(), status: 'COMPLETED' })
    await expect(cancel()).rejects.toThrow()
    expect(db.payment.updateMany).not.toHaveBeenCalled()
    expect(db.activityLog.create).not.toHaveBeenCalled()
    expect(socketManager.broadcastToVenue).not.toHaveBeenCalled()
  })
  it('reintento cancelado es no-op sin otra auditoría/evento', async () => {
    db.payment.findUnique.mockResolvedValue({ ...pending(), status: 'FAILED', processorData: { cancelledBy: 'TPV_USER' } })
    await cancel()
    expect(db.payment.updateMany).not.toHaveBeenCalled()
    expect(db.activityLog.create).not.toHaveBeenCalled()
    expect(socketManager.broadcastToVenue).not.toHaveBeenCalled()
  })
})
