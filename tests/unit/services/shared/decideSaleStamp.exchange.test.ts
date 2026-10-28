/**
 * La regla del sello tardío ante la venta nueva de un cambio de producto (spec 2026-10-20 §7.7): no es una visita nueva, así que
 * no promete ni reporta sello (`NOT_APPLICABLE`: las apps no pintan nada, como con la cuenta de tarjetas de regalo), pero sigue
 * siendo elegible para la lealtad: la diferencia cobrada da puntos por la liga tardía y por el reconciliador.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import {
  LATE_STAMP_WINDOW_MS,
  decideSaleStamp,
  esElegibleParaLealtad,
  fotoDeLaVenta,
  type SaleStampSnapshot,
} from '@/services/shared/loyaltyOnLateCustomer'

const MIN = 60_000
const AHORA = Date.UTC(2026, 9, 21, 18, 0, 0)
const base: SaleStampSnapshot = {
  customerId: 'cust-1',
  status: 'COMPLETED',
  paymentStatus: 'PAID',
  reembolsada: false,
  hasReversal: false,
  primaryCustomerId: 'cust-1',
  stampOwnerCustomerId: null,
  pointsOwnerCustomerIds: [],
  settledAt: new Date(AHORA - 30 * MIN),
  esVentaDeTarjetas: false,
  esVentaNuevaDeCambio: false,
}
const nuevaDeCambio: SaleStampSnapshot = { ...base, esVentaNuevaDeCambio: true }

describe('decideSaleStamp · new sale of a product exchange', () => {
  it('the new sale of an exchange is NOT_APPLICABLE for the stamp, paid or open, also for the data repair', () => {
    expect(decideSaleStamp(nuevaDeCambio, AHORA)).toBe('NOT_APPLICABLE')
    expect(decideSaleStamp({ ...nuevaDeCambio, paymentStatus: 'PENDING' }, AHORA)).toBe('NOT_APPLICABLE')
    expect(decideSaleStamp(nuevaDeCambio, AHORA, { ignorarPlazo: true })).toBe('NOT_APPLICABLE')
  })

  it('regression: an ordinary sale inside the window is still ELIGIBLE', () => {
    expect(decideSaleStamp(base, AHORA)).toBe('ELIGIBLE')
  })

  it('esElegibleParaLealtad stays true for the new sale of an exchange inside the window (the difference still earns points)', () => {
    expect(esElegibleParaLealtad(nuevaDeCambio, AHORA)).toBe(true)
    expect(esElegibleParaLealtad(nuevaDeCambio, AHORA, { ignorarPlazo: true })).toBe(true)
  })

  it('esElegibleParaLealtad for the new sale still respects the window, refunds, an open sale and another owner', () => {
    expect(esElegibleParaLealtad({ ...nuevaDeCambio, settledAt: new Date(AHORA - LATE_STAMP_WINDOW_MS - MIN) }, AHORA)).toBe(false)
    expect(esElegibleParaLealtad({ ...nuevaDeCambio, reembolsada: true }, AHORA)).toBe(false)
    expect(esElegibleParaLealtad({ ...nuevaDeCambio, paymentStatus: 'PARTIAL' }, AHORA)).toBe(false)
    expect(esElegibleParaLealtad({ ...nuevaDeCambio, pointsOwnerCustomerIds: ['otro'] }, AHORA)).toBe(false)
  })
})

describe('fotoDeLaVenta · new sale of a product exchange', () => {
  const venta = {
    id: 'order-new',
    orderNumber: 'ORD-9',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    total: 90,
    tipAmount: 0,
    customerId: null,
    loyaltyEligibleAt: new Date(AHORA - 30 * MIN),
    loyaltyProcessedAt: null,
    orderCustomers: [{ customerId: 'cust-1' }],
    payments: [{ createdAt: new Date(AHORA - 30 * MIN) }],
    stampEvents: [],
    loyaltyTransactions: [],
  }

  beforeEach(() => {
    prismaMock.order.findFirst.mockReset()
    prismaMock.payment.count.mockReset()
    prismaMock.exchange.findUnique.mockReset()
    prismaMock.order.findFirst.mockResolvedValue(venta)
    prismaMock.payment.count.mockResolvedValue(0)
  })

  it('the snapshot marks the new sale of an exchange with one indexed read of Exchange.newOrderId', async () => {
    prismaMock.exchange.findUnique.mockResolvedValue({ id: 'exch-1' })

    const foto = await fotoDeLaVenta(prismaMock, { venueId: 'venue-1', orderId: 'order-new', customerId: 'cust-1' })

    expect(foto?.esVentaNuevaDeCambio).toBe(true)
    expect(prismaMock.exchange.findUnique).toHaveBeenCalledWith({ where: { newOrderId: 'order-new' }, select: { id: true } })
  })

  it('an ordinary sale is not marked', async () => {
    prismaMock.exchange.findUnique.mockResolvedValue(null)

    const foto = await fotoDeLaVenta(prismaMock, { venueId: 'venue-1', orderId: 'order-new', customerId: 'cust-1' })

    expect(foto?.esVentaNuevaDeCambio).toBe(false)
  })
})
