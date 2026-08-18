/**
 * Opciones obligatorias de una sugerencia de upsell (spec 2026-08-16, decisión B3).
 *
 * 🔴 La elección vive en la REGLA, no en el producto: el mismo Agua Mineral puede
 * sugerirse chica en una regla y grande en otra sin tocar el catálogo. Por eso NO
 * existe un `Modifier.isDefault` — y no debe agregarse para esto.
 *
 * El POS descarta una tarjeta que abriría un formulario (regla de Square: un
 * artículo con obligatorios SIEMPRE abre su pantalla de detalle). Resolver aquí las
 * opciones es lo que permite que la tarjeta entre de UN toque.
 */

export interface SuggestedModifierSelection {
  groupId: string
  modifierId: string
}

export interface ResolvedModifier {
  groupId: string
  modifierId: string
  name: string
  price: number
}

export interface ProductForValidation {
  id: string
  soldByWeight: boolean
  upsellEnabled: boolean | null
  modifierGroups: Array<{
    group: {
      id: string
      name: string
      required: boolean
      modifiers: Array<{ id: string; name: string; price: unknown; active?: boolean }>
    }
  }>
}

export class UpsellModifierError extends Error {
  constructor(
    readonly code: 'PRODUCT_NOT_SUGGESTABLE' | 'MISSING_REQUIRED_MODIFIER' | 'MODIFIER_NOT_IN_GROUP' | 'MODIFIER_INACTIVE',
    message: string,
  ) {
    super(message)
    this.name = 'UpsellModifierError'
  }
}

/** Prisma devuelve Decimal; el DTO viaja como número. */
function toNumber(price: unknown): number {
  return typeof price === 'number' ? price : Number(String(price ?? 0))
}

/**
 * Valida la selección contra el producto y la devuelve resuelta (con nombre y
 * precio) para que el POS pinte la tarjeta sin recalcular nada.
 *
 * NO valida existencias: el stock es transitorio y cambia solo — bloquear la regla
 * por algo que mañana se resuelve sería absurdo. Ese filtro se queda en el POS.
 */
export function validateAndResolveModifiers(
  product: ProductForValidation,
  selection: SuggestedModifierSelection[] | null | undefined,
): ResolvedModifier[] {
  if (product.upsellEnabled !== true) {
    throw new UpsellModifierError('PRODUCT_NOT_SUGGESTABLE', 'Este producto está vetado para sugerencias en su ficha')
  }
  if (product.soldByWeight) {
    throw new UpsellModifierError('PRODUCT_NOT_SUGGESTABLE', 'Un producto que se vende por peso no puede sugerirse de un toque')
  }

  const picks = selection ?? []
  const resolved: ResolvedModifier[] = []

  for (const { group } of product.modifierGroups) {
    if (!group.required) continue

    const pick = picks.find(p => p.groupId === group.id)
    if (!pick) {
      throw new UpsellModifierError(
        'MISSING_REQUIRED_MODIFIER',
        `Falta elegir una opción de "${group.name}" para poder sugerir este producto`,
      )
    }

    const modifier = group.modifiers.find(m => m.id === pick.modifierId)
    if (!modifier) {
      throw new UpsellModifierError('MODIFIER_NOT_IN_GROUP', `La opción elegida no pertenece a "${group.name}"`)
    }
    if (modifier.active === false) {
      throw new UpsellModifierError('MODIFIER_INACTIVE', `La opción "${modifier.name}" está desactivada`)
    }

    resolved.push({ groupId: group.id, modifierId: modifier.id, name: modifier.name, price: toNumber(modifier.price) })
  }

  return resolved
}

/**
 * ¿Un generador AUTOMÁTICO (job nocturno, IA, espejo de promociones) puede
 * proponer este producto SIN que un humano elija nada?
 *
 * Ronda final de correcciones (2026-08-17): ninguno de los tres generadores
 * escribe `suggestedModifiers` — nunca han sabido elegir "¿Chico o Grande?" por
 * el dueño, eso es un juicio que no les toca. Antes de esta función proponían
 * de todos modos, y `approveRule`/`validateAndResolveModifiers` los rechazaba
 * hasta que el dueño intentaba aprobarlos: la propuesta nacía muerta y sólo se
 * notaba al dar clic en "Activar". `canAutoPropose` corre el MISMO validador
 * con una selección vacía — exactamente lo que un generador automático puede
 * ofrecer — y dice si eso alcanza. Si el producto no tiene obligatorios (el
 * caso común) y no se vende por peso, `validateAndResolveModifiers` no lanza
 * y esta función responde `true`.
 */
export function canAutoPropose(product: ProductForValidation): boolean {
  return autoProposeRejectionReason(product) === null
}

/**
 * Igual pregunta que `canAutoPropose`, pero devuelve el MOTIVO en vez de tragárselo.
 *
 * 🔴 Ronda final de correcciones (2026-08-17), P2: antes de esto, un generador
 * automático que rechazaba un producto no dejaba rastro de POR QUÉ — sólo un
 * `continue` mudo. Eso choca con la regla del workspace ("apagado se VE y se
 * EXPLICA, nunca desaparece en silencio"): el dueño ve que su promoción no generó
 * tarjeta y no tiene cómo enterarse de que el producto pide talla o se vende por
 * peso. `null` = sí se puede proponer sin que un humano elija nada.
 */
export function autoProposeRejectionReason(product: ProductForValidation): string | null {
  try {
    validateAndResolveModifiers(product, undefined)
    return null
  } catch (error) {
    return error instanceof UpsellModifierError ? error.message : 'No se pudo validar el producto'
  }
}
