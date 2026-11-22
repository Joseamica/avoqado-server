/**
 * hz:e82938e1:D38 (Codex d38 r1). El barrido de cocina escoge las cuentas con marca y luego arma una por una. Si entre escogerla y
 * tomarla otra caja la ANULÓ (la marca se va con la anulación) y el dinero ya capturado la REABRIÓ, el armado veía una cuenta viva y
 * mandaba la comanda: la regla S1 dice que una cancelada reabierta por dinero no vuelve a la cocina. El barrido sólo atiende marcas:
 * si bajo el candado la marca ya no está, no arma. Los demás disparos (cobro, ronda, POST legado) no cambian.
 */
jest.mock('@/services/kds/kitchenDisplayStations', () => ({
  __esModule: true,
  estacionesDelNegocio: jest.fn(async () => ({
    routing: { defaultStationId: 'cstation00000000000000001', activeStationIds: new Set(['cstation00000000000000001']) },
    screens: [{ id: 'cstation00000000000000001', since: new Date(0) }],
  })),
}))
jest.mock('@/services/kds/kitchenTicketPlanning', () => ({ __esModule: true, planKitchenTickets: jest.fn(() => []) }))

import { prismaMock } from '@tests/__helpers__/setup'
import { authorKitchenTickets, type KitchenTrigger } from '@/services/kds/kitchenTicketAuthoring.service'
import { planKitchenTickets } from '@/services/kds/kitchenTicketPlanning'

const VENUE = 'cvenue000000000000000001a'
const ORDER = 'corder000000000000000001a'
const RENGLON = {
  id: 'citem000000000000000001aa',
  productId: 'cprod000000000000000001aa',
  productName: 'Café',
  quantity: 1,
  notes: null,
  externalId: null,
  sentToKitchenAt: null,
  createdAt: new Date(),
  serviceCourse: null,
  orderPromotionId: null,
  areaTicketLineId: null,
  releasedAreaTicketLineId: null,
  giftCardId: null,
  weightQuantity: null,
  weightUnit: null,
  product: { name: 'Café', categoryId: null, printStationId: null, category: null },
  modifiers: [],
}

/** Una cuenta viva de mostrador; `marca` es su `kitchenPendingAt` releído bajo el candado. */
function cuenta(marca: Date | null) {
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  ;(prismaMock.$queryRaw as jest.Mock).mockImplementation(async () => [{ id: ORDER }])
  prismaMock.order.findFirst.mockImplementation((async ({ select }: any) =>
    select?.onlineOrder
      ? { status: 'PENDING', loyaltySaleAt: null, kitchenPendingAt: marca, onlineOrder: null }
      : {
          id: ORDER,
          orderNumber: 'A-1',
          externalId: null,
          tableId: 'ctable0000000000000001aaa',
          type: 'DINE_IN',
          source: 'POS',
          status: 'PENDING',
        }) as any)
  prismaMock.orderItem.findFirst.mockResolvedValue(null)
  prismaMock.orderItem.findMany.mockResolvedValueOnce([RENGLON] as any).mockResolvedValue([])
  prismaMock.kdsOrderItem.findMany.mockResolvedValue([])
  prismaMock.kdsOrderItem.groupBy.mockResolvedValue([] as any)
  prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
}

beforeEach(() => {
  ;(planKitchenTickets as jest.Mock).mockClear()
  prismaMock.kdsOrderItem.createMany.mockClear()
})

describe('authorKitchenTickets · el barrido sólo atiende marcas (D38)', () => {
  it('🔴 barrido y la marca ya no está bajo el candado (la anularon y el dinero la reabrió): 0 comandas', async () => {
    cuenta(null)
    await expect(authorKitchenTickets({ venueId: VENUE, orderId: ORDER, trigger: 'SWEEP' })).resolves.toEqual({ ticketIds: [] })
    expect(planKitchenTickets).not.toHaveBeenCalled()
    expect(prismaMock.kdsOrderItem.createMany).not.toHaveBeenCalled()
  })

  it('regresión: barrido con la marca puesta arma como siempre', async () => {
    cuenta(new Date())
    await authorKitchenTickets({ venueId: VENUE, orderId: ORDER, trigger: 'SWEEP' })
    expect(planKitchenTickets).toHaveBeenCalled()
  })

  it.each<KitchenTrigger>(['PAID', 'ROUND', 'LEGACY_POST'])(
    'regresión: %s sin marca arma como siempre (sólo el barrido la exige)',
    async trigger => {
      cuenta(null)
      await authorKitchenTickets({ venueId: VENUE, orderId: ORDER, trigger })
      expect(planKitchenTickets).toHaveBeenCalled()
    },
  )
})
