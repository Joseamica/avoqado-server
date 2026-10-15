// tests/unit/services/online-ordering/quote.service.test.ts
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/online-ordering/menu.service', () => ({
  ...jest.requireActual('@/services/online-ordering/menu.service'),
  loadCategoryVisibility: jest.fn(),
}))
jest.mock('@/services/online-ordering/settings.service', () => ({ __esModule: true, getSettings: jest.fn() }))

import { loadCategoryVisibility } from '@/services/online-ordering/menu.service'
import { getSettings } from '@/services/online-ordering/settings.service'
import { quoteCart, toPublicQuote } from '@/services/online-ordering/quote.service'

const D = (v: string) => new Prisma.Decimal(v)
const mod = (id: string, price: string) => ({ id, name: `mod-${id}`, price: D(price) })
const group = (o: Record<string, unknown> = {}) => ({
  group: {
    id: 'g1',
    name: 'Salsa',
    required: true,
    allowMultiple: false,
    minSelections: 1,
    maxSelections: 1,
    modifiers: [mod('m1', '0.00'), mod('m2', '10.00')],
    ...o,
  },
})
const flautas = {
  id: 'p-flautas',
  name: 'Flautas de pollo',
  sku: 'FLA-1',
  description: null,
  price: D('93.00'),
  imageUrl: null,
  categoryId: 'c1',
  category: { name: 'Flautas', availableFrom: '08:00', availableUntil: '23:00', availableDays: [] },
  modifierGroups: [group()],
}
const agua = {
  id: 'p-agua',
  name: 'Agua',
  sku: 'AGU-1',
  description: null,
  price: D('30.00'),
  imageUrl: null,
  categoryId: 'c2',
  category: { name: 'Bebidas', availableFrom: null, availableUntil: null, availableDays: [] },
  modifierGroups: [],
}
let ROWS: any[] = []

beforeEach(() => {
  ROWS = [flautas, agua]
  prismaMock.product.findMany.mockImplementation((async (a: any) => ROWS.filter(r => a.where.id.in.includes(r.id))) as any)
  ;(loadCategoryVisibility as jest.Mock).mockResolvedValue(() => true)
  ;(getSettings as jest.Mock).mockResolvedValue({ minOrderAmount: 0 })
})

