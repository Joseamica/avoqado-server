/**
 * 🔴 PRUEBA NEGATIVA — una liga de pago **no** estampa `Order.shiftId`, y no es un olvido.
 *
 * El 3-sep-2026 se conectó `Order.shiftId` en los sitios que crean órdenes, porque desde la
 * fase 1 del turno del negocio `getActiveShifts` cuenta las órdenes del turno agrupando por ese
 * campo y salía «0 órdenes» en todos los venues. **Los tres caminos de liga de pago quedaron
 * fuera a propósito**, y esta prueba existe para que el siguiente que barra los `order.create`
 * buscando el patrón no los «complete» sin leer el porqué.
 *
 * El porqué: quien paga es el CLIENTE desde su teléfono, cuando quiere, y este código corre en el
 * webhook del procesador — no en el mostrador. `createdById` es quien CREÓ LA LIGA, a veces días
 * antes. Estampar «el turno abierto ahora» le cargaría a un cajero una venta en la que no
 * participó, y una liga pagada de madrugada caería en el turno que alguien dejó abierto.
 *
 * El dinero SÍ llega al turno correcto por otra vía: `Payment.shiftId`, que resuelve el camino
 * del cobro. Lo que se deja nulo es la ATRIBUCIÓN de la orden a un corte de caja.
 *
 * Andamiaje copiado de `paymentLink.service.test.ts`, la suite que ya ejercita `completeCharge`.
 */
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))
jest.mock('nanoid', () => ({ nanoid: jest.fn(() => 'abc12345') }))

const mockBlumonService = {
  tokenizeCard: jest.fn().mockResolvedValue({ token: 'tok_test_123', maskedPan: '424242******4242', cardBrand: 'VISA' }),
  authorizePayment: jest.fn().mockResolvedValue({ transactionId: 'txn_test_123', authorizationCode: 'AUTH123' }),
}
jest.mock('@/services/sdk/blumon-ecommerce.service', () => ({
  getBlumonEcommerceService: jest.fn(() => mockBlumonService),
}))
jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({
  deductInventoryForProduct: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: jest.fn().mockResolvedValue({ id: 'posting-pl-1', status: 'PENDING' }),
  applySalePosting: jest.fn().mockResolvedValue({ postingId: 'posting-pl-1', applied: true, issues: [] }),
}))
jest.mock('@/services/dashboard/loyalty.dashboard.service', () => ({
  __esModule: true,
  earnPoints: jest.fn().mockResolvedValue({ pointsEarned: 0, newBalance: 0 }),
}))
jest.mock('@/services/dashboard/customer.dashboard.service', () => ({
  __esModule: true,
  updateCustomerMetrics: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/dashboard/commission/commission-calculation.service', () => ({
  __esModule: true,
  createCommissionForPayment: jest.fn().mockResolvedValue(undefined),
  createSplitCommissionForPayment: jest.fn().mockResolvedValue(undefined),
}))

import { completeCharge } from '@/services/dashboard/paymentLink.service'
import { prismaMock } from '../../../__helpers__/setup'
import { Decimal } from '@prisma/client/runtime/library'

const VENUE_ID = 'venue-123'
const STAFF_ID = 'staff-123'

function sesionDeCheckout() {
  return {
    id: 'session-db-123',
    sessionId: 'cs_pl_test123',
    ecommerceMerchantId: 'merchant-123',
    paymentLinkId: 'pl-123',
    amount: new Decimal(100),
    currency: 'MXN',
    description: 'Test Payment',
    customerEmail: 'john@example.com',
    customerPhone: null,
    customerName: 'John Doe',
    status: 'PROCESSING',
    metadata: { cardToken: 'tok_test_123', maskedPan: '424242******4242', cardBrand: 'VISA', cvv: '123' },
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    completedAt: null,
    blumonCheckoutId: null,
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    paymentLink: { id: 'pl-123', shortCode: 'abc12345', venueId: VENUE_ID, purpose: 'PAYMENT', createdById: STAFF_ID, attributions: [] },
    ecommerceMerchant: {
      id: 'merchant-123',
      sandboxMode: true,
      providerCredentials: { accessToken: 'test-token' },
      provider: { code: 'BLUMON' },
    },
  }
}

describe('completeCharge (liga de pago) — la orden NO se ata al turno abierto (deliberado)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.checkoutSession.updateMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(sesionDeCheckout() as any)
    prismaMock.checkoutSession.update.mockResolvedValueOnce({} as any)
    prismaMock.paymentLink.update.mockResolvedValueOnce({} as any)
    prismaMock.order.create.mockResolvedValueOnce({ id: 'order-123', orderNumber: 'PL-123' } as any)
    prismaMock.payment.create.mockResolvedValueOnce({ id: 'payment-123' } as any)
  })

  it('la orden nace SIN `shiftId`, aunque haya un turno abierto ahora mismo', async () => {
    // El escenario que importa: el negocio SÍ tiene caja abierta, y aun así la venta en línea
    // no entra a su corte — nadie del mostrador participó en ella.
    prismaMock.shift.findFirst.mockResolvedValue({ id: 'turno-del-mostrador' } as any)

    await completeCharge('abc12345', 'cs_pl_test123')

    const datos = (prismaMock.order.create as jest.Mock).mock.calls[0][0].data
    expect(datos.shiftId ?? null).toBeNull()
  })

  it('los TRES caminos de liga/checkout siguen sin resolver el turno', () => {
    // Estructural a propósito: los otros dos finalizadores (Stripe y MercadoPago) son webhooks
    // con mucho andamiaje y el invariante es el MISMO. Lo que se fija aquí es que nadie meta el
    // helper en este archivo — con el caso de arriba probando el comportamiento de verdad.
    const fs = require('fs')
    const path = require('path')
    const raiz = path.join(__dirname, '../../../../src/services/dashboard')

    for (const archivo of ['paymentLink.service.ts', 'venueCheckout.service.ts']) {
      const fuente = fs.readFileSync(path.join(raiz, archivo), 'utf8')
      expect(fuente).not.toMatch(/turnoAbiertoDelNegocio/)
      // Y el porqué sigue escrito junto al `create`, que es donde lo lee quien lo cambie.
      expect(fuente).toMatch(/NO se estampa `shiftId`, y es DELIBERADO/)
    }

    // Los tres `order.create` de ligas de pago llevan su nota, no sólo uno.
    const ligas = fs.readFileSync(path.join(raiz, 'paymentLink.service.ts'), 'utf8')
    expect(ligas.match(/NO se estampa `shiftId`, y es DELIBERADO/g)).toHaveLength(3)
  })
})
