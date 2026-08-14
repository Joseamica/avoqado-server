import { validatePromotionForPublish } from '@/services/promotions/validatePromotion'

const base = () => ({
  venueId: 'venue-1',
  type: 'BUNDLE' as const,
  pricingMode: 'FIXED_TOTAL' as const,
  priceCents: 9900,
  groups: [
    {
      name: 'Plato',
      minSelect: 1,
      maxSelect: 1,
      options: [{ productId: 'p1', productVenueId: 'venue-1', productActive: true, quantity: 1, chargedQuantity: 1, priceDeltaCents: 0 }],
    },
  ],
})

describe('validatePromotionForPublish — qué NO se publica', () => {
  it('un bundle bien armado se publica', () => {
    expect(validatePromotionForPublish(base())).toEqual({ ok: true })
  })

  it('🔴 un producto de OTRO venue nunca se publica', () => {
    const draft = base()
    draft.groups[0].options[0].productVenueId = 'venue-ajeno'

    expect(validatePromotionForPublish(draft)).toEqual({
      ok: false,
      errors: ['El producto p1 no pertenece a este establecimiento.'],
    })
  })

  it('un producto inactivo no se publica', () => {
    const draft = base()
    draft.groups[0].options[0].productActive = false

    expect(validatePromotionForPublish(draft)).toEqual({ ok: false, errors: ['El producto p1 está desactivado.'] })
  })

  it('un grupo sin opciones no se publica', () => {
    const draft = base()
    draft.groups[0].options = []

    expect(validatePromotionForPublish(draft)).toEqual({ ok: false, errors: ['El grupo "Plato" no tiene opciones.'] })
  })

  it('🔴 chargedQuantity mayor que quantity regalaría al revés', () => {
    const draft = base()
    draft.groups[0].options[0].chargedQuantity = 2

    expect(validatePromotionForPublish(draft)).toEqual({
      ok: false,
      errors: ['El producto p1 cobra más unidades de las que entrega.'],
    })
  })

  it('quantity cero no se publica', () => {
    const draft = base()
    draft.groups[0].options[0].quantity = 0

    expect(validatePromotionForPublish(draft)).toEqual({ ok: false, errors: ['El producto p1 debe entregar al menos una unidad.'] })
  })

  it('un precio negativo no se publica', () => {
    expect(validatePromotionForPublish({ ...base(), priceCents: -100 })).toEqual({
      ok: false,
      errors: ['El precio de la promoción no puede ser negativo.'],
    })
  })

  it('un priceDelta negativo no se publica', () => {
    const draft = base()
    draft.groups[0].options[0].priceDeltaCents = -500

    expect(validatePromotionForPublish(draft)).toEqual({ ok: false, errors: ['El sobreprecio del producto p1 no puede ser negativo.'] })
  })

  it('🔴 un BUNDLE con un grupo de varias opciones es en realidad un COMBO', () => {
    const draft = base()
    draft.groups[0].options.push({
      productId: 'p2',
      productVenueId: 'venue-1',
      productActive: true,
      quantity: 1,
      chargedQuantity: 1,
      priceDeltaCents: 0,
    })

    expect(validatePromotionForPublish(draft)).toEqual({
      ok: false,
      errors: ['Un bundle no puede tener grupos con varias opciones. Márcala como combo.'],
    })
  })

  it('un COMBO necesita al menos un grupo con varias opciones', () => {
    expect(validatePromotionForPublish({ ...base(), type: 'COMBO' })).toEqual({
      ok: false,
      errors: ['Un combo necesita al menos un grupo con más de una opción. Márcala como bundle.'],
    })
  })

  it('v1: elegir más de una opción por grupo no se publica', () => {
    const draft = base()
    draft.groups[0].maxSelect = 2

    expect(validatePromotionForPublish(draft)).toEqual({
      ok: false,
      errors: ['Por ahora cada grupo permite elegir exactamente una opción.'],
    })
  })

  it('un DISCOUNT no lleva grupos', () => {
    expect(validatePromotionForPublish({ ...base(), type: 'DISCOUNT' })).toEqual({
      ok: false,
      errors: ['Una promoción de descuento no lleva grupos de productos.'],
    })
  })

  it('🔴 un chargedQuantity NEGATIVO no se publica — generaría descuento fantasma', () => {
    // Audit 2026-08-13 (Codex): -1 producía un target net de -$50 → descuento
    // de $100 y línea negativa. El validador sólo cubría "cobra más que entrega".
    const draft = base()
    draft.groups[0].options[0].chargedQuantity = -1

    expect(validatePromotionForPublish(draft)).toEqual({
      ok: false,
      errors: ['El producto p1 no puede cobrar una cantidad negativa.'],
    })
  })

  it('🔴 un BUNDLE sin grupos no se publica — sería una promoción de cero líneas', () => {
    expect(validatePromotionForPublish({ ...base(), groups: [] })).toEqual({
      ok: false,
      errors: ['La promoción necesita al menos un grupo de productos.'],
    })
  })

  it('un COMBO sin grupos tampoco se publica', () => {
    expect(validatePromotionForPublish({ ...base(), type: 'COMBO', groups: [] })).toEqual({
      ok: false,
      errors: ['La promoción necesita al menos un grupo de productos.'],
    })
  })

  it('se reportan TODOS los errores juntos, no el primero', () => {
    const draft = base()
    draft.groups[0].options[0].quantity = 0
    draft.priceCents = -1

    const result = validatePromotionForPublish(draft)
    expect(result.ok).toBe(false)
    expect((result as { errors: string[] }).errors).toHaveLength(2)
  })
})
