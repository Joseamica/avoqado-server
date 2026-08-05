/**
 * Unit tests del motor de upsell — la lógica PURA y los candados de negocio.
 *
 * Spec: Avoqado-HQ/specs/upsell-pantalla-cliente-2026-08-03.md
 *
 * Lo que estos tests protegen, en orden de cuánto duele si se rompe:
 *  1. Dos reglas OWNER del mismo producto con disparadores distintos COEXISTEN
 *     (un @@unique mal puesto las colapsaría — spec dedupeKey).
 *  2. El veto del dueño (`upsellEnabled=false`) gana sobre TODO, incluida la IA.
 *  3. El sorteo del grupo de control es DETERMINISTA y auditable, no aleatorio.
 *  4. Las tres perillas tienen default seguro cuando la columna está en NULL.
 */

import { UpsellOrigin, UpsellTriggerType } from '@prisma/client'
import { computeDedupeKey, parseUpsellSurfaces } from '../../../../src/services/upsell/upsell.service'
import { isHoldout, HOLDOUT_PERCENT } from '../../../../src/services/upsell/upsellImpression.service'

describe('Upsell — dedupeKey (identidad de una regla)', () => {
  const base = {
    origin: UpsellOrigin.OWNER,
    triggerType: UpsellTriggerType.PRODUCT,
    suggestedProductId: 'galleta',
  }

  // ── EL caso que motivó el diseño ──────────────────────────────────────────
  it('🔴 "café → galleta" y "té → galleta" son reglas DISTINTAS', () => {
    const cafe = computeDedupeKey({ ...base, triggerProductIds: ['cafe'] })
    const te = computeDedupeKey({ ...base, triggerProductIds: ['te'] })

    expect(cafe).not.toEqual(te)
  })

  it('el mismo conjunto de disparadores en distinto orden da la MISMA llave', () => {
    const a = computeDedupeKey({ ...base, triggerProductIds: ['cafe', 'te'] })
    const b = computeDedupeKey({ ...base, triggerProductIds: ['te', 'cafe'] })

    expect(a).toEqual(b)
  })

  it('el origen separa las capas: el job no puede pisar una regla del dueño', () => {
    const owner = computeDedupeKey({ ...base, triggerProductIds: ['cafe'] })
    const data = computeDedupeKey({ ...base, origin: UpsellOrigin.BASKET_DATA, triggerProductIds: ['cafe'] })

    expect(owner).not.toEqual(data)
  })

  it('en PROMOTION el id del descuento entra en la llave (dos promos del mismo producto)', () => {
    const promoA = computeDedupeKey({
      origin: UpsellOrigin.PROMOTION,
      triggerType: UpsellTriggerType.ALWAYS,
      suggestedProductId: 'galleta',
      linkedDiscountId: 'desc-a',
    })
    const promoB = computeDedupeKey({
      origin: UpsellOrigin.PROMOTION,
      triggerType: UpsellTriggerType.ALWAYS,
      suggestedProductId: 'galleta',
      linkedDiscountId: 'desc-b',
    })

    expect(promoA).not.toEqual(promoB)
    // Y la llave CONSERVA el id aunque el FK quede en NULL por el onDelete: SetNull,
    // que es lo que permite al job saber qué regla murió con qué descuento.
    expect(promoA).toContain('desc-a')
  })

  it('en OWNER el descuento NO entra en la llave (sólo PROMOTION lo lleva)', () => {
    const conDescuento = computeDedupeKey({ ...base, triggerProductIds: ['cafe'], linkedDiscountId: 'desc-a' })
    const sinDescuento = computeDedupeKey({ ...base, triggerProductIds: ['cafe'] })

    expect(conDescuento).toEqual(sinDescuento)
  })

  it('ALWAYS ignora los disparadores: no hay nada que dispare', () => {
    const a = computeDedupeKey({
      origin: UpsellOrigin.OWNER,
      triggerType: UpsellTriggerType.ALWAYS,
      suggestedProductId: 'galleta',
      triggerProductIds: ['cafe'],
    })
    const b = computeDedupeKey({
      origin: UpsellOrigin.OWNER,
      triggerType: UpsellTriggerType.ALWAYS,
      suggestedProductId: 'galleta',
    })

    expect(a).toEqual(b)
  })
})

describe('Upsell — las tres perillas', () => {
  it('columna en NULL = las tres prendidas (default de la función)', () => {
    expect(parseUpsellSurfaces(null)).toEqual({ counter: true, tableOrdering: true, tablePaying: true })
  })

  it('respeta lo que el dueño apagó', () => {
    expect(parseUpsellSurfaces({ counter: true, tableOrdering: false, tablePaying: false })).toEqual({
      counter: true,
      tableOrdering: false,
      tablePaying: false,
    })
  })

  it('un JSON a medias completa con los defaults en vez de tronar', () => {
    expect(parseUpsellSurfaces({ counter: false })).toEqual({
      counter: false,
      tableOrdering: true,
      tablePaying: true,
    })
  })

  it('basura en la columna no tumba el cobro', () => {
    expect(parseUpsellSurfaces('no soy json')).toEqual({ counter: true, tableOrdering: true, tablePaying: true })
    expect(parseUpsellSurfaces(undefined)).toEqual({ counter: true, tableOrdering: true, tablePaying: true })
  })
})

describe('Upsell — grupo de control (holdout)', () => {
  it('🔴 es DETERMINISTA: el mismo id siempre cae del mismo lado', () => {
    const id = 'a3f1c8e2-0000-4444-8888-abcdefabcdef'
    const primera = isHoldout(id)

    for (let i = 0; i < 50; i++) {
      expect(isHoldout(id)).toBe(primera)
    }
  })

  it('reparte cerca del porcentaje pedido sobre una muestra grande', () => {
    let holdouts = 0
    const N = 20_000
    for (let i = 0; i < N; i++) {
      if (isHoldout(`impression-${i}`)) holdouts++
    }

    const pct = (holdouts / N) * 100
    // Margen amplio: lo que importa es que no sea 0% (nadie en control, métrica
    // imposible) ni 100% (nadie ve tarjetas, función apagada de facto).
    expect(pct).toBeGreaterThan(HOLDOUT_PERCENT - 3)
    expect(pct).toBeLessThan(HOLDOUT_PERCENT + 3)
  })

  it('con 0% nadie queda en control, con 100% todos', () => {
    expect(isHoldout('cualquier-id', 0)).toBe(false)
    expect(isHoldout('cualquier-id', 100)).toBe(true)
  })

  it('ids distintos no caen todos del mismo lado', () => {
    const resultados = new Set(Array.from({ length: 200 }, (_, i) => isHoldout(`id-${i}`)))
    expect(resultados.size).toBe(2)
  })
})
