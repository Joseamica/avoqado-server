export interface PromotionDraftOption {
  productId: string
  /** venueId del producto — se compara contra el de la promoción. */
  productVenueId: string
  productActive: boolean
  quantity: number
  chargedQuantity: number
  priceDeltaCents: number
}

export interface PromotionDraftGroup {
  name: string
  minSelect: number
  maxSelect: number
  options: PromotionDraftOption[]
}

export interface PromotionDraft {
  venueId: string
  type: 'BUNDLE' | 'COMBO' | 'DISCOUNT'
  pricingMode: 'FIXED_TOTAL' | 'PER_UNIT'
  priceCents: number
  groups: PromotionDraftGroup[]
}

export type ValidationResult = { ok: true } | { ok: false; errors: string[] }

/**
 * ¿Esta promoción se puede publicar?
 *
 * Se reportan TODOS los errores juntos: quien la está armando en el dashboard
 * merece verlos de una vez, no uno por intento.
 *
 * 🔴 El check de tenant no es cosmético: una opción con el producto de otro
 * negocio cobraría mercancía ajena, y ni el dueño ni el otro local se
 * enterarían.
 */
export function validatePromotionForPublish(draft: PromotionDraft): ValidationResult {
  const errors: string[] = []

  if (draft.priceCents < 0) {
    errors.push('El precio de la promoción no puede ser negativo.')
  }

  if (draft.type === 'DISCOUNT') {
    if (draft.groups.length > 0) errors.push('Una promoción de descuento no lleva grupos de productos.')
    return errors.length > 0 ? { ok: false, errors } : { ok: true }
  }

  // Sin grupos no hay promoción: publicarla crearía una promo de cero líneas
  // y cero total que "se vende" sin entregar nada (audit 2026-08-13). Los
  // checks de forma bundle/combo sólo aplican cuando SÍ hay grupos — contra
  // cero grupos serían ruido derivado del mismo error de raíz.
  if (draft.groups.length === 0) {
    errors.push('La promoción necesita al menos un grupo de productos.')
  } else {
    const gruposConVarias = draft.groups.filter(g => g.options.length > 1).length
    if (draft.type === 'BUNDLE' && gruposConVarias > 0) {
      errors.push('Un bundle no puede tener grupos con varias opciones. Márcala como combo.')
    }
    if (draft.type === 'COMBO' && gruposConVarias === 0) {
      errors.push('Un combo necesita al menos un grupo con más de una opción. Márcala como bundle.')
    }
  }

  for (const group of draft.groups) {
    if (group.options.length === 0) {
      errors.push(`El grupo "${group.name}" no tiene opciones.`)
    }
    // v1: exactamente una opción por grupo. Los campos existen para no migrar
    // después, pero el POS no ofrece multi-selección y la prorrata de "elige 2
    // de estas 5" es otro problema.
    if (group.minSelect !== 1 || group.maxSelect !== 1) {
      errors.push('Por ahora cada grupo permite elegir exactamente una opción.')
    }

    for (const option of group.options) {
      if (option.productVenueId !== draft.venueId) {
        errors.push(`El producto ${option.productId} no pertenece a este establecimiento.`)
      }
      if (!option.productActive) {
        errors.push(`El producto ${option.productId} está desactivado.`)
      }
      if (option.chargedQuantity < 0) {
        // 🔴 Un negativo produce un target net negativo → descuento MAYOR que el
        // bruto → línea negativa en la cuenta (audit 2026-08-13).
        errors.push(`El producto ${option.productId} no puede cobrar una cantidad negativa.`)
      }
      if (option.quantity < 1) {
        errors.push(`El producto ${option.productId} debe entregar al menos una unidad.`)
      } else if (option.chargedQuantity > option.quantity) {
        // Sólo se evalúa con un quantity válido: contra 0 todo "cobra de más"
        // y el error derivado taparía al de raíz.
        errors.push(`El producto ${option.productId} cobra más unidades de las que entrega.`)
      }
      if (option.priceDeltaCents < 0) {
        errors.push(`El sobreprecio del producto ${option.productId} no puede ser negativo.`)
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true }
}
