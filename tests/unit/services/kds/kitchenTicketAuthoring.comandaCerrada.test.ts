/**
 * hz:dcc49fe5:D1 · Codex r4 B10/B13 y r5: una comanda que YA existía (terminada, en papel, una marca sin platillos o abierta, que una
 * marca puede cerrar sin el candado del armado) nunca recibe platillos de otro armado. Lo de este armado sale en una comanda nueva y
 * visible (`order:<cuenta>:mas:<sello>:<estación>`, el folio de su diferencia). Aquí la forma; de punta a punta, contra Postgres, en
 * `tests/integration/mobile/kds-armado.integration.test.ts`.
 */
const ESTACION = 'cstation00000000000000001'
jest.mock('@/services/kds/kitchenDisplayStations', () => ({
  __esModule: true,
  estacionesDelNegocio: jest.fn(async () => ({
    routing: { defaultStationId: 'cstation00000000000000001', activeStationIds: new Set(['cstation00000000000000001']) },
    screens: [{ id: 'cstation00000000000000001', since: new Date(0) }],
  })),
}))

import { prismaMock } from '@tests/__helpers__/setup'
import { authorKitchenTickets } from '@/services/kds/kitchenTicketAuthoring.service'

const VENUE = 'cvenue000000000000000001a'
const ORDER = 'corder000000000000000001a'
const renglon = (id: string) => ({
  id,
  productId: 'cprod000000000000000001aa',
  productName: 'Taco',
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
  product: { name: 'Taco', categoryId: null, printStationId: null, category: null },
  modifiers: [],
})

/** Mostrador; `existe` dice qué folios ya tenían comanda antes de este armado. */
function cuenta(renglones: any[], existe: (sourceKey: string) => boolean) {
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  ;(prismaMock.$queryRaw as jest.Mock).mockImplementation(async () => [{ id: ORDER }])
  prismaMock.order.findFirst.mockImplementation((async ({ select }: any) =>
    select?.onlineOrder
      ? { status: 'OPEN', onlineOrder: null }
      : { id: ORDER, orderNumber: 'M-1', externalId: 'ext-1', tableId: null, type: 'TAKEOUT', source: 'TPV', status: 'OPEN' }) as any)
  prismaMock.orderItem.findFirst.mockResolvedValue(null)
  prismaMock.orderItem.findMany.mockResolvedValueOnce(renglones as any).mockResolvedValue([])
  prismaMock.kdsOrderItem.groupBy.mockResolvedValue([] as any)
  prismaMock.kdsOrder.createManyAndReturn.mockImplementation((async ({ data }: any) =>
    existe(data[0].sourceKey) ? [] : [{ id: `nueva:${data[0].sourceKey}` }]) as any)
  prismaMock.kdsOrder.findUniqueOrThrow.mockImplementation((async ({ where }: any) => ({
    id: `vieja:${where.venueId_sourceKey.sourceKey}`,
    orderId: ORDER,
  })) as any)
  prismaMock.kdsOrderItem.createMany.mockResolvedValue({ count: 1 })
  prismaMock.orderItem.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
}
/** Qué renglones cayeron en qué comanda. */
const escritos = () =>
  prismaMock.kdsOrderItem.createMany.mock.calls.flatMap((c: any[]) => c[0].data.map((d: any) => [d.kdsOrderId, d.orderItemId]))
const FOLIO = `sale:ext-1:${ESTACION}`
const NUEVO = new RegExp(`^nueva:order:${ORDER}:mas:\\d+:${ESTACION}$`)

describe('authorKitchenTickets · comanda que ya existía (Codex r4 B10/B13, r5)', () => {
  const taco = renglon('citem00000000000000000taco')

  it('el folio ya tenía comanda (terminada, en papel, marca o abierta): lo de este armado sale en una comanda nueva', async () => {
    cuenta([taco], k => k === FOLIO)
    const { ticketIds } = await authorKitchenTickets({ venueId: VENUE, orderId: ORDER, trigger: 'PAID' })
    expect(escritos()).toEqual([[expect.stringMatching(NUEVO), taco.id]])
    expect(ticketIds).toEqual([expect.stringMatching(NUEVO)])
    expect(prismaMock.kdsOrderItem.createMany.mock.calls.flatMap((c: any[]) => c[0].data.map((d: any) => d.kdsOrderId))).not.toContain(
      `vieja:${FOLIO}`,
    )
  })

  it('regresión: el folio no existía ⇒ la comanda nace en su folio de siempre y recibe sus platillos', async () => {
    cuenta([taco], () => false)
    await authorKitchenTickets({ venueId: VENUE, orderId: ORDER, trigger: 'PAID' })
    expect(escritos()).toEqual([[`nueva:${FOLIO}`, taco.id]])
    expect(prismaMock.kdsOrder.createManyAndReturn).toHaveBeenCalledTimes(1)
  })

  it('si la comanda nueva también ya existía (mismo milisegundo), nada se escribe: el armado se revierte y el barrido reintenta', async () => {
    cuenta([taco], () => true)
    await expect(authorKitchenTickets({ venueId: VENUE, orderId: ORDER, trigger: 'PAID' })).rejects.toMatchObject({
      code: 'KDS_FOLIO_CONFLICT',
    })
    expect(prismaMock.kdsOrderItem.createMany).not.toHaveBeenCalled()
  })
})
