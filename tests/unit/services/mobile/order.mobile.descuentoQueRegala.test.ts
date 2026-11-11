/**
 * hz:e0b12f00:D2 (10-nov, hermana de D1): en el POS (ANDROID/WINDOWS), un «Descuento de la cuenta» libre que deja en $0 lo que queda de
 * los productos es una cortesía. Lo decide el SERVIDOR con SU base y en centavos, después de la búsqueda idempotente:
 * - con `orders:comp` (o el PIN) la fila lleva quién la autorizó;
 * - la app nueva en línea (`cortesiaDeCuentaConPin`) sin permiso ⇒ `RegaloSinPermisoError` (el controlador pide el PIN);
 * - lo que llega de una cola (`isOfflineReplay`) o de una app vieja (sin la marca) se registra igual, con bitácora en la misma
 *   transacción y aviso al dueño: nunca se pierde una venta ya hecha.
 */
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/shared/repartoDescuentoTx', () => ({
  ...jest.requireActual('@/services/shared/repartoDescuentoTx'),
  sincronizarRepartos: jest.fn(),
}))
jest.mock('@/services/mobile/avisoDeVentaSinRed', () => ({
  ...jest.requireActual('@/services/mobile/avisoDeVentaSinRed'),
  avisarVentaSinRed: jest.fn().mockResolvedValue(undefined),
}))

import { Decimal } from '@prisma/client/runtime/library'
import { RegaloSinPermisoError } from '@/errors/AppError'
import { avisarVentaSinRed } from '@/services/mobile/avisoDeVentaSinRed'
import { createOrderWithItems, type CreateOrderInput } from '@/services/mobile/order.mobile.service'
import * as promotionService from '@/services/promotions/promotion.service'
import { prismaMock } from '../../../__helpers__/setup'

const playera = { id: 'prod-1', name: 'Playera', price: new Decimal(100), sku: 'PLY-1', categoryId: 'cat-1', category: { name: 'Ropa' } }

function ordenDesdeLosDatos(args: any) {
  const { data } = args
  return {
    id: 'order-1',
    orderNumber: data.orderNumber,
    status: 'CONFIRMED',
    paymentStatus: 'PENDING',
    subtotal: data.subtotal,
    discountAmount: data.discountAmount,
    taxAmount: data.taxAmount,
    total: data.total,
    createdAt: new Date(),
    items: data.items.create.map((it: any, k: number) => ({ id: `oi-${k}`, ...it, modifiers: [] })),
    promotions: [],
  }
}

const filaDeCuenta = () =>
  (prismaMock.orderDiscount.create as jest.Mock).mock.calls.map(c => c[0].data).find(f => f.name === 'Descuento de la cuenta')
const bitacoras = () => (prismaMock.activityLog.create as jest.Mock).mock.calls.map(c => c[0].data)
const bitacoraDelRegalo = () => bitacoras().find(b => b.action === 'VENTA_SIN_RED_DESCUENTO_SIN_PERMISO')

/** Venta de una playera de $100 con `discount` (centavos) libre: la app nueva en línea, sin permiso de cortesía. */
function crear(extra: Partial<CreateOrderInput> = {}) {
  return createOrderWithItems('venue-1', {
    staffId: 'staff-1',
    source: 'AVOQADO_ANDROID',
    externalId: 'venta-1',
    items: [{ productId: 'prod-1', quantity: 1, externalId: 'l1' }],
    discount: 10000,
    cortesiaDeCuentaConPin: true,
    canCompItems: false,
    performedBy: 'staff-1',
    ...extra,
  } as CreateOrderInput)
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.orderAction = { create: jest.fn() }
  prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', venueId: 'venue-1' })
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
  prismaMock.product.findMany.mockResolvedValue([playera])
  prismaMock.modifier.findMany.mockResolvedValue([])
  prismaMock.discount.findMany.mockResolvedValue([])
  prismaMock.order.findUnique.mockResolvedValue(null)
  prismaMock.order.create.mockImplementation(async (args: any) => ordenDesdeLosDatos(args))
  prismaMock.activityLog.create.mockResolvedValue({ id: 'log-1' })
  prismaMock.$queryRaw.mockResolvedValue([])
})

afterEach(() => jest.restoreAllMocks())

