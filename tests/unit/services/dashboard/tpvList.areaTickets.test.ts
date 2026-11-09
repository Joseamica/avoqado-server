import { prismaMock } from '@tests/__helpers__/setup'
import { getTerminalsData } from '@/services/dashboard/tpv.dashboard.service'

const mockFeature = jest.fn()
jest.mock('../../../../src/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: (...a: unknown[]) => mockFeature(...a),
}))

const area = { id: 'a1', name: 'Panadería', active: true, sendsComanda: true, fulfillmentMode: 'IMMEDIATE' }

function seed() {
  prismaMock.$transaction.mockResolvedValue([[{ id: 't1', name: 'PC', fulfillmentArea: area }], 1] as any)
  prismaMock.terminal.findMany.mockReturnValue([] as any)
  prismaMock.terminal.count.mockReturnValue(0 as any)
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' } as any)
  prismaMock.payment.groupBy.mockResolvedValue([] as any)
  prismaMock.fulfillmentArea.count.mockResolvedValue(3)
}

describe('lista de aparatos: vales por área', () => {
  beforeEach(() => {
    mockFeature.mockReset()
    seed()
  })

  it('cada aparato trae su área (id, name, active, sendsComanda, fulfillmentMode)', async () => {
    prismaMock.venueAreaTicketSettings.findUnique.mockResolvedValue({ enabled: true } as any)
    mockFeature.mockResolvedValue(true)
    const r = await getTerminalsData('v1', 1, 10, {})
    expect(prismaMock.terminal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          fulfillmentArea: { select: { id: true, name: true, active: true, sendsComanda: true, fulfillmentMode: true } },
        },
      }),
    )
    expect((r.data[0] as any).fulfillmentArea).toEqual(area)
  })

  it('areaTickets dice si los vales están prendidos y cuántas áreas activas hay', async () => {
    prismaMock.venueAreaTicketSettings.findUnique.mockResolvedValue({ enabled: true } as any)
    mockFeature.mockResolvedValue(true)
    const r = await getTerminalsData('v1', 1, 10, {})
    expect(r.areaTickets).toEqual({ enabled: true, activeAreaCount: 3 })
  })

  it('sin el plan, enabled es false aunque el interruptor esté prendido', async () => {
    prismaMock.venueAreaTicketSettings.findUnique.mockResolvedValue({ enabled: true } as any)
    mockFeature.mockResolvedValue(false)
    const r = await getTerminalsData('v1', 1, 10, {})
    expect(r.areaTickets?.enabled).toBe(false)
  })

  it('si leer los vales falla, la lista responde igual y sin areaTickets', async () => {
    prismaMock.venueAreaTicketSettings.findUnique.mockRejectedValue(new Error('boom'))
    const r = await getTerminalsData('v1', 1, 10, {})
    expect(r.data).toHaveLength(1)
    expect(r.meta).toEqual({ total: 1, page: 1, pageSize: 10, pageCount: 1 })
    expect(r.areaTickets).toBeUndefined()
  })
})
