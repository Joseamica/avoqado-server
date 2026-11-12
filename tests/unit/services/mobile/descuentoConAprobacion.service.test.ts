/**
 * D4 (hz:f34960c5:D4): un % o fijo de catálogo con «Requiere aprobación» sólo entra con la acreditación que la ruta deja en el
 * request (`tpv-orders:discount` propio o el PIN de un gerente). El servicio la vuelve a exigir bajo su candado (falla cerrado) y
 * guarda quién lo aplicó y quién lo aprobó. Lo que no pide aprobación sigue exactamente igual.
 *
 * Doble EN MEMORIA con estado (como `orderLevelDiscountSurvivesRecalc.test.ts`): la creación y el descuento reales escriben y
 * leen las mismas filas.
 */
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))

import { Prisma } from '@prisma/client'
import { ForbiddenError } from '@/errors/AppError'
import { applyOrderDiscount, buildOrderItemsData, createOrderWithItems } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

type Fila = Record<string, any>

const VENUE = 'venue-1'
const APROBACION = 'desc-gerente' // 10 %, «Requiere aprobación»
const LIBRE = 'desc-libre' // 10 %, sin aprobación
const RENGLON_APROBACION = 'desc-renglon-gerente'

const aNumero = (v: any) => (v && typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : v)

function coincide(fila: Fila, where: Fila = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v !== null && typeof v === 'object' && !(v instanceof Date))
      throw new Error(`doble en memoria: operador no soportado en where.${k}`)
    return fila[k] === v
  })
}

const catalogo: Record<string, Fila> = {
  [APROBACION]: {
    id: APROBACION,
    venueId: VENUE,
    name: '10% gerencial',
    type: 'PERCENTAGE',
    value: 10,
    scope: 'ORDER',
    active: true,
    requiresApproval: true,
  },
  [LIBRE]: {
    id: LIBRE,
    venueId: VENUE,
    name: '10% frecuente',
    type: 'PERCENTAGE',
    value: 10,
    scope: 'ORDER',
    active: true,
    requiresApproval: false,
  },
}

function baseEnMemoria() {
  const ordenes = new Map<string, Fila>()
  const renglones: Fila[] = []
  const descuentos: Fila[] = []
  let seq = 0
  const nuevoId = (p: string) => `${p}-${++seq}`
  const plano = (o: Fila) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, aNumero(v)]))
  const conRenglones = (o: Fila) => ({
    ...o,
    items: renglones.filter(r => r.orderId === o.id).map(r => ({ ...r, product: null, modifiers: [] })),
    promotions: [],
  })
  const buscarOrden = async ({ where }: any) => {
    if (where.venueId_externalId) return null
    const o = ordenes.get(where.id)
    return o && (!where.venueId || o.venueId === where.venueId) ? conRenglones(o) : null
  }
  prismaMock.order.findUnique.mockImplementation(buscarOrden)
  prismaMock.order.findFirst.mockImplementation(buscarOrden)
  prismaMock.order.create.mockImplementation(async ({ data }: any) => {
    const { items, ...cabecera } = data
    delete cabecera.orderCustomers
    const o = { id: nuevoId('orden'), paidAmount: 0, serviceChargeAmount: 0, ...plano(cabecera) }
    ordenes.set(o.id, o)
    for (const r of items?.create ?? []) renglones.push({ id: nuevoId('renglon'), orderId: o.id, orderPromotionId: null, ...plano(r) })
    return conRenglones(o)
  })
  prismaMock.order.update.mockImplementation(async ({ where, data }: any) => {
    const o = ordenes.get(where.id)!
    for (const [k, v] of Object.entries(data as Fila))
      o[k] = k === 'version' && typeof v === 'object' ? (o.version ?? 0) + v.increment : aNumero(v)
    return conRenglones(o)
  })
  prismaMock.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...valores: any[]) => {
    if (!strings.join('?').includes('FOR UPDATE')) throw new Error('doble en memoria: $queryRaw no soportado')
    const [orderId, venueId] = valores
    const o = ordenes.get(orderId)
    return o && o.venueId === venueId ? [{ id: orderId }] : []
  })
  prismaMock.orderItem.findMany.mockImplementation(async ({ where }: any) => renglones.filter(r => coincide(r, where)))
  prismaMock.orderServiceCharge.findMany.mockResolvedValue([])
  prismaMock.orderDiscount.findMany.mockImplementation(async ({ where }: any) => descuentos.filter(d => coincide(d, where)))
  prismaMock.orderDiscount.findFirst.mockImplementation(async ({ where }: any) => descuentos.find(d => coincide(d, where)) ?? null)
  prismaMock.orderDiscount.create.mockImplementation(async ({ data }: any) => {
    const fila = { id: nuevoId('od'), appliedToItemIds: [], discountId: null, ...plano(data) }
    descuentos.push(fila)
    return fila
  })
  prismaMock.orderDiscount.update.mockImplementation(async ({ where, data }: any) => {
    const fila = descuentos.find(d => d.id === where.id)
    Object.assign(fila!, plano(data))
    return fila
  })
  prismaMock.venue.findUnique.mockResolvedValue({ id: VENUE, name: 'Tienda de prueba', salesEnabled: true })
  // La membresía de cada persona en el negocio: la vendedora (`staff-1`) y la sesión que cobra (`sesion-1`).
  prismaMock.staffVenue.findFirst.mockImplementation(async ({ where }: any) =>
    where.venueId === VENUE ? { id: `sv-${where.staffId}`, staffId: where.staffId, venueId: VENUE, active: true, staff: {} } : null,
  )
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.discount.findFirst.mockImplementation(async ({ where }: any) => {
    const d = catalogo[where.id]
    return d && d.venueId === where.venueId ? { ...d, value: new Prisma.Decimal(d.value) } : null
  })
  return { descuentos, ordenes: () => [...ordenes.values()] }
}

