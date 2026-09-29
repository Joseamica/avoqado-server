import { createHash } from 'crypto'
import { z } from 'zod'
import { FEATURE_CATALOG, FEATURE_CATEGORIES } from '@/config/featureCatalog'

export const featureCatalogQuery = z.object({
  q: z.string({ invalid_type_error: 'La búsqueda debe ser texto' }).trim().max(120, 'La búsqueda admite hasta 120 caracteres').optional(),
  category: z.enum(FEATURE_CATEGORIES, { errorMap: () => ({ message: 'Categoría no válida' }) }).optional(),
  page: z.coerce
    .number({ invalid_type_error: 'La página debe ser un número' })
    .int('La página debe ser entera')
    .min(1, 'La página empieza en 1')
    .max(1_000_000, 'Página fuera de rango')
    .default(1),
  pageSize: z.coerce
    .number({ invalid_type_error: 'El tamaño debe ser un número' })
    .int('El tamaño debe ser entero')
    .min(1, 'El tamaño mínimo es 1')
    .max(100, 'El tamaño máximo es 100')
    .default(25),
})

export const catalogVersion = createHash('sha256').update(JSON.stringify(FEATURE_CATALOG)).digest('hex')
const normalize = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es-MX')
const entries = [...FEATURE_CATALOG].sort((a, b) => a.id.localeCompare(b.id, 'en'))

/** Finite code registry, not tenant data. Filter and page here so clients never fetch the full inventory. */
export function listFeatureCatalog(input: unknown, includedIds?: readonly string[]) {
  const { q, category, page, pageSize } = featureCatalogQuery.parse(input)
  const needle = normalize(q ?? '')
  const matches = entries.filter(
    entry =>
      (!includedIds || includedIds.includes(entry.id)) &&
      (!category || entry.category === category) &&
      (!needle || normalize(`${entry.id} ${Object.values(entry.names).join(' ')} ${entry.description}`).includes(needle)),
  )
  return {
    catalogVersion,
    items: matches.slice((page - 1) * pageSize, page * pageSize),
    total: matches.length,
    page,
    pageSize,
    totalPages: Math.ceil(matches.length / pageSize),
  }
}
