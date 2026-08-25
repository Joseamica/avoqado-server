import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

/**
 * Fase 4 del kiosco — el carril de dinero.
 *
 * Tres defectos que el spec nombra, y que sólo se ven cuando dos manos tocan el mismo
 * paquete a la vez o cuando el aparato reintenta un cobro:
 *
 *  1. `amountPaid` venía del BODY. Quien llama decide cuánto "pagó" el cliente.
 *  2. El tope `maxPerCustomer` se contaba FUERA de la transacción: dos compras
 *     simultáneas leen el mismo conteo y las dos pasan.
 *  3. No había forma de atar la compra al cobro real, así que un reintento del PAX
 *     tras un timeout acreditaba el paquete DOS VECES por un solo cobro.
 *
 * Estas pruebas son la línea que separa "se acreditó lo que se cobró" de "regalamos
 * un paquete". No se difieren.
 */
describe('Fase 4 · carril de dinero de los paquetes', () => {
  const pack = {
    id: 'pack-1',
    venueId: 'venue-1',
    price: 1500,
    active: true,
    validityDays: null,
    maxPerCustomer: null as number | null,
    items: [{ id: 'item-1', productId: 'prod-1', quantity: 10 }],
  }

  /** Cliente de transacción SEPARADO del global: así se ve quién hizo cada consulta. */
  function makeTx() {
    return {
      creditPackPurchase: { count: jest.fn().mockResolvedValue(0), create: jest.fn().mockResolvedValue({ id: 'purchase-1' }) },
      creditItemBalance: { create: jest.fn().mockResolvedValue({ id: 'bal-1' }) },
      creditTransaction: { create: jest.fn().mockResolvedValue({}) },
      customer: { update: jest.fn().mockResolvedValue({}) },
    }
  }

  let tx: ReturnType<typeof makeTx>

  beforeEach(() => {
    jest.clearAllMocks()
    tx = makeTx()
    ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(tx))
    prismaMock.creditPack.findUnique.mockResolvedValue({ ...pack } as any)
    prismaMock.creditPack.findFirst.mockResolvedValue({ ...pack } as any)
    prismaMock.customer.findFirst.mockResolvedValue({ id: 'cust-1', venueId: 'venue-1' } as any)
    prismaMock.creditPackPurchase.findUnique.mockResolvedValue(null as any)
    prismaMock.creditPackPurchase.findFirst.mockResolvedValue(null as any)
  })

  describe('venta en persona', () => {
    it('🔴 cobra el precio de lista, NO el monto que venga en el body', async () => {
      const { sellPackInPerson } = await import('@/services/mobile/creditPack.mobile.service')

      // Quien llama intenta acreditar un paquete de $1,500 diciendo que se pagó $1.
      // El tipo de `opts` YA no admite `amountPaid` — ése fue justamente el arreglo, y por eso
      // esto necesita un cast. El cast NO debilita la prueba: verifica la SEGUNDA capa, que el
      // servidor siga poniendo el precio de lista aunque el campo llegue de todos modos (un
      // cliente viejo, un body sin validar, una llamada en JS sin tipos).
      await sellPackInPerson('venue-1', 'pack-1', 'cust-1', 'staff-1', { amountPaid: 1 } as unknown as { note?: string })

      const created = tx.creditPackPurchase.create.mock.calls[0][0].data
      expect(Number(created.amountPaid)).toBe(1500)
    })

    it('🔴 cuenta el tope por cliente DENTRO de la transacción', async () => {
      prismaMock.creditPack.findUnique.mockResolvedValue({ ...pack, maxPerCustomer: 1 } as any)
      const { sellPackInPerson } = await import('@/services/mobile/creditPack.mobile.service')

      await sellPackInPerson('venue-1', 'pack-1', 'cust-1', 'staff-1')

      // Contarlo fuera es la carrera: dos ventas leen 0 y las dos pasan.
      expect(tx.creditPackPurchase.count).toHaveBeenCalled()
      expect(prismaMock.creditPackPurchase.count).not.toHaveBeenCalled()
    })

    it('🔴 rechaza al cliente que ya llegó a su tope', async () => {
      prismaMock.creditPack.findUnique.mockResolvedValue({ ...pack, maxPerCustomer: 1 } as any)
      tx.creditPackPurchase.count.mockResolvedValue(1)
      const { sellPackInPerson } = await import('@/services/mobile/creditPack.mobile.service')

      await expect(sellPackInPerson('venue-1', 'pack-1', 'cust-1', 'staff-1')).rejects.toThrow(/máximo/i)
      expect(tx.creditPackPurchase.create).not.toHaveBeenCalled()
    })
  })

  describe('acreditar tras un cobro real', () => {
    const payment = { id: 'pay-1', venueId: 'venue-1', status: 'COMPLETED', amount: 1500 }

    it('🔴 el monto acreditado sale del COBRO, no de quien llama', async () => {
      // El cobro real fue de $1,200 (hubo descuento en el POS): eso es lo que vale.
      prismaMock.payment.findUnique.mockResolvedValue({ ...payment, amount: 1200 } as any)
      const { fulfillCreditPackPurchaseFromPayment } = await import('@/services/mobile/creditPack.mobile.service')

      await fulfillCreditPackPurchaseFromPayment({
        paymentId: 'pay-1',
        venueId: 'venue-1',
        packId: 'pack-1',
        customerId: 'cust-1',
      })

      const created = tx.creditPackPurchase.create.mock.calls[0][0].data
      expect(Number(created.amountPaid)).toBe(1200)
      expect(created.paymentId).toBe('pay-1')
    })

    it('🔴 el mismo cobro NO acredita dos veces (el PAX reintenta tras un timeout)', async () => {
      prismaMock.payment.findUnique.mockResolvedValue(payment as any)
      prismaMock.creditPackPurchase.findUnique.mockResolvedValue({ id: 'purchase-1', paymentId: 'pay-1' } as any)
      const { fulfillCreditPackPurchaseFromPayment } = await import('@/services/mobile/creditPack.mobile.service')

      const again = await fulfillCreditPackPurchaseFromPayment({
        paymentId: 'pay-1',
        venueId: 'venue-1',
        packId: 'pack-1',
        customerId: 'cust-1',
      })

      expect(again.id).toBe('purchase-1')
      expect(tx.creditPackPurchase.create).not.toHaveBeenCalled()
    })

    it('🔴 no acredita nada si el cobro no quedó COMPLETED', async () => {
      prismaMock.payment.findUnique.mockResolvedValue({ ...payment, status: 'PENDING' } as any)
      const { fulfillCreditPackPurchaseFromPayment } = await import('@/services/mobile/creditPack.mobile.service')

      await expect(
        fulfillCreditPackPurchaseFromPayment({ paymentId: 'pay-1', venueId: 'venue-1', packId: 'pack-1', customerId: 'cust-1' }),
      ).rejects.toThrow()
      expect(tx.creditPackPurchase.create).not.toHaveBeenCalled()
    })

    it('🔴 no acredita con un cobro de OTRO negocio', async () => {
      prismaMock.payment.findUnique.mockResolvedValue({ ...payment, venueId: 'venue-2' } as any)
      const { fulfillCreditPackPurchaseFromPayment } = await import('@/services/mobile/creditPack.mobile.service')

      await expect(
        fulfillCreditPackPurchaseFromPayment({ paymentId: 'pay-1', venueId: 'venue-1', packId: 'pack-1', customerId: 'cust-1' }),
      ).rejects.toThrow()
      expect(tx.creditPackPurchase.create).not.toHaveBeenCalled()
    })
  })
})