/** Una venta de $100 en un renglón «Otro importe». */
const venta = (extra: Fila = {}) =>
  ({ staffId: 'staff-1', items: [{ name: 'Otro importe', quantity: 1, unitPrice: 10000 }], ...extra }) as any

async function cuentaAbierta(db: ReturnType<typeof baseEnMemoria>) {
  const creada = await createOrderWithItems(VENUE, venta())
  return { id: creada.id, filas: () => db.descuentos.filter(d => d.orderId === creada.id) }
}

describe('D4 · Mesas: aplicar un % o fijo que pide aprobación a la cuenta abierta', () => {
  it('sin acreditación: 403 PERMISSION_DENIED y la cuenta no cambia', async () => {
    const db = baseEnMemoria()
    const cuenta = await cuentaAbierta(db)
    const intento = applyOrderDiscount(VENUE, cuenta.id, APROBACION, 'sesion-1')
    await expect(intento).rejects.toBeInstanceOf(ForbiddenError)
    await expect(applyOrderDiscount(VENUE, cuenta.id, APROBACION, 'sesion-1')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(cuenta.filas()).toEqual([])
  })

  it('con el PIN de un gerente: entra y guarda quién lo aplicó y quién lo aprobó', async () => {
    const db = baseEnMemoria()
    const cuenta = await cuentaAbierta(db)
    const r = await applyOrderDiscount(VENUE, cuenta.id, APROBACION, 'sesion-1', false, { porPin: 'sv-gerente' })
    expect(r.amount).toBe(10)
    expect(cuenta.filas()).toEqual([
      expect.objectContaining({ discountId: APROBACION, appliedById: 'sv-sesion-1', authorizedById: 'sv-gerente' }),
    ])
  })

  it('con el permiso propio (sin PIN): la sesión queda como quien lo aprobó', async () => {
    const db = baseEnMemoria()
    const cuenta = await cuentaAbierta(db)
    await applyOrderDiscount(VENUE, cuenta.id, APROBACION, 'sesion-1', false, {})
    expect(cuenta.filas()).toEqual([expect.objectContaining({ authorizedById: 'sv-sesion-1' })])
  })

  it('regresión: un % sin «Requiere aprobación» entra sin acreditación y sin aprobador', async () => {
    const db = baseEnMemoria()
    const cuenta = await cuentaAbierta(db)
    const r = await applyOrderDiscount(VENUE, cuenta.id, LIBRE, 'sesion-1')
    expect(r.amount).toBe(10)
    const [fila] = cuenta.filas()
    expect(fila.authorizedById ?? null).toBeNull()
    expect(fila.appliedById).toBe('sv-sesion-1')
  })
})

describe('D4 · Mostrador: la venta nueva con un descuento que pide aprobación', () => {
  it('la etiqueta del descuento de cuenta (importe libre) sin acreditación: 403 y no nace la venta', async () => {
    const db = baseEnMemoria()
    await expect(
      createOrderWithItems(VENUE, venta({ discount: 1000, descuentoDeCatalogoId: APROBACION, performedBy: 'sesion-1' })),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(db.ordenes()).toEqual([])
  })

  it('la etiqueta con el PIN de un gerente: el importe sigue siendo el de la caja y la fila guarda al aprobador', async () => {
    const db = baseEnMemoria()
    const creada = await createOrderWithItems(
      VENUE,
      venta({
        discount: 1000,
        descuentoDeCatalogoId: APROBACION,
        performedBy: 'sesion-1',
        aprobacionDelDescuento: { porPin: 'sv-gerente' },
      }),
    )
    const filas = db.descuentos.filter(d => d.orderId === creada.id)
    // Codex r2 #4: quien lo aplicó es la sesión (`sesion-1`), no la vendedora elegida (`staff-1`).
    expect(filas).toEqual([
      expect.objectContaining({ name: 'Descuento de la cuenta', amount: 10, appliedById: 'sv-sesion-1', authorizedById: 'sv-gerente' }),
    ])
  })

  it('regresión: la etiqueta de un % sin aprobación no pide nada ni pone aprobador', async () => {
    const db = baseEnMemoria()
    const creada = await createOrderWithItems(VENUE, venta({ discount: 1000, descuentoDeCatalogoId: LIBRE, performedBy: 'sesion-1' }))
    const [fila] = db.descuentos.filter(d => d.orderId === creada.id)
    expect(fila.amount).toBe(10)
    expect(fila.authorizedById ?? null).toBeNull()
  })

  it('`orderDiscountId` (cola de la TPV) que pide aprobación: sin acreditación 403; con permiso propio, aprobador = la sesión', async () => {
    const db = baseEnMemoria()
    await expect(createOrderWithItems(VENUE, venta({ orderDiscountId: APROBACION, performedBy: 'sesion-1' }))).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    const creada = await createOrderWithItems(
      VENUE,
      venta({ orderDiscountId: APROBACION, performedBy: 'sesion-1', aprobacionDelDescuento: {} }),
    )
    expect(db.descuentos.filter(d => d.orderId === creada.id)).toEqual([
      expect.objectContaining({ discountId: APROBACION, authorizedById: 'sv-sesion-1' }),
    ])
  })
})

describe('D4 · el descuento de un RENGLÓN (también vales): `buildOrderItemsData` falla cerrado', () => {
  const producto = {
    id: 'prod-1',
    venueId: VENUE,
    name: 'Playera',
    price: new Prisma.Decimal(100),
    categoryId: 'cat-1',
    category: { name: 'Ropa' },
  }
  const delRenglon = {
    id: RENGLON_APROBACION,
    venueId: VENUE,
    name: '$20 gerencial',
    type: 'FIXED_AMOUNT',
    value: new Prisma.Decimal(20),
    scope: 'ITEM',
    targetItemIds: [],
    targetCategoryIds: [],
    active: true,
    requiresApproval: true,
  }
  const items = [{ productId: 'prod-1', quantity: 1, discountId: RENGLON_APROBACION }] as any

  beforeEach(() => {
    prismaMock.product.findMany.mockResolvedValue([producto] as any)
    prismaMock.modifier.findMany.mockResolvedValue([])
    prismaMock.discount.findMany.mockResolvedValue([delRenglon] as any)
  })

  it('sin acreditación: 403 PERMISSION_DENIED', async () => {
    await expect(
      buildOrderItemsData(VENUE, items, undefined, undefined, prismaMock as any, { performedBy: 'sesion-1' }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
  })

  it('con acreditación: calcula el renglón como siempre', async () => {
    const r = await buildOrderItemsData(VENUE, items, undefined, undefined, prismaMock as any, {
      performedBy: 'sesion-1',
      aprobacionDelDescuento: {},
    })
    expect(r.itemDiscountTotal).toBe(20)
  })

  it('regresión: un descuento de renglón sin aprobación no pide nada', async () => {
    prismaMock.discount.findMany.mockResolvedValue([{ ...delRenglon, requiresApproval: false }] as any)
    const r = await buildOrderItemsData(VENUE, items, undefined, undefined, prismaMock as any, {})
    expect(r.itemDiscountTotal).toBe(20)
  })
})
