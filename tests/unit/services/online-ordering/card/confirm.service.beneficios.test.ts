// tests/unit/services/online-ordering/card/confirm.service.beneficios.test.ts
/**
 * S11 (P2-4, Review Focus #5; rulings R2' y R4 de `task-S11-go.md`): la tarjeta apartada se vuelve pedido con la clienta y la elección del
 * borrador, y el folio nace SÓLO si el total estricto = el monto AUTORIZADO. Si el beneficio ya no está o el total difiere (menor, mayor o
 * $0), no nace nada: se libera el cargo y el motivo queda durable en la bitácora del cargo (que la liberación no borra).
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import AppError from '@/errors/AppError'

const mockWrite = jest.fn()
jest.mock('@/services/online-ordering/order.service', () => ({
  __esModule: true,
  TX_OPTIONS: {},
  emitOnlineOrderCreated: jest.fn(),
  lockAdmission: jest.fn(),
  pickOrderNumber: jest.fn(async () => '0001'),
  fromQuoteSnapshot: (q: unknown) => q,
  writeOnlineOrderInTx: (...a: unknown[]) => mockWrite(...a),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ __esModule: true, logAction: jest.fn() }))
jest.mock('@/services/online-ordering/card/release.service', () => ({
  __esModule: true,
  CAPTURED_OUTSIDE: 'CAPTURED_OUTSIDE',
  releaseCharge: jest.fn(async () => 'RELEASED'),
}))
jest.mock('@/services/online-ordering/beneficios.service', () => ({
  __esModule: true,
  BENEFIT_UNAVAILABLE: 'BENEFIT_UNAVAILABLE',
  simularBeneficios: jest.fn(async () => null),
}))
jest.mock('@/services/online-ordering/cortesiaDeFolio', () => ({ __esModule: true, despertarPasesTrasCommit: jest.fn() }))
jest.mock('@/services/payments/provider-registry', () => ({
  __esModule: true,
  getProvider: () => ({
    getAuthorization: async () => ({
      piStatus: 'requires_capture',
      paymentIntentId: 'pi_1',
      amountCapturableCents: 10000,
      captureBefore: new Date(),
    }),
  }),
}))

import { emitOnlineOrderCreated } from '@/services/online-ordering/order.service'
import { releaseCharge } from '@/services/online-ordering/card/release.service'
import { despertarPasesTrasCommit } from '@/services/online-ordering/cortesiaDeFolio'
import { simularBeneficios } from '@/services/online-ordering/beneficios.service'
import { confirmCardAuthorization } from '@/services/online-ordering/card/confirm.service'

const D = (v: string) => new Prisma.Decimal(v)
const borrador = (request: Record<string, unknown> = {}) => ({
  id: 'ch1',
  venueId: 'v1',
  status: 'PENDING_AUTH',
  lastError: null,
  checkoutSessionId: 'cs_1',
  ecommerceMerchantId: 'm1',
  merchantSnapshot: { connectAccountId: 'acct_1', sandboxMode: true, providerCode: 'STRIPE_CONNECT' },
  amount: D('100.00'),
  trackingToken: 't',
  requestHash: 'h',
  request: {
    externalId: 'web:k',
    quote: { subtotal: '100', total: '100', lines: [] },
    customer: { name: 'Ana', phone: '+525543453965', email: null },
    note: null,
    whatsappConsent: false,
    customerId: 'cust1',
    beneficios: { premioId: 'r1' },
    ...request,
  },
})

beforeEach(() => {
  prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(borrador() as any)
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  prismaMock.onlineOrderCharge.updateMany.mockResolvedValue({ count: 1 } as any)
  prismaMock.onlineOrderCharge.update.mockResolvedValue({} as any)
  prismaMock.activityLog.create.mockResolvedValue({} as any)
  mockWrite.mockReset()
  mockWrite.mockResolvedValue({ orderId: 'o1', onlineOrderId: 'oo1', total: D('100.00'), premio: false })
})

describe('S11 · confirmar la tarjeta con los beneficios del borrador', () => {
  it('el pedido nace con la clienta y la elección guardadas en el borrador', async () => {
    mockWrite.mockResolvedValue({
      orderId: 'o1',
      onlineOrderId: 'oo1',
      total: D('100.00'),
      premio: true,
    })
    expect(await confirmCardAuthorization('ch1')).toBe('CREATED')
    expect(mockWrite).toHaveBeenCalledWith(
      prismaMock,
      expect.objectContaining({ customerId: 'cust1', beneficios: { customerId: 'cust1', eleccion: { premioId: 'r1' } } }),
    )
    expect(despertarPasesTrasCommit).toHaveBeenCalledWith('v1', ['cust1'])
    expect(releaseCharge).not.toHaveBeenCalled()
  })

  it('un borrador de antes (sin clienta) nace como hoy: sin clienta ni canje', async () => {
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(borrador({ customerId: undefined, beneficios: undefined }) as any)
    mockWrite.mockResolvedValue({ orderId: 'o1', onlineOrderId: 'oo1' })
    expect(await confirmCardAuthorization('ch1')).toBe('CREATED')
    expect(mockWrite).toHaveBeenCalledWith(prismaMock, expect.objectContaining({ customerId: null, beneficios: null }))
  })

  it('Review Focus #5: el premio ya no está ⇒ no nace pedido; se libera con BENEFIT_GONE y el motivo queda en la bitácora del cargo', async () => {
    mockWrite.mockRejectedValue(new AppError('Este premio ya fue canjeado.', 409, true, 'BENEFIT_UNAVAILABLE', { cual: 'PREMIO' }))
    expect(await confirmCardAuthorization('ch1')).toBe('RELEASED_LATE')
    expect(prismaMock.onlineOrderCharge.update).not.toHaveBeenCalled() // el pedido no se ligó: nunca nació
    expect(emitOnlineOrderCreated).not.toHaveBeenCalled()
    const cas = prismaMock.onlineOrderCharge.updateMany.mock.calls.find(([a]: any[]) => a.data.status === 'RELEASING')![0] as any
    expect(cas).toMatchObject({ where: { id: 'ch1', status: 'PENDING_AUTH' }, data: { lastError: 'BENEFIT_GONE' } })
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        venueId: 'v1',
        action: 'ONLINE_ORDER_CARD_PRICE_CHANGED',
        entity: 'OnlineOrderCharge',
        entityId: 'ch1',
        // Sin lugar para simular el precio nuevo: total null (la tienda recotiza) y lo descartado del error estricto.
        data: { motivo: 'BENEFIT_GONE', cual: 'PREMIO', totalEstricto: null, descartados: ['PREMIO'], amount: '100.00' },
      }),
    })
    // R4: el motivo se escribe JUNTO con la decisión de liberar (misma transacción), antes de hablar con Stripe.
    expect(prismaMock.activityLog.create.mock.invocationCallOrder[0]).toBeLessThan((releaseCharge as jest.Mock).mock.invocationCallOrder[0])
    expect(releaseCharge).toHaveBeenCalledWith('ch1')
  })

  it("R4': con el beneficio perdido, el precio nuevo sale de la MISMA simulación (fuera de la transacción revertida)", async () => {
    mockWrite.mockRejectedValue(new AppError('Este premio ya fue canjeado.', 409, true, 'BENEFIT_UNAVAILABLE', { cual: 'PREMIO' }))
    ;(simularBeneficios as jest.Mock).mockResolvedValueOnce({ total: D('100.00'), aplicados: [], descartados: ['PREMIO'] })
    expect(await confirmCardAuthorization('ch1')).toBe('RELEASED_LATE')
    expect(simularBeneficios).toHaveBeenCalledWith('v1', expect.anything(), 'cust1', { premioId: 'r1' })
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        data: expect.objectContaining({ motivo: 'BENEFIT_GONE', totalEstricto: '100.00', descartados: ['PREMIO'] }),
      }),
    })
  })

  it.each([
    ['menor (S10 degradado + automático de $10)', '90.00'],
    ['mayor', '110.00'],
    ['$0 tras autorizar', '0.00'],
  ])("R2': total estricto %s que lo autorizado ⇒ no nace; se libera con PRICE_CHANGED y totalEstricto de la cuenta", async (_n, total) => {
    mockWrite.mockResolvedValue({ orderId: 'o1', onlineOrderId: 'oo1', total: D(total), premio: false })
    expect(await confirmCardAuthorization('ch1')).toBe('RELEASED_LATE')
    expect(prismaMock.onlineOrderCharge.update).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: 'ch1',
        data: { motivo: 'PRICE_CHANGED', cual: null, totalEstricto: total, descartados: [], amount: '100.00' },
      }),
    })
  })

  it('si otro confirmador ya movió el cargo, no se escribe un motivo ni se libera dos veces', async () => {
    mockWrite.mockRejectedValue(new AppError('Este premio ya fue canjeado.', 409, true, 'BENEFIT_UNAVAILABLE', { cual: 'PREMIO' }))
    // El CAS a AUTHORIZED (revertido con la transacción) gana; el de RELEASING ya lo ganó otro.
    prismaMock.onlineOrderCharge.updateMany.mockResolvedValueOnce({ count: 1 } as any).mockResolvedValueOnce({ count: 0 } as any)
    expect(await confirmCardAuthorization('ch1')).toBe('ALREADY')
    expect(mockWrite).toHaveBeenCalledTimes(1)
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    expect(releaseCharge).not.toHaveBeenCalled()
  })
})
