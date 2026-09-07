/**
 * SAT Catalog Lookup Service
 *
 * Proxies facturapi's catalog search so the dashboard product-key picker
 * can resolve ClaveProdServ (products) and ClaveUnidad (units) by text query.
 *
 * 🔴 La llave NO es la de cuenta. Facturapi tiene tres llaves y sólo dos sirven aquí
 * (docs.facturapi.io, «Llaves secretas» + la línea `Authorizations` de los endpoints
 * de catálogo, consultadas el 2026-09-07):
 *
 *   sk_user_ — «Identifica a tu CUENTA para crear organizaciones y administrar permisos,
 *              usuarios y llaves API». Es la que este repo guarda en `FACTURAPI_USER_KEY`
 *              y con la que se provisionan emisores y se sube el CSD
 *              (`fiscalOnboarding.service.ts`, `platformEmisor.service.ts`).
 *   sk_live_ — «Identifica a una ORGANIZACIÓN en ambiente Live para crear y administrar recursos».
 *   sk_test_ — igual, en ambiente Test; es «única por organización», o sea también de organización.
 *
 * Los endpoints de catálogo declaran `Authorizations: SecretLiveKey, SecretTestKey` — la de
 * cuenta NO está en la lista, y Facturapi la rechaza con «La API key proporcionada no es válida».
 * Ese fue el 500 de producción del 2026-09-07 (Testarudo Cafe, OWNER): el servicio construía el
 * cliente con la llave de cuenta, que sí había provisionado bien la organización y el CSD.
 *
 * Orden de resolución (ver `resolveCatalogApiKey`):
 *   1. llave de ORGANIZACIÓN del emisor FACTURAPI del venue (`FiscalEmisor.providerKeyEnc`)
 *   2. `FACTURAPI_TEST_KEY` — también de organización, así que autoriza catálogos
 *   3. error claro (`SatCatalogUnavailableError` con reason `NO_KEY`)
 *
 * DI pattern mirrors fiscalOnboarding.service.ts: defaultDeps() builds the real
 * facturapi client; callers may inject mocks for unit testing.
 *
 * facturapi SDK endpoints:
 *   GET /catalogs/products?q=<text>  → { data: [{ key, description }] } | [...]
 *   GET /catalogs/units?q=<text>     → { data: [{ key, name }] } | [...]
 *
 * Both endpoints may return either `{ data: [...] }` or a bare array — we handle
 * both shapes defensively.
 *
 * @see docs/plans/2026-06-03-facturacion-phase3-emisor-onboarding.md — spec §20.3 add-on #2
 */

import Facturapi from 'facturapi'
import { env } from '../../config/env'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { SatCatalogUnavailableError } from '../../errors/AppError'
import { decryptProviderKey } from './fiscalKey.service'

// Re-exportado por comodidad de quien consume este servicio; la clase vive con las demás
// en `src/errors/AppError.ts`, para que un `jest.mock` de este módulo no rompa el `instanceof`.
export { SatCatalogUnavailableError }

// ─── Types ────────────────────────────────────────────────────────────────────

export type SatCatalogType = 'product' | 'unit'

export interface SatCatalogItem {
  key: string
  description: string
}

export interface SatCatalogResult {
  results: SatCatalogItem[]
}

// ─── DI interfaces ────────────────────────────────────────────────────────────

export interface SatCatalogDeps {
  /** Calls GET /catalogs/products[?q=<text>] and returns raw SDK response. q omitted → first page. */
  searchProducts: (q?: string) => Promise<any>
  /** Calls GET /catalogs/units[?q=<text>] and returns raw SDK response. q omitted → first page. */
  searchUnits: (q?: string) => Promise<any>
}

export interface SatCatalogKeyDeps {
  /** Llave de ORGANIZACIÓN (cifrada) del emisor FACTURAPI del venue, o null si no tiene. */
  findVenueOrgKeyEnc: (venueId: string) => Promise<string | null>
  /** Descifra `FiscalEmisor.providerKeyEnc`. */
  decrypt: (encBase64: string) => string
  /** Llave de pruebas del entorno; leída EN CADA LLAMADA, nunca capturada al importar. */
  testKey: () => string | undefined
}

// ─── Default deps (production) ────────────────────────────────────────────────

export function defaultKeyDeps(): SatCatalogKeyDeps {
  return {
    findVenueOrgKeyEnc: async (venueId: string) => {
      // `provider: 'FACTURAPI'` importa: la `providerKeyEnc` de un emisor FACTURAMA/ALEGRA
      // no es una llave de facturapi. `providerKeyEnc: { not: null }` deja que un venue con
      // emisor a medio provisionar caiga al respaldo en vez de reventar.
      // `orderBy: createdAt asc` = el emisor principal, la misma convención que nómina y contabilidad.
      const emisor = await prisma.fiscalEmisor.findFirst({
        where: { venueId, provider: 'FACTURAPI', providerKeyEnc: { not: null } },
        orderBy: { createdAt: 'asc' },
        select: { providerKeyEnc: true },
      })
      return emisor?.providerKeyEnc ?? null
    },
    decrypt: decryptProviderKey,
    testKey: () => env.FACTURAPI_TEST_KEY || undefined,
  }
}

