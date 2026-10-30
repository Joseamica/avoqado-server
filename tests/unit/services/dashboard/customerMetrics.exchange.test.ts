/**
 * Métricas del cliente con la venta nueva de un cambio de producto (spec 2026-10-20 §7.7): no es una visita nueva, así que sólo
 * suma al gasto lo cobrado de más, sin visita ni fechas de visita. Una venta de siempre sale exactamente igual que hoy.
 */
import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '@tests/__helpers__/setup'
import { updateCustomerMetrics } from '@/services/dashboard/customer.dashboard.service'

const metric = (prismaMock as any).customerOrderMetric

function clienteConVisitas(totalVisits: number, totalSpent: number) {
  prismaMock.$queryRaw.mockResolvedValue([
    { id: 'customer-1', venueId: 'venue-1', totalVisits, totalSpent: new Decimal(totalSpent), firstVisitAt: new Date('2024-01-01') },
  ] as never)
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction.mockImplementation((async (callback: any) => callback(prismaMock)) as never)
  metric.findUnique.mockResolvedValue(null)
  metric.create.mockResolvedValue({ id: 'metric-1' })
  prismaMock.customer.update.mockResolvedValue({} as never)
})

describe('updateCustomerMetrics · new sale of a product exchange', () => {
  it('skipVisit adds only the charged amount to the spend: no visit and no visit dates; the order ledger still applies it once', async () => {
    clienteConVisitas(5, 500)

    await updateCustomerMetrics('customer-1', 30, 'order-new', 'venue-1', { skipVisit: true })

    expect(metric.create).toHaveBeenCalledWith({
      data: { customerId: 'customer-1', orderId: 'order-new', venueId: 'venue-1', amount: 30 },
    })
    expect(prismaMock.customer.update).toHaveBeenCalledWith({
      where: { id: 'customer-1' },
      data: { totalSpent: 530, averageOrderValue: 530 / 5 },
    })
  })

  it('skipVisit on a customer without visits leaves the average alone (no division by zero)', async () => {
    clienteConVisitas(0, 0)

    await updateCustomerMetrics('customer-1', 30, 'order-new', 'venue-1', { skipVisit: true })

    expect(prismaMock.customer.update).toHaveBeenCalledWith({ where: { id: 'customer-1' }, data: { totalSpent: 30 } })
  })

  it('regression: without options a paid order still adds the visit, the spend, the average and the visit dates', async () => {
    clienteConVisitas(5, 500)

    await updateCustomerMetrics('customer-1', 150, 'order-1', 'venue-1')

    expect(prismaMock.customer.update).toHaveBeenCalledWith({
      where: { id: 'customer-1' },
      data: {
        totalVisits: 6,
        totalSpent: 650,
        averageOrderValue: 650 / 6,
        lastVisitAt: expect.any(Date),
        firstVisitAt: new Date('2024-01-01'),
      },
    })
  })
})
