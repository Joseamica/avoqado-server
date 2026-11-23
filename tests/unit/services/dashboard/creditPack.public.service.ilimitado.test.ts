/**
 * D679 · paquete Ilimitado en el carril en línea: la compra con Stripe guarda la marca (W9), el selector del widget no ofrece el
 * pase para 2 lugares (N2) y el correo de compra no dice «99999 sesiones» (N3).
 */
const mockStripeCheckoutRetrieve = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({ checkout: { sessions: { create: jest.fn(), retrieve: mockStripeCheckoutRetrieve } } })),
)

import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/utils/serializableRetry', () => ({
  withSerializableRetry: jest.fn((fn: any) => fn(prismaMock)),
  withDeadlockRetry: jest.fn((fn: any) => fn(prismaMock)),
}))
jest.mock('@/services/superadmin/platformSettings.service', () => ({ getVatRateBps: jest.fn().mockResolvedValue(1600) }))
const mockCorreo = jest.fn(async (..._a: unknown[]) => true)
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: { sendCreditPackPurchaseEmail: (...a: any[]) => mockCorreo(...a) },
}))

import { fulfillPurchase, lookupCustomerCredits } from '../../../../src/services/dashboard/creditPack.public.service'
import { CreditPurchaseStatus } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

const VENUE_ID = 'venue-1'
const CUSTOMER_ID = 'cust-1'

describe('D679 · Ilimitado en el carril en línea', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$queryRaw.mockResolvedValue([])
  })

  describe('fulfillPurchase (W9) y su correo (N3)', () => {
    const pack = {
      id: 'pack-ili',
      venueId: VENUE_ID,
      name: 'Ilimitado mensual',
      price: new Decimal(2500),
      currency: 'MXN',
      validityDays: 30,
      items: [
        { id: 'item-ili', creditPackId: 'pack-ili', productId: 'prod-lagree', quantity: 99999, unlimited: true },
        { id: 'item-shake', creditPackId: 'pack-ili', productId: 'prod-shake', quantity: 2, unlimited: false },
      ],
    }

    beforeEach(() => {
      mockStripeCheckoutRetrieve.mockResolvedValue({
        id: 'cs_ili',
        metadata: {
          type: 'credit_pack_purchase',
          venueId: VENUE_ID,
          packId: 'pack-ili',
          customerId: CUSTOMER_ID,
          customerEmail: 'ana@x.com',
        },
        customer_email: null,
        amount_total: 250000,
        payment_intent: 'pi_ili',
        payment_status: 'paid',
      })
      prismaMock.creditPackPurchase.findUnique.mockResolvedValue(null)
      prismaMock.creditPack.findFirst.mockResolvedValue(pack)
      prismaMock.customer.findFirst.mockResolvedValue({ id: CUSTOMER_ID, venueId: VENUE_ID, firstName: 'Ana' })
      prismaMock.creditPackPurchase.create.mockResolvedValue({ id: 'purchase-ili' })
      prismaMock.creditItemBalance.create.mockResolvedValue({ id: 'bal' })
      prismaMock.creditTransaction.create.mockResolvedValue({})
      prismaMock.customer.update.mockResolvedValue({})
      prismaMock.venue.findUnique.mockResolvedValue({ name: 'Mindform', slug: 'mindform' })
      prismaMock.product.findMany.mockResolvedValue([
        { id: 'prod-lagree', name: 'Lagree' },
        { id: 'prod-shake', name: 'Shake' },
      ])
    })

    it('el saldo del renglón Ilimitado nace con 99999 y la marca; el normal, sin ella', async () => {
      await fulfillPurchase('cs_ili')
      expect(prismaMock.creditItemBalance.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ productId: 'prod-lagree', originalQuantity: 99999, remainingQuantity: 99999, unlimited: true }),
      })
      const normal = prismaMock.creditItemBalance.create.mock.calls.find((c: any) => c[0].data.productId === 'prod-shake')[0].data
      expect(normal.unlimited).toBeUndefined()
      expect(normal).toMatchObject({ originalQuantity: 2, remainingQuantity: 2 })
    })

    it('Codex r1 #3 · lectura partida (sin vigencia + renglón Ilimitado): relee la vigencia en la entrega y vence', async () => {
      prismaMock.creditPack.findFirst.mockResolvedValue({ ...pack, validityDays: null })
      prismaMock.creditPack.findUnique.mockResolvedValue({ validityDays: 30 })
      await fulfillPurchase('cs_ili')
      const { expiresAt } = prismaMock.creditPackPurchase.create.mock.calls[0][0].data
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3_600_000)
    })

    it('el correo dice «Ilimitado de Lagree», nunca 99999', async () => {
      await fulfillPurchase('cs_ili')
      const datos = (mockCorreo.mock.calls[0] as any[])[1]
      expect(datos.itemLines).toEqual(['Ilimitado de Lagree', '2 sesiones de Shake'])
      expect(JSON.stringify(datos)).not.toContain('99999')
    })
  })

  describe('lookupCustomerCredits (N2)', () => {
    const conSaldos = (...balances: Array<{ id: string; remainingQuantity: number; unlimited: boolean }>) => {
      prismaMock.customer.findFirst.mockResolvedValue({
        id: CUSTOMER_ID,
        venueId: VENUE_ID,
        firstName: 'Ana',
        lastName: null,
        email: null,
        phone: null,
      })
      prismaMock.creditPackPurchase.findMany.mockResolvedValue([
        {
          id: 'p1',
          status: CreditPurchaseStatus.ACTIVE,
          creditPack: { name: 'Ilimitado' },
          itemBalances: balances.map(b => ({
            ...b,
            productId: 'prod-lagree',
            originalQuantity: 99999,
            product: { id: 'prod-lagree', name: 'Lagree' },
          })),
        },
      ])
    }
    const suficiente = async (seats?: number) =>
      (await lookupCustomerCredits(VENUE_ID, CUSTOMER_ID, { seats })).purchases[0].itemBalances.map((b: any) => b.sufficient)

    it('con un Ilimitado: 2 lugares no alcanzan, 1 sí, y sin lugares pedidos también', async () => {
      conSaldos({ id: 'b-ili', remainingQuantity: 99999, unlimited: true })
      expect(await suficiente(2)).toEqual([false])
      expect(await suficiente(1)).toEqual([true])
      expect(await suficiente(undefined)).toEqual([true])
    })

    it('un saldo normal sigue la regla de hoy', async () => {
      conSaldos({ id: 'b-1', remainingQuantity: 3, unlimited: false })
      expect(await suficiente(2)).toEqual([true])
      expect(await suficiente(4)).toEqual([false])
    })
  })
})
