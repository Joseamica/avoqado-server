import { productosDelSnapshot } from '../../../../src/services/shared/productosDelRecibo'

// D8 (26-oct): el recibo de la terminal guarda los productos en `items`, fuera de `order`; el correo del recibo y el HTML
// legado sólo leían `order.items` y salían sin productos (Codex D8 r1 #3).
describe('productosDelSnapshot', () => {
  it('D1 fotocopia: con la copia del ticket mandan sus renglones, con o sin «parcial»', () => {
    const lineasDelTicket = {
      lineas: [{ nombre: 'Café', cantidad: 1, unitarioCents: 3000, totalCents: 3000, nota: 'sin azúcar' }],
      subtotalCents: 3000,
      descuentoCents: 300,
    }
    const esperado = [{ name: 'Café', quantity: 1, price: 30, totalPrice: 30, weightKg: null, nota: 'sin azúcar', modifiers: [] }]
    const items = [{ productName: 'Agua', quantity: 1, unitPrice: 20, total: 20 }]
    expect(productosDelSnapshot({ items, ticketTotals: { parcial: true, subtotal: 27 }, lineasDelTicket })).toEqual(esperado)
    expect(productosDelSnapshot({ items, ticketTotals: { subtotal: 27 }, lineasDelTicket })).toEqual(esperado)
  })

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

// D15 (28-oct): el recibo de una PARTE (ticketTotals.parcial) pinta un renglón «Pago parcial» con su subtotal, como el papel del cobro.
describe('productosDelSnapshot · parte de una venta dividida (D15)', () => {
  const parcial = { kind: 'COBRO', desglosado: false, parcial: true, subtotal: 15, serviceCharge: 0, addedTax: 0, tip: 2, total: 17 }
  const pagoParcial = [{ name: 'Pago parcial', quantity: 1, price: 15, totalPrice: 15, weightKg: null, modifiers: [] }]

  it('recibo de la terminal de una parte: un renglón «Pago parcial»', () => {
    expect(
      productosDelSnapshot({
        ticketTotals: parcial,
        items: [
          { productName: 'Agua', quantity: 1, unitPrice: 20, total: 20 },
          { productName: 'Café', quantity: 1, unitPrice: 10, total: 10 },
        ],
      }),
    ).toEqual(pagoParcial)
  })

  it('recibo del panel de una parte: también «Pago parcial»', () => {
    expect(productosDelSnapshot({ ticketTotals: parcial, order: { items: [{ name: 'Gorra', quantity: 1, price: 30, totalPrice: 30, modifiers: [] }] } })).toEqual(
      pagoParcial,
    )
  })

  it('sin la marca (venta completa o recibo viejo): sus productos, como hoy', () => {
    const sinMarca = { ...parcial, parcial: undefined, desglosado: false }
    expect(productosDelSnapshot({ ticketTotals: sinMarca, items: [{ productName: 'Agua', quantity: 1, unitPrice: 20, total: 20 }] })).toEqual([
      { name: 'Agua', quantity: 1, price: 20, totalPrice: 20, weightKg: null, modifiers: [] },
    ])
  })

  it('una parte sin productos guardados: lista vacía, como hoy', () => {
    expect(productosDelSnapshot({ ticketTotals: parcial, items: [] })).toEqual([])
  })
})