describe('quoteCart', () => {
  it('suma precio + extras × cantidad, en pesos exactos, y lleva la categoría del renglón', async () => {
    const q = await quoteCart('v1', [{ productId: 'p-flautas', quantity: 2, modifiers: [{ modifierId: 'm2' }] }])
    expect(q.ok).toBe(true)
    // (93 + 10) × 2
    expect(q.lines[0].lineTotal.toFixed(2)).toBe('206.00')
    expect(q.lines[0].categoryName).toBe('Flautas')
    expect(q.subtotal.toFixed(2)).toBe('206.00')
    expect(q.total.toFixed(2)).toBe('206.00')
  })

  it('el mismo platillo con extras distintos son dos renglones', async () => {
    const q = await quoteCart('v1', [
      { productId: 'p-flautas', quantity: 1, modifiers: [{ modifierId: 'm1' }] },
      { productId: 'p-flautas', quantity: 1, modifiers: [{ modifierId: 'm2' }] },
    ])
    expect(q.ok).toBe(true)
    expect(q.lines).toHaveLength(2)
    expect(q.total.toFixed(2)).toBe('196.00')
  })

  it('consulta DIRECTO los productos pedidos con todos sus grupos; no usa la carta recortada (R17); evalúa sólo sus categorías con su horario propio (H4)', async () => {
    await quoteCart('v1', [
      { productId: 'p-flautas', quantity: 1, modifiers: [{ modifierId: 'm1' }] },
      { productId: 'p-flautas', quantity: 1, modifiers: [{ modifierId: 'm2' }] },
    ])
    const args = prismaMock.product.findMany.mock.calls[0][0] as any
    expect(args.where).toMatchObject({
      venueId: 'v1',
      id: { in: ['p-flautas'] },
      availableOnline: true,
      soldByWeight: false,
      category: { active: true },
    })
    expect(args.take).toBe(50)
    expect(args.select.modifierGroups.take).toBe(21)
    expect(prismaMock.menuCategory.findMany).not.toHaveBeenCalled()
    expect(loadCategoryVisibility).toHaveBeenCalledWith('v1', expect.any(Date), [
      { id: 'c1', availableFrom: '08:00', availableUntil: '23:00', availableDays: [] },
    ])
  })

  it('un producto que no se vende en línea o es de otro negocio es PRODUCT_UNAVAILABLE', async () => {
    const q = await quoteCart('v1', [{ productId: 'otro-negocio', quantity: 1 }])
    expect(q.ok).toBe(false)
    expect(q.issues[0]).toMatchObject({ code: 'PRODUCT_UNAVAILABLE', productId: 'otro-negocio' })
  })

  it('con un grupo OBLIGATORIO más allá del tope de grupos, el renglón no se cotiza a medias (R17)', async () => {
    const opcional = (i: number) => group({ id: `g${i}`, required: false, minSelections: 0, modifiers: [mod(`x${i}`, '0.00')] })
    ROWS = [{ ...flautas, modifierGroups: [...Array.from({ length: 20 }, (_, i) => opcional(i)), group({ id: 'g-obligatorio' })] }]
    const q = await quoteCart('v1', [{ productId: 'p-flautas', quantity: 1 }])
    expect(q.ok).toBe(false)
    expect(q.issues[0]).toMatchObject({ code: 'PRODUCT_UNAVAILABLE', productId: 'p-flautas' })
  })

  it('un producto de una categoría cuyo menú no aplica ahora es PRODUCT_UNAVAILABLE', async () => {
    ;(loadCategoryVisibility as jest.Mock).mockResolvedValue(() => false)
    const q = await quoteCart('v1', [{ productId: 'p-agua', quantity: 1 }])
    expect(q.issues[0]).toMatchObject({ code: 'PRODUCT_UNAVAILABLE' })
  })

  it('un extra ajeno al producto es MODIFIER_INVALID y no inventa precio', async () => {
    const q = await quoteCart('v1', [{ productId: 'p-flautas', quantity: 1, modifiers: [{ modifierId: 'de-otro-producto' }] }])
    expect(q.ok).toBe(false)
    expect(q.issues.map(i => i.code)).toContain('MODIFIER_INVALID')
  })

  it('un grupo requerido sin selección es MODIFIER_GROUP_REQUIRED', async () => {
    const q = await quoteCart('v1', [{ productId: 'p-flautas', quantity: 1 }])
    expect(q.ok).toBe(false)
    expect(q.issues[0]).toMatchObject({ code: 'MODIFIER_GROUP_REQUIRED', groupId: 'g1' })
  })

  it('un grupo de selección única no admite dos opciones', async () => {
    const q = await quoteCart('v1', [{ productId: 'p-flautas', quantity: 1, modifiers: [{ modifierId: 'm1' }, { modifierId: 'm2' }] }])
    expect(q.ok).toBe(false)
    expect(q.issues.map(i => i.code)).toContain('MODIFIER_GROUP_SINGLE')
  })

  it('respeta el máximo de selecciones de un grupo múltiple', async () => {
    ROWS = [
      {
        ...flautas,
        modifierGroups: [
          group({
            allowMultiple: true,
            required: false,
            minSelections: 0,
            maxSelections: 1,
            modifiers: [mod('m1', '5.00'), mod('m2', '5.00')],
          }),
        ],
      },
    ]
    const q = await quoteCart('v1', [{ productId: 'p-flautas', quantity: 1, modifiers: [{ modifierId: 'm1' }, { modifierId: 'm2' }] }])
    expect(q.issues.map(i => i.code)).toContain('MODIFIER_GROUP_MAX')
  })

  it('rechaza cantidades fuera de rango y carritos vacíos', async () => {
    expect((await quoteCart('v1', [{ productId: 'p-agua', quantity: 0 }])).issues[0].code).toBe('QUANTITY_INVALID')
    expect((await quoteCart('v1', [{ productId: 'p-agua', quantity: 21 }])).issues[0].code).toBe('QUANTITY_INVALID')
    expect((await quoteCart('v1', [])).issues[0].code).toBe('EMPTY_CART')
  })

  it('avisa si no llega al mínimo del negocio', async () => {
    ;(getSettings as jest.Mock).mockResolvedValue({ minOrderAmount: 100 })
    const q = await quoteCart('v1', [{ productId: 'p-agua', quantity: 1 }])
    expect(q.ok).toBe(false)
    expect(q.issues[0]).toMatchObject({ code: 'BELOW_MINIMUM' })
    expect(q.minOrderAmount.toFixed(2)).toBe('100.00')
  })

  it('recorta la nota a 300 caracteres', async () => {
    const q = await quoteCart('v1', [{ productId: 'p-agua', quantity: 1, note: 'x'.repeat(500) }])
    expect(q.lines[0].note).toHaveLength(300)
  })

  it('toPublicQuote entrega números en pesos con 2 decimales', async () => {
    const q = await quoteCart('v1', [{ productId: 'p-agua', quantity: 2 }])
    const pub = toPublicQuote(q)
    expect(pub.total).toBe(60)
    expect(pub.lines[0]).toMatchObject({ productId: 'p-agua', quantity: 2, unitPrice: 30, lineTotal: 60 })
  })
})
