/**
 * SAT Catalog Lookup Service
 *
 * Proxies facturapi's catalog search so the dashboard product-key picker
 * can resolve ClaveProdServ (products) and ClaveUnidad (units) by text query.
 *
 * Catalog data is SAT reference data, not per-org. We use the account-level
 * FACTURAPI_USER_KEY (falling back to FACTURAPI_TEST_KEY) — no org key needed.
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

// ─── Types ────────────────────────────────────────────────────────────────────

export type SatCatalogType = 'product' | 'unit'

export interface SatCatalogItem {
  key: string
  description: string
}

export interface SatCatalogResult {
  results: SatCatalogItem[]
}

// ─── DI interface ─────────────────────────────────────────────────────────────

export interface SatCatalogDeps {
  /** Calls GET /catalogs/products[?q=<text>] and returns raw SDK response. q omitted → first page. */
  searchProducts: (q?: string) => Promise<any>
  /** Calls GET /catalogs/units[?q=<text>] and returns raw SDK response. q omitted → first page. */
  searchUnits: (q?: string) => Promise<any>
}

// ─── Default deps (production) ────────────────────────────────────────────────

export function defaultDeps(): SatCatalogDeps {
  const apiKey = env.FACTURAPI_USER_KEY || env.FACTURAPI_TEST_KEY || ''
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

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Search the SAT catalog for products (ClaveProdServ) or units (ClaveUnidad).
 *
 * @param params.type  - 'product' → ClaveProdServ; 'unit' → ClaveUnidad
 * @param params.q     - Optional text query; omitted → catalog's first page (picker default state)
 * @param deps         - Injectable for unit tests; production uses defaultDeps()
 *
 * @returns { results: SatCatalogItem[] } — empty array when no matches
 */
export async function searchSatCatalog(
  params: { type: SatCatalogType; q?: string },
  deps: SatCatalogDeps = defaultDeps(),
): Promise<SatCatalogResult> {
  const { type, q } = params

  if (type === 'product') {
    const raw = await deps.searchProducts(q)
    const items = extractItems(raw)
    const results: SatCatalogItem[] = items.map((item: any) => ({
      key: String(item.key ?? ''),
      description: String(item.description ?? ''),
    }))
    return { results }
  }

  // type === 'unit'
  const raw = await deps.searchUnits(q)
  const items = extractItems(raw)
  const results: SatCatalogItem[] = items.map((item: any) => ({
    key: String(item.key ?? ''),
    // facturapi returns `name` for units — map to description for a uniform shape
    description: String(item.name ?? item.description ?? ''),
  }))
  return { results }
}
