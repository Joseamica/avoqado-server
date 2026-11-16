/**
 * Encargo f998c8 (founder «A», 15-nov, como Toast): el motivo que eligió la caja viaja con la venta de Mostrador y se COPIA como texto
 * a la fila del descuento (renglón de catálogo, «Ajuste de precio» y cuenta). Nunca rechaza una venta: sin motivo, la fila queda como
 * siempre («Sin motivo»). Con motivos distintos, el «Ajuste de precio» se parte en una fila por motivo para que el reporte cuadre.
 */
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))
// La cortesía sincroniza repartos con consultas propias de la transacción: aquí sólo importa que no escriba el ajuste.
jest.mock('@/services/shared/repartoDescuentoTx', () => ({
  ...jest.requireActual('@/services/shared/repartoDescuentoTx'),
  sincronizarRepartos: jest.fn(),
}))

import { Decimal } from '@prisma/client/runtime/library'
import { createOrderWithItems, type CreateOrderInput } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'


function playera(extra: Record<string, unknown> = {}) {
  return { id: 'prod-1', name: 'Playera', price: new Decimal(100), sku: 'PLY-1', categoryId: 'cat-1', category: { name: 'Ropa' }, ...extra }
}

/** La orden que «guarda» la base: lo que se mandó a crear, con ids (el `id` de un renglón ajustado viaja en los datos). */
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
    items: data.items.create.map((it: any, k: number) => ({
      id: `oi-${k}`,
      ...it,
      modifiers: (it.modifiers?.create ?? []).map((m: any, j: number) => ({
        id: `oim-${k}-${j}`,
        ...m,
        modifier: { id: m.modifierId, name: m.name, price: new Decimal(15) },
      })),
    })),
    promotions: [],
  }
}

const datosDeLaOrden = () => (prismaMock.order.create as jest.Mock).mock.calls[0][0].data
const lineasCreadas = () =>
  datosDeLaOrden().items.create as Array<{ id?: string; unitPrice: Decimal; total: Decimal; discountAmount: Decimal }>
const filasDeDescuento = () => (prismaMock.orderDiscount.create as jest.Mock).mock.calls.map(c => c[0].data)
const filasDeAjuste = () => filasDeDescuento().filter(f => f.name === 'Ajuste de precio')

/**
 * Encargo 1afe04: desde el 15-nov el ajuste pide la acreditación de la ruta (`tpv-orders:discount` o el PIN de un encargado). Estas
 * pruebas de DINERO la traen (es lo que deja el middleware cuando pasó); sin ella, abajo («Ajuste de precio pide aprobación»).
 */
function crear(extra: Partial<CreateOrderInput>) {
  return createOrderWithItems('venue-1', {
    staffId: 'staff-1',
    source: 'AVOQADO_ANDROID',
    items: [],
    aprobacionDelDescuento: {},
    ...extra,
  } as CreateOrderInput)
}

const descuento = (extra: Record<string, unknown> = {}) => ({
  id: 'disc-10',
  venueId: 'venue-1',
  name: '10%',
  type: 'PERCENTAGE',
  value: new Decimal(10),
  active: true,
  ...extra,
})

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.orderAction = { create: jest.fn() }
  prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', venueId: 'venue-1' })
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
  prismaMock.product.findMany.mockResolvedValue([playera()])
  prismaMock.modifier.findMany.mockResolvedValue([])
  prismaMock.discount.findMany.mockResolvedValue([])
  prismaMock.order.findUnique.mockResolvedValue(null)
  prismaMock.order.create.mockImplementation(async (args: any) => ordenDesdeLosDatos(args))
  prismaMock.activityLog.create.mockResolvedValue({ id: 'log-1' })
  prismaMock.$queryRaw.mockResolvedValue([])
})

