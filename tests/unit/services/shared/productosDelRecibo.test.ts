import { productosDelSnapshot } from '../../../../src/services/shared/productosDelRecibo'

// D8 (26-oct): el recibo de la terminal guarda los productos en `items`, fuera de `order`; el correo del recibo y el HTML
// legado sólo leían `order.items` y salían sin productos (Codex D8 r1 #3).
describe('productosDelSnapshot', () => {
  it('recibo de la terminal: traduce `items` al formato del correo y del HTML', () => {
    expect(
      productosDelSnapshot({
        order: { total: 50 },
        items: [{ productName: 'Queso Oaxaca', quantity: 1, unitPrice: 100, total: 50, weightKg: 0.5, modifiers: [{ name: 'Extra', quantity: 2, price: 10 }] }],
      }),
    ).toEqual([{ name: 'Queso Oaxaca', quantity: 1, price: 100, totalPrice: 50, weightKg: 0.5, modifiers: [{ name: 'Extra', price: 10, quantity: 2 }] }])
  })

  it('recibo del panel: conserva `order.items`', () => {
    const delPanel = [{ name: 'Gorra', quantity: 1, price: 400, totalPrice: 400, modifiers: [] }]
    expect(productosDelSnapshot({ order: { items: delPanel }, items: [{ productName: 'Otro', quantity: 1, unitPrice: 1, total: 1 }] })).toBe(delPanel)
  })

  it('sin productos o sin snapshot: lista vacía', () => {
    expect(productosDelSnapshot({ order: { items: [] } })).toEqual([])
    expect(productosDelSnapshot(null)).toEqual([])
  })
})
