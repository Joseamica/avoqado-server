/**
 * Revisión PURA de los extras (modificadores) de una pieza de un combo. Sin Prisma: el llamador trae los grupos del producto y los
 * extras del venue. Nunca lanza: lo que no cuadra va a `problemas` (el SERVIDOR marca `needsReview`, no rechaza mercancía entregada).
 */

export interface GrupoDeLaPieza {
  id: string
  name: string
  required: boolean
  allowMultiple: boolean
  minSelections: number
  maxSelections: number | null
}

export interface ExtraDelVenue {
  id: string
  name: string
  priceCents: number
  groupId: string
}

export interface ExtraCobrado {
  modifierId: string
  name: string
  priceCents: number
}

export function revisarExtrasDeLaPieza(input: {
  productName: string
  quantity: number
  modifierIds: string[] | undefined
  /** Sólo grupos activos ligados al producto. */
  gruposDelProducto: GrupoDeLaPieza[]
  /** Incluye archivados: un extra archivado se cobra, valía cuando se vendió. */
  extrasDelVenue: Map<string, ExtraDelVenue>
}): { extras: ExtraCobrado[]; extrasCents: number; problemas: string[] } {
  const { productName, quantity, modifierIds, gruposDelProducto, extrasDelVenue } = input
  const vacio = { extras: [] as ExtraCobrado[], extrasCents: 0, problemas: [] as string[] }
  // Llave ausente: se comporta como hoy.
  if (modifierIds === undefined) return vacio

  // Alcance v1: sólo piezas de cantidad 1 llevan extras.
  if (quantity !== 1) {
    if (modifierIds.length > 0) {
      vacio.problemas.push(`${productName} viene ${quantity} veces en el combo: sus extras no se cobraron.`)
    }
    return vacio
  }

  const extras: ExtraCobrado[] = []
  const problemas: string[] = []
  const gruposPorId = new Map(gruposDelProducto.map(g => [g.id, g]))
  const conteoPorGrupo = new Map<string, number>()
  const desconocidos = new Set<string>()
  const ajenos = new Set<string>()

  for (const id of modifierIds) {
    const extra = extrasDelVenue.get(id)
    if (!extra) {
      if (!desconocidos.has(id)) {
        desconocidos.add(id)
        problemas.push(`Un extra de ${productName} ya no existe y no se cobró.`)
      }
      continue
    }
    extras.push({ modifierId: extra.id, name: extra.name, priceCents: extra.priceCents })
    if (gruposPorId.has(extra.groupId)) {
      conteoPorGrupo.set(extra.groupId, (conteoPorGrupo.get(extra.groupId) ?? 0) + 1)
    } else if (!ajenos.has(id)) {
      ajenos.add(id)
      problemas.push(`«${extra.name}» no es un extra de ${productName}.`)
    }
  }

  for (const grupo of gruposDelProducto) {
    const elegidos = conteoPorGrupo.get(grupo.id) ?? 0
    const minimo = grupo.required ? Math.max(1, grupo.minSelections) : 0
    if (elegidos < minimo) {
      problemas.push(`Faltó elegir «${grupo.name}» de ${productName}.`)
    }
    const tope = grupo.allowMultiple ? grupo.maxSelections : 1
    if (tope !== null && elegidos > tope) {
      problemas.push(`«${grupo.name}» de ${productName} admite sólo ${tope} ${tope === 1 ? 'opción' : 'opciones'}.`)
    }
  }

  return { extras, extrasCents: extras.reduce((s, e) => s + e.priceCents, 0), problemas }
}

/** Array de strings (sin tope: un tope no puede tirar extras en silencio) o undefined si no es un array de strings. */
export function leerModifierIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.every(x => typeof x === 'string') ? (raw as string[]) : undefined
}
