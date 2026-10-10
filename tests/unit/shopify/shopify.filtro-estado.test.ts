/**
 * El filtro de estado de `productVariants(query:)` va en MINÚSCULAS y con OR (C10, guía en vivo, 9-oct-2026).
 *
 * Medido contra la tienda de desarrollo `avoqado-prueba-sync` con la API 2026-10, ubicación «Shop location», 26 variantes
 * (24 ACTIVE, 1 DRAFT, 1 ARCHIVED):
 *   `product_status:ACTIVE,DRAFT` ⇒ 0 · `product_status:ACTIVE` ⇒ 0 · `(product_status:ACTIVE OR product_status:DRAFT)` ⇒ 0
 *   `product_status:active,draft` ⇒ 25 · `(product_status:active OR product_status:draft)` ⇒ 25 (sin la archivada)
 *   `product_id:N (product_status:active OR product_status:draft)` ⇒ las 5 variantes del producto · sin filtro ⇒ 26
 * Con el filtro en mayúsculas la importación terminaba «bien» con 0 variantes y el cuadre no veía nada: la tienda se
 * conectaba vacía y en silencio. Las pruebas de integración usan un `graphql` falso, así que no podían verlo. La forma con
 * OR es la que documenta la sintaxis de búsqueda de Shopify (la lista con coma también funcionó, pero no está escrita).
 */
import fs from 'node:fs'
import path from 'node:path'

const mockDb = {}
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: mockDb }))

import { FILTRO_ESTADO } from '@/services/commerce-channels/shopify/shopify.catalog.service'

const SRC = path.join(__dirname, '../../../src')
function archivosTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return archivosTs(p)
    return e.name.endsWith('.ts') ? [p] : []
  })
}
/** Quita comentarios (bloque y de línea) para mirar sólo el código. */
const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('FILTRO_ESTADO (búsqueda de Shopify)', () => {
  it('🔴 pide ACTIVE y DRAFT en minúsculas y con OR: en mayúsculas Shopify devuelve 0 variantes', () => {
    expect(FILTRO_ESTADO).toBe('(product_status:active OR product_status:draft)')
  })

  it('no trae ningún valor de estado en mayúsculas ni la archivada', () => {
    const valores = [...FILTRO_ESTADO.matchAll(/product_status:(\w+)/g)].map(m => m[1])
    expect(valores).toEqual(['active', 'draft'])
  })

  it('🔴 ningún otro código escribe un `product_status:` a mano: todo pasa por FILTRO_ESTADO (refresco, cuadre, importación)', () => {
    const fuera = archivosTs(SRC).flatMap(f =>
      sinComentarios(fs.readFileSync(f, 'utf8'))
        .split('\n')
        .filter(l => /product_status:/.test(l) && !/export const FILTRO_ESTADO\s*=/.test(l))
        .map(l => `${path.relative(SRC, f)}: ${l.trim()}`),
    )
    expect(fuera).toEqual([])
  })
})
