/**
 * 🔴 Toma de cuentas (Codex, ronda 3 de la auditoría del 1-oct): el «confirmar compra» de la app de clientes aceptaba cualquier
 * sesión de pago y, si la ficha de la compra no tenía cuenta, se la ligaba al Consumer que llamaba y le copiaba su correo y
 * teléfono. Con una compra de invitado hecha con el teléfono o el correo de otra persona, el comprador se quedaba con su ficha.
 * La compra legítima desde la app nace con la ficha ya ligada (`createCreditCheckoutForConsumer`), así que sólo se confirma lo
 * que ya es de quien llama.
 */
jest.mock('@/services/dashboard/creditPack.public.service', () => ({
  __esModule: true,
  createCheckoutSession: jest.fn(),
  fulfillPurchase: jest.fn(async () => ({ id: 'compra-1' })),
}))
jest.mock('@/services/consumer/reservation.consumer.service', () => ({ __esModule: true, ensureVenueCustomerActivated: jest.fn() }))

import { prismaMock } from '@tests/__helpers__/setup'
import { finalizeCreditCheckout } from '@/services/consumer/credit.consumer.service'

const compraDe = (consumerId: string | null) => ({
  id: 'compra-1',
  venueId: 'venue-1',
  creditPackId: 'pack-1',
  status: 'ACTIVE',
  customer: { id: 'ficha-1', consumerId, email: null, phone: '+525512345678' },
  creditPack: { id: 'pack-1', name: 'Paquete 10 clases' },
})

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.consumer.findUnique.mockResolvedValue({ id: 'consumer-yo', email: 'yo@gmail.com', phone: null } as any)
})

describe('finalizeCreditCheckout — sólo confirma compras de fichas que ya son de quien llama', () => {
  it('🔴 compra de una ficha SIN cuenta (p. ej. de invitado): 403, sin ligarla ni copiarle contactos', async () => {
    prismaMock.creditPackPurchase.findUnique.mockResolvedValue(compraDe(null) as any)

    await expect(finalizeCreditCheckout('consumer-yo', 'cs_ajena')).rejects.toMatchObject({ statusCode: 403 })

    expect(prismaMock.customer.update).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('compra de una ficha ligada a OTRA cuenta: 403', async () => {
    prismaMock.creditPackPurchase.findUnique.mockResolvedValue(compraDe('consumer-otro') as any)

    await expect(finalizeCreditCheckout('consumer-yo', 'cs_otro')).rejects.toMatchObject({ statusCode: 403 })
  })

  it('regresión: compra de la ficha de quien llama → la confirma', async () => {
    prismaMock.creditPackPurchase.findUnique.mockResolvedValue(compraDe('consumer-yo') as any)

    await expect(finalizeCreditCheckout('consumer-yo', 'cs_mia')).resolves.toMatchObject({
      purchaseId: 'compra-1',
      customerId: 'ficha-1',
      creditPackName: 'Paquete 10 clases',
    })
    expect(prismaMock.customer.update).not.toHaveBeenCalled()
  })
})
