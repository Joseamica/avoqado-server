/** D5: `couponCode` en `POST /mobile/.../orders`: mismo núcleo que crear y cobrar con saldo. */
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/kds/kitchenDisplayStations', () => ({
  debeMarcarCocina: jest.fn().mockResolvedValue(false),
  assertPreparationAuthoringAccess: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/shared/repartoDescuentoTx', () => ({
  ...jest.requireActual('@/services/shared/repartoDescuentoTx'),
  sincronizarRepartos: jest.fn(),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { Decimal } from '@prisma/client/runtime/library'
import { createOrderWithItems, type CreateOrderInput } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const CAFE = { id: 'cafe', name: 'Café', price: new Decimal(100), sku: 'CAFE', categoryId: 'c1', category: { name: 'Bebidas' } }
const descuento = (extra: Record<string, unknown> = {}) => ({
  id: 'd-1',
  venueId: VENUE,
  name: 'Diez',
  active: true,
  type: 'PERCENTAGE',
  value: new Decimal(10),
  scope: 'ORDER',
  maxDiscountAmount: null,
  minPurchaseAmount: null,
  compReason: null,
  ...extra,
})
const cupon = (d = descuento(), extra: Record<string, unknown> = {}) => ({
  id: 'cup-1',
  code: 'DESC10',
  active: true,
  maxUses: null,
  maxUsesPerCustomer: null,
  currentUses: 0,
  minPurchaseAmount: null,
  validFrom: null,
  validUntil: null,
  discount: d,
  ...extra,
})

let filas: any[]

const crear = (extra: Partial<CreateOrderInput> = {}) =>
  createOrderWithItems(VENUE, {
    staffId: 'staff-1',
    source: 'AVOQADO_ANDROID',
    orderType: 'TAKEOUT',
    items: [{ productId: 'cafe', quantity: 1 }],
    couponCode: 'desc10',
    ...extra,
  } as CreateOrderInput)

beforeEach(() => {
  jest.clearAllMocks()
  filas = []
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.$queryRaw.mockResolvedValue([])
  prismaMock.order.findUnique.mockResolvedValue(null)
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', active: true } as any)
  prismaMock.staffOrganization.findFirst.mockResolvedValue(null)
  prismaMock.staffVenue.findUnique.mockResolvedValue({ id: 'sv-1', active: true, staff: { active: true } } as any)
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: VENUE, active: true } as any)
  prismaMock.product.findMany.mockResolvedValue([CAFE] as any)
  prismaMock.modifier.findMany.mockResolvedValue([])
  prismaMock.discount.findMany.mockResolvedValue([])
  prismaMock.discount.findFirst.mockResolvedValue(descuento() as any)
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.venueSettings.findUnique.mockResolvedValue(null)
  prismaMock.couponCode.findFirst.mockResolvedValue(cupon() as any)
  prismaMock.orderDiscount.create.mockImplementation((async ({ data }: any) => {
    filas.push(data)
    return { id: `od-${filas.length}`, ...data }
  }) as any)
  prismaMock.order.create.mockImplementation((async ({ data }: any) => ({
    id: 'order-1',
    orderNumber: data.orderNumber,
    status: data.status,
    paymentStatus: data.paymentStatus,
    type: data.type,
    source: data.source,
    subtotal: data.subtotal,
    discountAmount: data.discountAmount,
    taxAmount: data.taxAmount,
    total: data.total,
    createdAt: new Date(),
    items: data.items.create.map((it: any, k: number) => ({ id: `oi-${k}`, isCortesia: false, cortesiaReason: null, ...it, modifiers: [] })),
    promotions: [],
  })) as any)
})

const datos = () => (prismaMock.order.create as jest.Mock).mock.calls[0][0].data

it('el servidor calcula el cupón (el `discount` de la app no manda), liga la fila y no sube contadores al crear', async () => {
  const r = await crear({ discount: 999 })
  expect(Number(datos().discountAmount)).toBe(10)
  expect(Number(datos().total)).toBe(90)
  expect(Number(r.total)).toBe(90)
  expect(filas).toHaveLength(1)
  expect(filas[0]).toMatchObject({ couponCodeId: 'cup-1', discountId: 'd-1', name: 'Diez (DESC10)', isManual: false })
  expect(prismaMock.discount.updateMany).not.toHaveBeenCalled()
})

it('rechazo en línea: en español y sin crear nada', async () => {
  prismaMock.couponCode.findFirst.mockResolvedValue(cupon(descuento(), { active: false }) as any)
  await expect(crear()).rejects.toMatchObject({ statusCode: 400, message: 'Este cupón está inactivo.' })
  expect(prismaMock.order.create).not.toHaveBeenCalled()
})

it('una venta de la cola nunca se rechaza por el cupón: ya ocurrió y queda como descuento libre, sin liga', async () => {
  const r = await crear({ discount: 1000, isOfflineReplay: true, createdAtLocal: Date.now() } as Partial<CreateOrderInput>)
  expect(prismaMock.couponCode.findFirst).not.toHaveBeenCalled()
  expect(Number(r.total)).toBe(90)
  expect(filas[0].couponCodeId).toBeUndefined()
})

it('COMP sin autoridad: 403', async () => {
  const comp = descuento({ type: 'COMP', value: new Decimal(0) })
  prismaMock.couponCode.findFirst.mockResolvedValue(cupon(comp) as any)
  prismaMock.discount.findFirst.mockResolvedValue(comp as any)
  await expect(crear()).rejects.toMatchObject({ statusCode: 403 })
})

it('sin cupón no cambia nada', async () => {
  await crear({ couponCode: undefined, discount: 1000 } as Partial<CreateOrderInput>)
  expect(filas[0]).toMatchObject({ name: 'Descuento de la cuenta', isManual: true })
  expect(prismaMock.couponCode.findFirst).not.toHaveBeenCalled()
})

it('Codex r1 #3: un cupón y un premio de sellos en la misma venta se rechazan antes de crear nada', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { leerVentaDeMostrador } = require('@/controllers/mobile/order.mobile.controller')
  const r = leerVentaDeMostrador(
    { staffId: 'staff-1', items: [{ productId: 'cafe', quantity: 1 }], couponCode: 'DESC10', stampRewardId: 'rw-1', stampRewardAware: true },
    { conPropinaDeOrden: true, venueId: VENUE, usuario: 'staff-1' },
  )
  expect(r).toEqual({ error: 'Un cupón y un premio de sellos no se combinan en la misma venta. Quita uno de los dos.' })
})

it('Codex r1 #1: aparta el cupón en la MISMA transacción que crea la venta', async () => {
  prismaMock.couponCode.findFirst.mockResolvedValue(cupon(descuento(), { maxUses: 1 }) as any)
  prismaMock.orderDiscount.count.mockResolvedValue(1)
  await expect(crear()).rejects.toMatchObject({ statusCode: 400, message: 'Este cupón ya alcanzó su límite de usos.' })
  expect(prismaMock.order.create).not.toHaveBeenCalled()
})