describe('motivo del descuento en la venta de Mostrador (f998c8)', () => {
  it('renglón con descuento de catálogo: la fila lleva el motivo y el comentario recortados', async () => {
    prismaMock.discount.findMany.mockResolvedValue([descuento()])
    await crear({
      items: [
        {
          productId: 'prod-1',
          quantity: 1,
          externalId: 'e1',
          discountId: 'disc-10',
          discountReason: ' Cliente frecuente ',
          discountReasonComment: ' viene diario ',
        },
      ],
    })
    const [fila] = filasDeDescuento()
    expect(fila).toMatchObject({ discountId: 'disc-10', reason: 'Cliente frecuente', reasonComment: 'viene diario' })
    expect(Number(fila.amount)).toBe(10)
  })

  it('«Ajuste de precio» con motivo: su fila lo lleva', async () => {
    await crear({
      items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', adjustedUnitPrice: 8000, discountReason: 'Error de etiqueta' }],
    })
    expect(filasDeAjuste()).toHaveLength(1)
    expect(filasDeAjuste()[0]).toMatchObject({ reason: 'Error de etiqueta' })
    expect(filasDeAjuste()[0].reasonComment).toBeUndefined()
  })

  it('dos ajustes con motivos distintos: una fila por motivo, y cada una suma sólo lo suyo', async () => {
    await crear({
      items: [
        { productId: 'prod-1', quantity: 1, externalId: 'e1', adjustedUnitPrice: 8000, discountReason: 'Error de etiqueta' },
        { productId: 'prod-1', quantity: 1, externalId: 'e2', adjustedUnitPrice: 9000, discountReason: 'Producto dañado' },
      ],
    })
    const filas = filasDeAjuste()
    expect(filas.map(f => [f.reason, Number(f.amount)])).toEqual([
      ['Error de etiqueta', 20],
      ['Producto dañado', 10],
    ])
    const [r1, r2] = lineasCreadas()
    expect(filas[0].appliedToItemIds).toEqual([r1.id])
    expect(filas[1].appliedToItemIds).toEqual([r2.id])
    expect(Number(datosDeLaOrden().total)).toBe(170)
  })

  it('dos ajustes con el MISMO motivo: una sola fila, como antes', async () => {
    await crear({
      items: [
        { productId: 'prod-1', quantity: 1, externalId: 'e1', adjustedUnitPrice: 8000, discountReason: 'Error de etiqueta' },
        { productId: 'prod-1', quantity: 1, externalId: 'e2', adjustedUnitPrice: 9000, discountReason: 'Error de etiqueta' },
      ],
    })
    expect(filasDeAjuste()).toHaveLength(1)
    expect(Number(filasDeAjuste()[0].amount)).toBe(30)
  })

  it('descuento de la cuenta: el motivo de la cuenta va a su fila', async () => {
    await crear({
      items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1' }],
      discount: 1500,
      orderDiscountReason: 'Queja del cliente',
      orderDiscountReasonComment: 'tardó la orden',
      descuentoConPermisoPropio: true,
    } as Partial<CreateOrderInput>)
    const cuenta = filasDeDescuento().find(f => f.name === 'Descuento de la cuenta')
    expect(cuenta).toMatchObject({ reason: 'Queja del cliente', reasonComment: 'tardó la orden' })
  })

  it('de la cola sin red (isOfflineReplay): entra igual con su motivo', async () => {
    await crear({
      isOfflineReplay: true,
      items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', adjustedUnitPrice: 8000, discountReason: 'Error de etiqueta' }],
    })
    expect(filasDeAjuste()[0]).toMatchObject({ reason: 'Error de etiqueta' })
  })

  it('basura en el motivo no rechaza la venta: se ignora', async () => {
    await crear({ items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', adjustedUnitPrice: 8000, discountReason: 42 as any }] })
    expect(filasDeAjuste()).toHaveLength(1)
    expect('reason' in filasDeAjuste()[0]).toBe(false)
  })

  describe('regresión: sin motivo todo queda como antes', () => {
    it('renglón con descuento de catálogo sin motivo: sin id propio y la fila sin llaves de motivo', async () => {
      prismaMock.discount.findMany.mockResolvedValue([descuento()])
      await crear({ items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', discountId: 'disc-10' }] })
      expect(lineasCreadas()[0].id).toBeUndefined()
      const [fila] = filasDeDescuento()
      expect('reason' in fila).toBe(false)
      expect('reasonComment' in fila).toBe(false)
    })

    it('dos ajustes sin motivo: una sola fila «Ajuste de precio»', async () => {
      await crear({
        items: [
          { productId: 'prod-1', quantity: 1, externalId: 'e1', adjustedUnitPrice: 8000 },
          { productId: 'prod-1', quantity: 1, externalId: 'e2', adjustedUnitPrice: 9000 },
        ],
      })
      expect(filasDeAjuste()).toHaveLength(1)
      expect(Number(filasDeAjuste()[0].amount)).toBe(30)
    })

    it('un motivo en un renglón SIN descuento ni ajuste no inventa nada', async () => {
      await crear({ items: [{ productId: 'prod-1', quantity: 1, externalId: 'e1', discountReason: 'Error de etiqueta' }] })
      expect(filasDeDescuento()).toHaveLength(0)
      expect(lineasCreadas()[0].id).toBeUndefined()
    })
  })
})