describe('D2: el «Descuento de la cuenta» que deja los productos en $0', () => {
  it('🔴 app nueva en línea, sin permiso: RegaloSinPermisoError y no se crea nada', async () => {
    await expect(crear()).rejects.toBeInstanceOf(RegaloSinPermisoError)
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.orderDiscount.create).not.toHaveBeenCalled()
  })

  it('un monto MAYOR que la base también regala (se topa a la base)', async () => {
    await expect(crear({ discount: 25000 })).rejects.toBeInstanceOf(RegaloSinPermisoError)
  })

  it('$99.99 de $100 deja un centavo: pasa sin permiso y sin autorizador', async () => {
    await crear({ discount: 9999 })
    expect(Number(filaDeCuenta().amount)).toBe(99.99)
    expect(filaDeCuenta().authorizedById).toBeUndefined()
    expect(bitacoraDelRegalo()).toBeUndefined()
  })

  it('la propina no cuenta: 100 % con $20 de propina sigue siendo cortesía', async () => {
    await expect(crear({ tip: 2000 })).rejects.toBeInstanceOf(RegaloSinPermisoError)
  })

  it('con permiso: la fila lleva a quien la autorizó (el gerente del PIN o la membresía de quien cobra)', async () => {
    await crear({ canCompItems: true, regaloAutorizadoPor: 'sv-gerente' })
    expect(filaDeCuenta()).toMatchObject({ amount: new Decimal(100), authorizedById: 'sv-gerente' })
    expect(bitacoraDelRegalo()).toBeUndefined()
    expect(avisarVentaSinRed).not.toHaveBeenCalled()
  })

  it('con permiso pero sin sesión (`performedBy`): falla cerrado', async () => {
    await expect(crear({ canCompItems: true, performedBy: undefined })).rejects.toBeInstanceOf(RegaloSinPermisoError)
  })

  it.each([
    ['la cola sin red (isOfflineReplay)', { isOfflineReplay: true }],
    ['una app vieja (sin la marca)', { cortesiaDeCuentaConPin: undefined }],
  ])('🔴 %s sin permiso: se registra igual, con bitácora en la transacción y aviso al dueño', async (_, extra) => {
    const orden = await crear(extra as Partial<CreateOrderInput>)
    expect(orden).toMatchObject({ id: 'order-1' })
    expect(filaDeCuenta()).toMatchObject({ amount: new Decimal(100) })
    expect(filaDeCuenta().authorizedById).toBeUndefined()
    expect(bitacoraDelRegalo()).toMatchObject({
      venueId: 'venue-1',
      entity: 'VentaSinRed',
      entityId: 'venta-1',
      data: expect.objectContaining({ orderId: 'order-1', montoCents: 10000 }),
    })
    expect(avisarVentaSinRed).toHaveBeenCalledWith(
      'venue-1',
      'DESCUENTO_SIN_PERMISO',
      expect.objectContaining({ externalId: 'venta-1', orderId: 'order-1', montoCents: 10000 }),
    )
  })

  it('la cola CON permiso: autorizada, sin bitácora ni aviso', async () => {
    await crear({ isOfflineReplay: true, canCompItems: true, regaloAutorizadoPor: 'sv-1' })
    expect(filaDeCuenta().authorizedById).toBe('sv-1')
    expect(bitacoraDelRegalo()).toBeUndefined()
    expect(avisarVentaSinRed).not.toHaveBeenCalled()
  })

  it('🔴 un reintento de una venta ya creada recibe su orden: la regla va después de la búsqueda idempotente', async () => {
    prismaMock.order.findUnique.mockResolvedValue(
      ordenDesdeLosDatos({
        data: {
          orderNumber: 'ORD-1',
          subtotal: new Decimal(100),
          discountAmount: new Decimal(100),
          taxAmount: new Decimal(0),
          total: new Decimal(0),
          items: { create: [] },
        },
      }),
    )
    await expect(crear()).resolves.toMatchObject({ id: 'order-1' })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('todo regalado por renglón (cortesía de línea, con su permiso): la base es $0 y el descuento de cuenta no aplica', async () => {
    await crear({
      canCompItems: true,
      items: [{ productId: 'prod-1', quantity: 1, externalId: 'l1', isCortesia: true, cortesiaReason: 'Cliente frecuente' }],
    })
    expect(filaDeCuenta()).toBeUndefined()
  })
})

describe('D2 con promociones: la base es la cuenta CON el combo', () => {
  const comboDe = (pesos: number) => {
    prismaMock.order.findFirst.mockResolvedValue({
      subtotal: new Decimal(pesos),
      serviceChargeAmount: new Decimal(0),
      paidAmount: new Decimal(0),
    })
    prismaMock.order.update.mockResolvedValue({
      ...ordenDesdeLosDatos({
        data: {
          subtotal: new Decimal(pesos),
          discountAmount: new Decimal(0),
          taxAmount: new Decimal(0),
          total: new Decimal(0),
          items: { create: [] },
        },
      }),
    })
  }
  const conCombo = (extra: Partial<CreateOrderInput> = {}) =>
    crear({ items: [{ promotionRef: { promotionId: 'promo-1', promotionInstanceId: 'uuid-1', selections: [] } }] as any, ...extra })

  beforeEach(() => {
    prismaMock.product.findMany.mockResolvedValue([])
    jest.spyOn(promotionService, 'applyPromotionToOrder').mockResolvedValue({ orderPromotionId: 'op-1', netCents: 15000, created: true })
  })

  it('🔴 combo de $150 y descuento de $150: sin permiso se rechaza', async () => {
    comboDe(150)
    await expect(conCombo({ discount: 15000 })).rejects.toBeInstanceOf(RegaloSinPermisoError)
  })

  it('combo de $150 y descuento de $149.99: pasa', async () => {
    comboDe(150)
    await conCombo({ discount: 14999 })
    expect(Number(filaDeCuenta().amount)).toBe(149.99)
  })

  it('con permiso: la fila del combo lleva el autorizador', async () => {
    comboDe(150)
    await conCombo({ discount: 15000, canCompItems: true, regaloAutorizadoPor: 'sv-gerente' })
    expect(filaDeCuenta()).toMatchObject({ authorizedById: 'sv-gerente' })
  })

  it('de la cola sin permiso: se registra con bitácora', async () => {
    comboDe(150)
    await conCombo({ discount: 15000, isOfflineReplay: true })
    expect(filaDeCuenta().authorizedById).toBeUndefined()
    expect(bitacoraDelRegalo()).toMatchObject({ data: expect.objectContaining({ montoCents: 15000 }) })
  })
})
