/**
 * hz:dcc49fe5:D1 · Codex r4 B10/B13: una comanda TERMINADA o «en papel» nunca absorbe lo que no cubrió. Lo nuevo sale en una comanda
 * nueva y visible (`order:<cuenta>:mas:<sello>:<estación>`, el folio de la diferencia de ese armado). Una MARCA sin platillos cubre lo que
 * la cuenta ya tenía cuando llegó y nada creado ni tocado desde entonces (− 5 s). Aquí la forma; de punta a punta, contra Postgres, en
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
const MARCA_LLEGO = new Date(Date.now() - 30_000)
const antes = new Date(MARCA_LLEGO.getTime() - 60_000)
const renglon = (id: string, escrito: { createdAt: Date; updatedAt: Date }) => ({
  id,
  productId: 'cprod000000000000000001aa',
  productName: 'Taco',
  quantity: 1,
  notes: null,
  externalId: null,
  sentToKitchenAt: null,
  ...escrito,
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

/** Mostrador cuyo folio `sale:ext-1:<estación>` ya existe con el estado dado; la comanda nueva se crea al primer intento. */
function cuenta(o: { renglones: any[]; existente: Record<string, unknown>; conPlatillos: boolean }) {
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  ;(prismaMock.$queryRaw as jest.Mock).mockImplementation(async () => [{ id: ORDER }])
  prismaMock.order.findFirst.mockImplementation((async ({ select }: any) =>
    select?.onlineOrder
      ? { status: 'OPEN', onlineOrder: null }
      : { id: ORDER, orderNumber: 'M-1', externalId: 'ext-1', tableId: null, type: 'TAKEOUT', source: 'TPV', status: 'OPEN' }) as any)
  prismaMock.orderItem.findFirst.mockResolvedValue(null)
  prismaMock.orderItem.findMany.mockResolvedValueOnce(o.renglones as any).mockResolvedValue([])
  prismaMock.kdsOrderItem.groupBy.mockResolvedValue([] as any)
  prismaMock.kdsOrder.createManyAndReturn.mockImplementation((async ({ data }: any) =>
    data[0].sourceKey === `sale:ext-1:${ESTACION}` ? [] : [{ id: 'nueva' }]) as any)
  prismaMock.kdsOrder.findUniqueOrThrow.mockResolvedValue({
    id: 'existente',
    orderId: ORDER,
    preparationVersion: 0,
    status: 'NEW',
    fallbackPrintedAt: null,
    createdAt: MARCA_LLEGO,
    ...o.existente,
  } as any)
  prismaMock.kdsOrderItem.findFirst.mockResolvedValue((o.conPlatillos ? { id: 'platillo' } : null) as any)
  prismaMock.kdsOrderItem.createMany.mockResolvedValue({ count: 1 })
  prismaMock.orderItem.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
}
/** Qué renglones cayeron en qué comanda. */
const escritos = () =>
  prismaMock.kdsOrderItem.createMany.mock.calls.flatMap((c: any[]) => c[0].data.map((d: any) => [d.kdsOrderId, d.orderItemId]))
const folioNuevo = () => prismaMock.kdsOrder.createManyAndReturn.mock.calls.map((c: any[]) => c[0].data[0].sourceKey)[1]

describe('authorKitchenTickets · comanda cerrada (Codex r4 B10/B13)', () => {
  const viejo = renglon('citem0000000000000000viejo', { createdAt: antes, updatedAt: antes })
  const nuevo = renglon('citem0000000000000000nuevo', { createdAt: new Date(), updatedAt: new Date() })
  const tocado = renglon('citem000000000000000tocado', { createdAt: antes, updatedAt: new Date() })

  it.each([
    ['TERMINADA', { status: 'COMPLETED' }],
    ['en papel', { fallbackPrintedAt: MARCA_LLEGO }],
  ])('B13: %s con platillos ⇒ un renglón que no está en ella sale en una comanda nueva, nunca en la cerrada', async (_c, existente) => {
    cuenta({ renglones: [viejo], existente, conPlatillos: true })
    const { ticketIds } = await authorKitchenTickets({ venueId: VENUE, orderId: ORDER, trigger: 'PAID' })
    expect(escritos()).toEqual([['nueva', viejo.id]])
    expect(ticketIds).toEqual(['nueva'])
    expect(folioNuevo()).toMatch(new RegExp(`^order:${ORDER}:mas:\\d+:${ESTACION}$`))
  })

  it('B10: una MARCA sin platillos absorbe lo que ya existía al llegar; lo creado o tocado después sale en una comanda nueva', async () => {
    cuenta({ renglones: [viejo, nuevo, tocado], existente: { status: 'COMPLETED' }, conPlatillos: false })
    await authorKitchenTickets({ venueId: VENUE, orderId: ORDER, trigger: 'PAID' })
    expect(escritos()).toEqual([
      ['existente', viejo.id],
      ['nueva', nuevo.id],
      ['nueva', tocado.id],
    ])
  })

  it('B10: un empate con la llegada de la marca (dentro de los 5 s) cuenta como tocado: en duda, manda', async () => {
    const empate = renglon('citem000000000000000empate', { createdAt: antes, updatedAt: new Date(MARCA_LLEGO.getTime() - 4_000) })
    cuenta({ renglones: [empate], existente: { fallbackPrintedAt: MARCA_LLEGO }, conPlatillos: false })
    await authorKitchenTickets({ venueId: VENUE, orderId: ORDER, trigger: 'PAID' })
    expect(escritos()).toEqual([['nueva', empate.id]])
  })

  it('regresión: una comanda ABIERTA del mismo folio sigue recibiendo lo nuevo, como siempre', async () => {
    cuenta({ renglones: [viejo, nuevo], existente: { status: 'PREPARING' }, conPlatillos: true })
    await authorKitchenTickets({ venueId: VENUE, orderId: ORDER, trigger: 'PAID' })
    expect(escritos()).toEqual([
      ['existente', viejo.id],
      ['existente', nuevo.id],
    ])
    expect(prismaMock.kdsOrder.createManyAndReturn).toHaveBeenCalledTimes(1)
  })
})
