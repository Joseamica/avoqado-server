/** S9 I1: el detalle del Cambio del panel lleva `settlement.storeCredit` (opcional), leído del `result` de la misma fila. */
import { prismaMock } from '@tests/__helpers__/setup'
import { getExchangeForDashboard } from '@/services/dashboard/exchange.dashboard.service'

const fila = (result: unknown) => ({
  id: 'ex1',
  status: 'COMPLETED',
  reviewReason: null,
  createdAt: new Date('2026-10-26T18:00:00Z'),
  originalOrderId: 'o1',
  originalPaymentId: null,
  newOrderId: 'o2',
  differenceAmount: { mul: () => ({ toNumber: () => -20000 }) },
  chargePaymentId: null,
  staffId: 's1',
  reviewedAt: null,
  reviewedById: null,
  reviewNote: null,
  returnedAmount: { mul: () => ({ toNumber: () => 30000 }) },
  takenAmount: { mul: () => ({ toNumber: () => 10000 }) },
  settlementKind: 'REFUND',
  settlementMethod: 'STORE_CREDIT',
  lines: null,
  result,
})

beforeEach(() => {
  ;(prismaMock.order.findMany as jest.Mock).mockResolvedValue([])
  ;(prismaMock.staff.findMany as jest.Mock).mockResolvedValue([])
})

it('trae settlement.storeCredit del result guardado, sin otra consulta del cambio', async () => {
  const storeCredit = {
    customerId: 'c1',
    customerName: 'Ana',
    amountCents: 20000,
    newBalanceCents: 35050,
    phoneLast4: '1111',
    phoneMismatch: false,
  }
  ;(prismaMock.exchange.findFirst as jest.Mock).mockResolvedValue(fila({ settlement: { storeCredit } }))
  const r = await getExchangeForDashboard({ venueId: 'v1', exchangeId: 'ex1' })
  expect(r.settlement).toMatchObject({ kind: 'REFUND', method: 'STORE_CREDIT', amountCents: 20000, storeCredit })
  expect(prismaMock.exchange.findFirst).toHaveBeenCalledTimes(1)
})

it('sin saldo a favor el campo no existe (aditivo)', async () => {
  ;(prismaMock.exchange.findFirst as jest.Mock).mockResolvedValue(fila({ settlement: {} }))
  const r = await getExchangeForDashboard({ venueId: 'v1', exchangeId: 'ex1' })
  expect('storeCredit' in r.settlement).toBe(false)
})
