/**
 * S9 v5 (B4, U7): la cocina «en duda, manda». En un folio «Nadie» sellado (vencido, cancelado o rechazado alguna vez), el armado se
 * suprime SÓLO si ningún renglón se creó ni se modificó desde T − 5 s (T = la menor de sus fechas de cierre); si alguien tocó algo, se
 * arma exactamente como sin sello. Aquí sólo la forma (qué se pregunta bajo el candado y qué se arma); los casos de punta a punta van en
 * `tests/integration/online-ordering/folios.integration.test.ts` (K1–K11).
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
const T = new Date('2026-11-10T12:00:00.000Z')
const RENGLON = {
  id: 'citem000000000000000001aa',
  productId: 'cprod000000000000000001aa',
  productName: 'Flautas',
  quantity: 1,
  notes: null,
  externalId: null,
  sentToKitchenAt: null,
  createdAt: new Date('2026-11-10T11:00:00.000Z'),
  serviceCourse: null,
  orderPromotionId: null,
  areaTicketLineId: null,
  releasedAreaTicketLineId: null,
  giftCardId: null,
  weightQuantity: null,
  weightUnit: null,
  product: { name: 'Flautas', categoryId: null, printStationId: null, category: null },
  modifiers: [],
}

type Folio = {
  requiresAcceptance: boolean
  createdAt?: Date
  expiredAt?: Date | null
  cancelledAt?: Date | null
  cancelledBy?: string | null
  rejectedAt?: Date | null
} | null
function base(o: { folio?: Folio; status?: string; tocado?: boolean; horaDelCobro?: Date | null } = {}) {
  const folio = o.folio === undefined ? { requiresAcceptance: false, expiredAt: T } : o.folio
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  ;(prismaMock.$queryRaw as jest.Mock).mockImplementation(async () => [{ id: ORDER }])
  prismaMock.order.findFirst.mockImplementation((async ({ select }: any) =>
    select?.onlineOrder
      ? {
          status: o.status ?? 'COMPLETED',
          ...(o.horaDelCobro !== undefined ? { loyaltySaleAt: o.horaDelCobro } : {}),
          onlineOrder: folio
            ? {
                createdAt: new Date('2026-11-10T11:30:00.000Z'),
                expiredAt: null,
                cancelledAt: null,
                cancelledBy: null,
                rejectedAt: null,
                ...folio,
              }
            : null,
        }
      : {
          id: ORDER,
          orderNumber: 'F-1',
          externalId: null,
          tableId: null,
          type: 'PICKUP',
          source: 'WEB',
          status: o.status ?? 'COMPLETED',
        }) as any)
  prismaMock.orderItem.findFirst.mockImplementation((async ({ where }: any) =>
    where.OR ? (o.tocado ? { id: RENGLON.id } : null) : null) as any)
  prismaMock.orderItem.findMany.mockResolvedValueOnce([RENGLON] as any).mockResolvedValue([])
  prismaMock.kdsOrderItem.findMany.mockResolvedValue([])
  prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
}
const tocadoLeido = () => prismaMock.orderItem.findFirst.mock.calls.map((c: any[]) => c[0]).find((a: any) => a.where.OR)

beforeEach(() => {
  ;(planKitchenTickets as jest.Mock).mockClear()
})

describe('authorKitchenTickets · folio sellado (S9 v5, U7)', () => {
  it('sin sello (un folio que nunca se anuló, «Mi equipo» o una cuenta sin folio): arma como hoy, sin preguntar nada más', async () => {
    for (const folio of [{ requiresAcceptance: false }, { requiresAcceptance: true, expiredAt: T }, null]) {
      prismaMock.orderItem.findFirst.mockReset()
      base({ folio })
      await authorKitchenTickets({ venueId: VENUE, orderId: ORDER, trigger: 'PAID' })
      expect(planKitchenTickets).toHaveBeenCalled()
      expect(tocadoLeido()).toBeUndefined()
      ;(planKitchenTickets as jest.Mock).mockClear()
    }
  })

  it.each<KitchenTrigger>(['PAID', 'ROUND', 'SWEEP', 'LEGACY_POST'])(
    'sellado y NADA tocado desde T − 5 s (%s): 0 comandas y la marca se limpia con la guarda <= startedAt',
    async trigger => {
      prismaMock.orderItem.findFirst.mockReset()
      base()
      await expect(authorKitchenTickets({ venueId: VENUE, orderId: ORDER, trigger })).resolves.toEqual({ ticketIds: [] })
      expect(planKitchenTickets).not.toHaveBeenCalled()
      expect(prismaMock.kdsOrderItem.createMany).not.toHaveBeenCalled()
      expect(prismaMock.order.updateMany).toHaveBeenCalledWith({
        where: { id: ORDER, venueId: VENUE, kitchenPendingAt: { lte: expect.any(Date) } },
        data: { kitchenPendingAt: null },
      })
    },
  )

  it('sellado y un renglón creado o tocado desde T − 5 s: arma exactamente como sin sello', async () => {
    prismaMock.orderItem.findFirst.mockReset()
    base({ tocado: true })
    await authorKitchenTickets({ venueId: VENUE, orderId: ORDER, trigger: 'PAID' })
    expect(planKitchenTickets).toHaveBeenCalled()
  })

  it('T es la MENOR de las fechas de cierre, con 5 s de holgura y comparación inclusiva sobre createdAt y updatedAt', async () => {
    prismaMock.orderItem.findFirst.mockReset()
    base({ folio: { requiresAcceptance: false, expiredAt: T, cancelledAt: new Date('2026-11-10T11:00:00.000Z') } })
    await authorKitchenTickets({ venueId: VENUE, orderId: ORDER, trigger: 'SWEEP' })
    const desde = new Date('2026-11-10T10:59:55.000Z')
    expect(tocadoLeido()).toEqual({
      where: { orderId: ORDER, OR: [{ createdAt: { gte: desde } }, { updatedAt: { gte: desde } }] },
      select: { id: true },
    })
  })

  it.each<KitchenTrigger>(['PAID', 'ROUND', 'SWEEP', 'LEGACY_POST'])(
    'regla C (founder, 10-nov): sellado y nada tocado, pero cobrado en la caja ANTES de T (%s) ⇒ arma como sin sello, sin preguntar por renglones',
    async trigger => {
      prismaMock.orderItem.findFirst.mockReset()
      base({ horaDelCobro: new Date('2026-11-10T11:55:00.000Z') }) // folio de las 11:30, cobrado a las 11:55, venció a las 12:00
      await authorKitchenTickets({ venueId: VENUE, orderId: ORDER, trigger })
      expect(planKitchenTickets).toHaveBeenCalled()
      expect(tocadoLeido()).toBeUndefined()
    },
  )

  it.each([
    ['después de T', new Date('2026-11-10T12:15:00.000Z'), undefined],
    ['justo en T', T, undefined],
    ['sin hora', null, undefined],
    ['antes de que existiera el folio (reloj sin hora)', new Date('2026-11-10T11:00:00.000Z'), undefined],
    // La fecha del sello (la conciliación la pone al llegar el dinero) y la de «cancelado por otra vía» se escriben DESPUÉS de anular.
    ['antes del sello sin quién (no es fecha exacta)', new Date('2026-11-10T11:55:00.000Z'), { cancelledAt: T, cancelledBy: null }],
    [
      'antes de «cancelado por otra vía» (no es fecha exacta)',
      new Date('2026-11-10T11:55:00.000Z'),
      { cancelledAt: T, cancelledBy: 'ORDER_CANCELLED_ELSEWHERE' },
    ],
  ])('regla C: cobrado %s ⇒ la supresión de B4 sigue (0 comandas, la marca se limpia)', async (_c, hora, cierre) => {
    prismaMock.orderItem.findFirst.mockReset()
    base({ horaDelCobro: hora as Date | null, ...(cierre ? { folio: { requiresAcceptance: false, ...cierre } } : {}) })
    await expect(authorKitchenTickets({ venueId: VENUE, orderId: ORDER, trigger: 'ROUND' })).resolves.toEqual({ ticketIds: [] })
    expect(planKitchenTickets).not.toHaveBeenCalled()
    expect(tocadoLeido()).toBeDefined()
  })

  it('la relectura bajo el candado trae la hora del cobro y la creación del folio (una consulta, sin otra lectura)', async () => {
    prismaMock.orderItem.findFirst.mockReset()
    base()
    await authorKitchenTickets({ venueId: VENUE, orderId: ORDER, trigger: 'SWEEP' })
    const relectura = prismaMock.order.findFirst.mock.calls.map((c: any[]) => c[0]).find((a: any) => a.select?.onlineOrder)
    expect(relectura.select).toEqual({
      status: true,
      loyaltySaleAt: true,
      onlineOrder: {
        select: { requiresAcceptance: true, createdAt: true, expiredAt: true, cancelledAt: true, cancelledBy: true, rejectedAt: true },
      },
    })
  })

  it('cuenta cancelada: como hoy (nada que cocinar, sin preguntar por renglones)', async () => {
    prismaMock.orderItem.findFirst.mockReset()
    base({ status: 'CANCELLED' })
    await expect(authorKitchenTickets({ venueId: VENUE, orderId: ORDER, trigger: 'SWEEP' })).resolves.toEqual({ ticketIds: [] })
    expect(tocadoLeido()).toBeUndefined()
    expect(planKitchenTickets).not.toHaveBeenCalled()
  })
})
