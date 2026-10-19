import { Prisma, ProductType } from '@prisma/client'
import { BadRequestError } from '../../errors/AppError'

export const MAX_OPTIONS = 3
export const MAX_VALUES_PER_OPTION = 100
export const MAX_VARIANTS_PER_GROUP = 250
export const VARIANT_NAME_SEPARATOR = ' · '
const MAX_SKU_LENGTH = 64
/**
 * Pesos con hasta 2 decimales, contados EXACTOS en decimal (no con tolerancia de flotante): Zod `multipleOf(0.01)` deja pasar
 * 0.0000001 (se lee «1e-7» sin punto) y una tolerancia dejaba pasar 1e-9; los dos se guardaban como 0.00.
 */
export const isWholeCents = (n: number): boolean => Number.isFinite(n) && new Prisma.Decimal(n).decimalPlaces() <= 2

/** Spec D14: físicos y de consumo. Servicios/clases/eventos con duración por variante van en una fase posterior. */
export const ALLOWED_GROUP_TYPES: readonly ProductType[] = [
  ProductType.REGULAR,
  ProductType.FOOD_AND_BEV,
  ProductType.RETAIL,
  ProductType.FOOD,
  ProductType.BEVERAGE,
  ProductType.ALCOHOL,
  ProductType.OTHER,
]

export interface NormalizedOption {
  name: string
  values: string[]
}

const clave = (s: string) => s.trim().toLocaleLowerCase('es-MX')

export function normalizeOptions(options: Array<{ name: string; values: string[] }>): NormalizedOption[] {
  if (!options.length) throw new BadRequestError('Agrega al menos una opción, por ejemplo «Talla».')
  if (options.length > MAX_OPTIONS)
    throw new BadRequestError(`Un producto puede tener hasta ${MAX_OPTIONS} opciones (por ejemplo talla, color y material).`)
  const nombres = new Set<string>()
  return options.map(o => {
    const name = o.name.trim()
    if (!name) throw new BadRequestError('El nombre de una opción está vacío.')
    if (nombres.has(clave(name))) throw new BadRequestError(`La opción «${name}» está repetida.`)
    nombres.add(clave(name))
    if (!o.values.length) throw new BadRequestError(`La opción «${name}» necesita al menos un valor.`)
    if (o.values.length > MAX_VALUES_PER_OPTION)
      throw new BadRequestError(`La opción «${name}» puede tener hasta ${MAX_VALUES_PER_OPTION} valores.`)
    const vistos = new Set<string>()
    const values = o.values.map(v => {
      const value = v.trim()
      if (!value) throw new BadRequestError(`Un valor de «${name}» está vacío.`)
      if (vistos.has(clave(value))) throw new BadRequestError(`«${value}» está repetido en ${name}.`)
      vistos.add(clave(value))
      return value
    })
    return { name, values }
  })
}

export function variantName(parentName: string, valuesInOptionOrder: string[]): string {
  return [parentName.trim(), ...valuesInOptionOrder].join(VARIANT_NAME_SEPARATOR)
}

export function variantKeyOf(optionValueIdsInOptionOrder: string[]): string {
  return optionValueIdsInOptionOrder.join('|')
}

export function suggestSku(parentName: string, valuesInOptionOrder: string[]): string {
  const limpio = [parentName, ...valuesInOptionOrder]
    .join('-')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return limpio.slice(0, MAX_SKU_LENGTH).replace(/-+$/g, '')
}

export function assertAllowedGroupType(type: ProductType): void {
  if (!ALLOWED_GROUP_TYPES.includes(type))
    throw new BadRequestError('Las variantes todavía no están disponibles para servicios, clases ni eventos.')
}
