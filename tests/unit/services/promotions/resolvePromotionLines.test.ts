import { resolvePromotionLines } from '@/services/promotions/resolvePromotionLines'

const opcion = (over: Partial<Parameters<typeof resolvePromotionLines>[0]['selections'][0]> = {}) => ({
  productId: 'p1',
  quantity: 1,
  chargedQuantity: 1,
  priceDeltaCents: 0,
  listPriceCents: 10000,
  ...over,
})

describe('resolvePromotionLines — el dinero de una promoción, al centavo', () => {
  describe('FIXED_TOTAL: el combo cuesta lo que dice', () => {
    it('las líneas suman EXACTAMENTE el precio de la promoción', () => {
      const r = resolvePromotionLines({
        pricingMode: 'FIXED_TOTAL',
        priceCents: 9900,
        selections: [
          opcion({ productId: 'hamburguesa', listPriceCents: 8000 }),
          opcion({ productId: 'papas', listPriceCents: 4000 }),
          opcion({ productId: 'refresco', listPriceCents: 2000 }),
        ],
      })

      expect(r.netCents).toBe(9900)
      expect(r.lines.reduce((s, l) => s + l.totalCents, 0)).toBe(9900)
    })

    it('🔴 $100 entre 3 productos no pierde ni inventa un centavo', () => {
      // El reparto ingenuo da 33.33+33.33+33.33 = 99.99. Falta un centavo.
      const r = resolvePromotionLines({
        pricingMode: 'FIXED_TOTAL',
        priceCents: 10000,
        selections: [
          opcion({ productId: 'a', listPriceCents: 5000 }),
          opcion({ productId: 'b', listPriceCents: 5000 }),
          opcion({ productId: 'c', listPriceCents: 5000 }),
        ],
      })

      expect(r.lines.reduce((s, l) => s + l.totalCents, 0)).toBe(10000)
      expect(r.lines.reduce((s, l) => s + l.discountCents, 0)).toBe(r.discountCents)
    })

    it('el descuento se reparte PROPORCIONAL al bruto, no en partes iguales', () => {
      // 🔴 Partes iguales le movería la base gravable a un producto 0% frente
      // a uno 16%. Bruto 140 → neto 100 → descuento 40, o sea 28.57% de cada uno.
      const r = resolvePromotionLines({
        pricingMode: 'FIXED_TOTAL',
        priceCents: 10000,
        selections: [
          opcion({ productId: 'a', listPriceCents: 8000 }),
          opcion({ productId: 'b', listPriceCents: 4000 }),
          opcion({ productId: 'c', listPriceCents: 2000 }),
        ],
      })

      expect(r.lines.map(l => l.totalCents)).toEqual([5714, 2857, 1429])
      expect(r.lines.reduce((s, l) => s + l.totalCents, 0)).toBe(10000)
    })

    it('el priceDelta de la opción elegida sube el precio de la promoción', () => {
      const r = resolvePromotionLines({
        pricingMode: 'FIXED_TOTAL',
        priceCents: 9900,
        selections: [
          opcion({ productId: 'pollo', listPriceCents: 9000, priceDeltaCents: 1500 }),
          opcion({ productId: 'papas', listPriceCents: 4000 }),
        ],
      })

      expect(r.netCents).toBe(11400)
      expect(r.lines.reduce((s, l) => s + l.totalCents, 0)).toBe(11400)
    })

    it('cada línea conserva su precio BRUTO de catálogo', () => {
      const r = resolvePromotionLines({
        pricingMode: 'FIXED_TOTAL',
        priceCents: 9900,
        selections: [opcion({ productId: 'a', listPriceCents: 8000 }), opcion({ productId: 'b', listPriceCents: 4000 })],
      })

      expect(r.lines.map(l => l.unitPriceCents)).toEqual([8000, 4000])
      expect(r.grossCents).toBe(12000)
    })
  })

  describe('PER_UNIT: el 2x1', () => {
    it('entran 2 unidades y se cobra 1', () => {
      const r = resolvePromotionLines({
        pricingMode: 'PER_UNIT',
        priceCents: 0,
        selections: [opcion({ productId: 'cerveza', quantity: 2, chargedQuantity: 1, listPriceCents: 5000 })],
      })

      expect(r.lines).toHaveLength(1)
      expect(r.lines[0].quantity).toBe(2) // 🔴 el inventario descuenta por aquí
      expect(r.lines[0].unitPriceCents).toBe(5000)
      expect(r.lines[0].discountCents).toBe(5000)
      expect(r.lines[0].totalCents).toBe(5000)
      expect(r.netCents).toBe(5000)
    })

    it('un 3x2 cobra dos de tres', () => {
      const r = resolvePromotionLines({
        pricingMode: 'PER_UNIT',
        priceCents: 0,
        selections: [opcion({ productId: 'cerveza', quantity: 3, chargedQuantity: 2, listPriceCents: 5000 })],
      })

      expect(r.lines[0].quantity).toBe(3)
      expect(r.netCents).toBe(10000)
    })

    it('en PER_UNIT el priceDelta se ignora — el precio ya sale del producto', () => {
      const r = resolvePromotionLines({
        pricingMode: 'PER_UNIT',
        priceCents: 0,
        selections: [opcion({ productId: 'cerveza', quantity: 2, chargedQuantity: 1, listPriceCents: 5000, priceDeltaCents: 3000 })],
      })

      expect(r.netCents).toBe(5000)
    })
  })

  describe('bordes que protegen al local', () => {
    it('una promoción más cara que el catálogo no genera descuento negativo', () => {
      const r = resolvePromotionLines({
        pricingMode: 'FIXED_TOTAL',
        priceCents: 15000,
        selections: [opcion({ productId: 'a', listPriceCents: 10000 })],
      })

      expect(r.discountCents).toBe(0)
      expect(r.netCents).toBe(10000) // nunca se cobra MÁS que el catálogo
    })

    it('sin opciones no hay promoción que resolver', () => {
      const r = resolvePromotionLines({ pricingMode: 'FIXED_TOTAL', priceCents: 9900, selections: [] })

      expect(r.lines).toEqual([])
      expect(r.netCents).toBe(0)
      expect(r.discountCents).toBe(0)
    })

    it('una promoción gratis deja todas las líneas en cero', () => {
      const r = resolvePromotionLines({
        pricingMode: 'FIXED_TOTAL',
        priceCents: 0,
        selections: [opcion({ productId: 'a', listPriceCents: 8000 }), opcion({ productId: 'b', listPriceCents: 4000 })],
      })

      expect(r.netCents).toBe(0)
      expect(r.lines.every(l => l.totalCents === 0)).toBe(true)
    })

    it('dos opciones del MISMO producto se mantienen como líneas separadas', () => {
      // No se fusionan: cada opción es un renglón de la promoción y su
      // prorrata se calcula por separado.
      const r = resolvePromotionLines({
        pricingMode: 'FIXED_TOTAL',
        priceCents: 10000,
        selections: [opcion({ productId: 'a', listPriceCents: 6000 }), opcion({ productId: 'a', listPriceCents: 6000 })],
      })

      expect(r.lines).toHaveLength(2)
      expect(r.lines.reduce((s, l) => s + l.totalCents, 0)).toBe(10000)
    })
  })
})
