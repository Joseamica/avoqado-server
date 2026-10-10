/**
 * El filtro de estado de `productVariants(query:)` va en MINÚSCULAS (C10, guía en vivo, 9-oct-2026).
 *
 * Medido contra la tienda de desarrollo `avoqado-prueba-sync` con la API 2026-10, ubicación «Shop location», 26 variantes
 * (24 ACTIVE, 1 DRAFT, 1 ARCHIVED):
 *   `product_status:ACTIVE,DRAFT` ⇒ 0 · `product_status:ACTIVE` ⇒ 0 · `product_status:Active,Draft` ⇒ 0
 *   `product_status:active,draft` ⇒ 25 (ACTIVE y DRAFT, sin la archivada) · sin filtro ⇒ 26
 * Con el filtro en mayúsculas la importación terminaba «bien» con 0 variantes y el cuadre no veía nada: la tienda se
 * conectaba vacía y en silencio. Las pruebas de integración usan un `graphql` falso, así que no podían verlo.
 */
const mockDb = {}
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: mockDb }))

import { FILTRO_ESTADO } from '@/services/commerce-channels/shopify/shopify.catalog.service'

describe('FILTRO_ESTADO (búsqueda de Shopify)', () => {
  it('🔴 pide ACTIVE y DRAFT en minúsculas: en mayúsculas Shopify devuelve 0 variantes', () => {
    expect(FILTRO_ESTADO).toBe('product_status:active,draft')
  })

  it('no trae ningún valor de estado en mayúsculas', () => {
    const valores = FILTRO_ESTADO.replace(/^product_status:/, '').split(',')
    expect(valores.every(v => v === v.toLowerCase())).toBe(true)
    expect(valores).not.toContain('archived')
  })
})