/**
 * Resuelve la llave con la que consultar los catálogos del SAT para ESTE venue.
 *
 * @throws SatCatalogUnavailableError('NO_KEY') cuando no hay ninguna llave de organización
 *         utilizable — nunca cae en la llave de cuenta, que Facturapi rechaza (ver cabecera).
 */
export async function resolveCatalogApiKey(venueId: string, deps: SatCatalogKeyDeps = defaultKeyDeps()): Promise<string> {
  const enc = await deps.findVenueOrgKeyEnc(venueId)

  if (enc) {
    try {
      const key = deps.decrypt(enc)
      if (key) return key
      logger.warn(`[satCatalog] la llave del emisor de venue=${venueId} descifró vacía; se usa la llave de pruebas`)
    } catch (err) {
      // Una FISCAL_PROVIDER_KEY rotada dejaría el picker muerto para ese venue sin decir por qué.
      // Se avisa y se sigue con el respaldo: esto es una lectura de datos de referencia del SAT,
      // no el camino del timbrado (que tiene su propio fallo, ruidoso, en `fiscalProvider.factory`).
      const detalle = err instanceof Error ? err.message : String(err)
      logger.warn(`[satCatalog] no se pudo descifrar la llave del emisor de venue=${venueId}: ${detalle}`)
    }
  }

  const testKey = deps.testKey()
  if (testKey) return testKey

  throw new SatCatalogUnavailableError(
    'NO_KEY',
    'El catálogo del SAT no está disponible para este negocio: falta configurar su emisor fiscal (Facturapi). Configura la facturación (CFDI) e inténtalo de nuevo.',
  )
}

export async function defaultDeps(venueId: string, keyDeps: SatCatalogKeyDeps = defaultKeyDeps()): Promise<SatCatalogDeps> {
  const apiKey = await resolveCatalogApiKey(venueId, keyDeps)
  const fa = new Facturapi(apiKey)
  return {
    searchProducts: (q?: string) => fa.catalogs.searchProducts(q ? { q } : {}),
    searchUnits: (q?: string) => fa.catalogs.searchUnits(q ? { q } : {}),
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalize the raw facturapi response to SatCatalogItem[].
 * The SDK may return either `{ data: [...] }` or a bare array.
 */
function extractItems(raw: any): any[] {
  if (Array.isArray(raw)) return raw
  if (raw && Array.isArray(raw.data)) return raw.data
  return []
}

/**
 * Todo fallo del proveedor sale TIPADO desde aquí, que es el único punto que sabe
 * a quién se llamó. El texto original se conserva dentro del mensaje para el log;
 * el texto que ve el usuario lo pone el controlador.
 */
async function llamarProveedor<T>(fn: () => Promise<T>, que: string): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const detalle = err instanceof Error ? err.message : String(err)
    throw new SatCatalogUnavailableError('PROVIDER_ERROR', `Facturapi no pudo devolver el catálogo de ${que} del SAT: ${detalle}`)
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Search the SAT catalog for products (ClaveProdServ) or units (ClaveUnidad).
 *
 * @param params.type    - 'product' → ClaveProdServ; 'unit' → ClaveUnidad
 * @param params.q       - Optional text query; omitted → catalog's first page (picker default state)
 * @param params.venueId - Negocio cuyo emisor da la llave de organización (ver `resolveCatalogApiKey`)
 * @param deps           - Injectable for unit tests; production resuelve la llave y arma el cliente
 *
 * @returns { results: SatCatalogItem[] } — empty array when no matches
 * @throws  SatCatalogUnavailableError — 'NO_KEY' (falta configuración) | 'PROVIDER_ERROR' (falló Facturapi)
 */
export async function searchSatCatalog(
  params: { type: SatCatalogType; q?: string; venueId: string },
  deps?: SatCatalogDeps,
): Promise<SatCatalogResult> {
  const { type, q, venueId } = params
  const d = deps ?? (await defaultDeps(venueId))

  if (type === 'product') {
    const raw = await llamarProveedor(() => d.searchProducts(q), 'productos y servicios')
    const items = extractItems(raw)
    const results: SatCatalogItem[] = items.map((item: any) => ({
      key: String(item.key ?? ''),
      description: String(item.description ?? ''),
    }))
    return { results }
  }

  // type === 'unit'
  const raw = await llamarProveedor(() => d.searchUnits(q), 'unidades de medida')
  const items = extractItems(raw)
  const results: SatCatalogItem[] = items.map((item: any) => ({
    key: String(item.key ?? ''),
    // facturapi returns `name` for units — map to description for a uniform shape
    description: String(item.name ?? item.description ?? ''),
  }))
  return { results }
}
