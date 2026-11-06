/**
 * D14 v2 (5-nov-2026): la ÚNICA regla de alcance y límites de descuentos y cupones. La llaman todas las puertas que los
 * escriben: panel y MCP (servicios), «Duplicar», y las apps (controladores móviles, que no pasan por Zod). Antes la regla
 * vivía en varios lugares que la revisaban distinto y cada arreglo abría otro hueco (Codex r1–r5).
 *
 * Mira el RESULTADO (lo guardado + el cambio), no el cambio suelto. Crear y duplicar = sin guardado.
 * - Familia A: «Categorías» sin ninguna categoría no nace ni queda; uno viejo que YA está exactamente así se conserva.
 * - Familia B: cada límite de uso es null (sin límite) o un entero de 1 en adelante; un valor viejo idéntico se conserva.
 */
import { DiscountScope } from '@prisma/client'

export const SIN_CATEGORIAS = 'Elige al menos una categoría para un descuento por categorías'
export const LIMITE_INVALIDO = 'Los límites de uso van de 1 en adelante; déjalo vacío para que sea ilimitado'
export const FORMA_INVALIDA = 'El alcance, las categorías o los límites de uso no tienen el formato correcto'
export const CAMBIO_CRUZADO = 'Alguien más lo cambió mientras lo editabas; vuelve a abrirlo e inténtalo otra vez'

const LIMITES = ['maxTotalUses', 'maxUsesPerCustomer', 'maxUses'] as const
const REGLA = ['scope', 'targetCategoryIds', ...LIMITES] as const
const ALCANCES = new Set<unknown>(Object.values(DiscountScope))

type Guardado = Partial<Record<(typeof REGLA)[number], unknown>>

const sinCategorias = (scope: unknown, categorias: unknown) =>
  scope === 'CATEGORY' && (!Array.isArray(categorias) || categorias.length === 0)

/** Devuelve el mensaje (en español) si el resultado no vale, o null si vale. */
export function validarCambioDeDescuento(guardado: Guardado | null, cambio: Record<string, unknown>): string | null {
  const { scope, targetCategoryIds } = cambio
  // Forma: las apps no pasan por Zod y Prisma aceptaría `{ set: … }` (Codex r2 #2, r3 #1).
  if (scope !== undefined && !ALCANCES.has(scope)) return FORMA_INVALIDA
  if (targetCategoryIds !== undefined && !(Array.isArray(targetCategoryIds) && targetCategoryIds.every(c => typeof c === 'string')))
    return FORMA_INVALIDA

  const scopeFinal = scope ?? guardado?.scope ?? 'ORDER'
  const categoriasFinal = targetCategoryIds ?? guardado?.targetCategoryIds ?? []
  if (sinCategorias(scopeFinal, categoriasFinal) && !(guardado && sinCategorias(guardado.scope, guardado.targetCategoryIds)))
    return SIN_CATEGORIAS

  for (const campo of LIMITES) {
    const valor = cambio[campo]
    if (valor === undefined || valor === null) continue
    if (guardado && guardado[campo] === valor) continue // un 0 viejo reenviado igual
    if (!(typeof valor === 'number' && Number.isInteger(valor) && valor >= 1)) return LIMITE_INVALIDO
  }
  return null
}

/**
 * Dos ediciones a la vez (Codex r2 #3, r5 #1): si el cambio MANDA algún campo de la regla, aunque sea igual a lo guardado,
 * se escribe sólo si esos campos siguen como se leyeron; si no, Prisma no encuentra la fila (P2025) → 409.
 * No se usa `updatedAt`: cada venta sube `currentUses` y con él `updatedAt`, y daría un 409 falso.
 */
export function dondeEscribir(id: string, guardado: Guardado, cambio: Record<string, unknown>) {
  if (!REGLA.some(campo => cambio[campo] !== undefined)) return { id }
  const where: Record<string, unknown> = { id }
  for (const campo of REGLA) {
    if (!(campo in guardado)) continue
    const valor = guardado[campo]
    if (campo !== 'targetCategoryIds') where[campo] = valor
    else if (Array.isArray(valor) && valor.length > 0) where[campo] = { equals: valor }
    // Una lista NULL en la base (p. ej. los descuentos de referidos) Prisma la lee como []: se aceptan las dos (Codex, diseño #1).
    else where.OR = [{ targetCategoryIds: { equals: [] } }, { targetCategoryIds: { equals: null } }]
  }
  return where as { id: string }
}

export const esCambioCruzado = (error: unknown) => (error as { code?: string } | null)?.code === 'P2025'
