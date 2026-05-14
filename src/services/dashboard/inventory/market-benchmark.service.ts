/**
 * Market Benchmark — AI-assisted price exploration.
 *
 * Flow:
 *  1. Resolve the venue's coordinates (Venue.latitude/longitude or geocoded address)
 *  2. Google Places Nearby Search → competitor restaurants/cafés in a 1km radius
 *  3. OpenAI: given product info + competitor names, estimate market median + confidence
 *  4. In-memory cache (24h TTL) keyed by (venueId, productId) — keeps API costs honest
 *
 * IMPORTANT: This is advisory ONLY. We never auto-apply a benchmark to a real
 * product price; the dashboard surfaces the estimate with a "verify before
 * applying" disclaimer.
 */

import OpenAI from 'openai'
import prisma from '../../../utils/prismaClient'
import AppError, { NotFoundError } from '../../../errors/AppError'
import logger from '../../../config/logger'

// ---- Types ---------------------------------------------------------------

export interface MarketBenchmarkResult {
  productId: string
  productName: string
  currency: string | null
  /** Number of nearby venues considered */
  comparablesFound: number
  /** Subset of nearby venue names that informed the estimate */
  comparableVenues: string[]
  /** Best-guess median in the venue's currency, or null if no usable signal */
  medianEstimate: number | null
  /** Conservative low/high range */
  rangeLow: number | null
  rangeHigh: number | null
  /** How confident the model is in the estimate */
  confidence: 'low' | 'medium' | 'high'
  /** One short sentence the dashboard can show to the user */
  reasoning: string
  /** Wall-clock when this was generated (for staleness display) */
  generatedAt: string
  /** True if served from cache, false if freshly computed */
  cached: boolean
}

// ---- In-memory cache (no Redis available) -------------------------------

interface CacheEntry {
  value: MarketBenchmarkResult
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h

function cacheKey(venueId: string, productId: string) {
  return `${venueId}:${productId}`
}

function readCache(venueId: string, productId: string): MarketBenchmarkResult | null {
  const entry = cache.get(cacheKey(venueId, productId))
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    cache.delete(cacheKey(venueId, productId))
    return null
  }
  return { ...entry.value, cached: true }
}

function writeCache(venueId: string, productId: string, value: MarketBenchmarkResult) {
  cache.set(cacheKey(venueId, productId), { value, expiresAt: Date.now() + CACHE_TTL_MS })
}

// ---- Google Places --------------------------------------------------------

interface NearbyVenue {
  name: string
  rating: number | null
  userRatingsTotal: number | null
  types: string[]
}

async function fetchNearbyVenues(lat: number, lng: number, radiusMeters = 1000): Promise<NearbyVenue[]> {
  const apiKey = process.env.GOOGLE_GEOLOCATION_API_KEY
  if (!apiKey) {
    throw new AppError('GOOGLE_GEOLOCATION_API_KEY is not configured', 500)
  }

  const url = new URL('https://maps.googleapis.com/maps/api/place/nearbysearch/json')
  url.searchParams.set('location', `${lat},${lng}`)
  url.searchParams.set('radius', String(radiusMeters))
  url.searchParams.set('type', 'restaurant')
  url.searchParams.set('key', apiKey)

  const res = await fetch(url.toString())
  if (!res.ok) {
    throw new AppError(`Google Places error: ${res.status}`, 502)
  }
  const data = (await res.json()) as { status?: string; results?: any[]; error_message?: string }
  if (data.status && !['OK', 'ZERO_RESULTS'].includes(data.status)) {
    throw new AppError(`Google Places returned ${data.status}: ${data.error_message ?? ''}`, 502)
  }

  const results = data.results ?? []
  return results
    .filter(r => r.business_status === 'OPERATIONAL')
    .slice(0, 15) // OpenAI doesn't need 60 names; 15 is enough signal
    .map(r => ({
      name: String(r.name ?? ''),
      rating: typeof r.rating === 'number' ? r.rating : null,
      userRatingsTotal: typeof r.user_ratings_total === 'number' ? r.user_ratings_total : null,
      types: Array.isArray(r.types) ? r.types : [],
    }))
}

// ---- Geocoding (fallback when lat/lng are missing) -----------------------

async function geocode(address: string): Promise<{ lat: number; lng: number } | null> {
  const apiKey = process.env.GOOGLE_GEOLOCATION_API_KEY
  if (!apiKey) return null

  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
  url.searchParams.set('address', address)
  url.searchParams.set('key', apiKey)

  const res = await fetch(url.toString())
  if (!res.ok) return null
  const data = (await res.json()) as { results?: Array<{ geometry?: { location?: { lat: number; lng: number } } }> }
  const loc = data.results?.[0]?.geometry?.location
  return loc ? { lat: loc.lat, lng: loc.lng } : null
}

// ---- OpenAI estimate ------------------------------------------------------

interface OpenAIEstimate {
  medianEstimate: number | null
  rangeLow: number | null
  rangeHigh: number | null
  confidence: 'low' | 'medium' | 'high'
  reasoning: string
}

function buildPrompt(opts: {
  productName: string
  category: string | null
  currency: string
  city: string | null
  nearby: NearbyVenue[]
  currentPrice: number
  currentCost: number | null
}): string {
  const compList = opts.nearby.length
    ? opts.nearby
        .map((v, i) => `${i + 1}. ${v.name}${v.rating ? ` (${v.rating}★ · ${v.userRatingsTotal ?? 0} reseñas)` : ''}`)
        .join('\n')
    : '(no se encontraron lugares cercanos)'

  return `Eres un analista de precios para restaurantes en ${opts.city ?? 'México'}.

PRODUCTO A EVALUAR:
- Nombre: "${opts.productName}"
- Categoría: ${opts.category ?? 'Sin categoría'}
- Moneda: ${opts.currency}
- Precio actual del establecimiento: ${opts.currentPrice}
${opts.currentCost !== null ? `- Costo unitario: ${opts.currentCost}` : ''}

LUGARES CERCANOS (a 1km, restaurantes/cafés):
${compList}

TAREA:
Estima cuánto costaría un producto comparable en estos lugares cercanos. Si el producto es muy
específico ("Doradita Keto Cacao") y no hay equivalente claro en cadenas conocidas, indica
confianza BAJA. Si es un producto estándar ("Cappuccino", "Latte"), puedes estimar con más
confianza basándote en precios típicos de zona y los tipos de lugares listados.

Reglas:
- NUNCA inventes precios específicos de lugares específicos. Solo estima una mediana de mercado.
- Si la zona es premium (Polanco, Lomas, Roma, Condesa), considera precios más altos.
- "rangeLow" y "rangeHigh" deben representar el percentil 25 y 75 estimados.
- "confidence" = "high" solo si el producto es genérico Y hay 5+ lugares comparables.

Responde SOLO con JSON válido en este formato exacto:
{
  "medianEstimate": <number o null si no es estimable>,
  "rangeLow": <number o null>,
  "rangeHigh": <number o null>,
  "confidence": "low" | "medium" | "high",
  "reasoning": "<una sola oración explicando la base del estimado, en español>"
}`
}

async function askOpenAI(prompt: string): Promise<OpenAIEstimate> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new AppError('OPENAI_API_KEY is not configured', 500)

  const openai = new OpenAI({ apiKey })

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'Devuelves SOLO JSON válido en el esquema solicitado.' },
      { role: 'user', content: prompt },
    ],
  })

  const raw = completion.choices[0]?.message?.content ?? '{}'
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new AppError('OpenAI returned non-JSON response', 502)
  }

  return {
    medianEstimate: typeof parsed.medianEstimate === 'number' ? parsed.medianEstimate : null,
    rangeLow: typeof parsed.rangeLow === 'number' ? parsed.rangeLow : null,
    rangeHigh: typeof parsed.rangeHigh === 'number' ? parsed.rangeHigh : null,
    confidence: ['low', 'medium', 'high'].includes(parsed.confidence) ? parsed.confidence : 'low',
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : 'Sin contexto disponible.',
  }
}

// ---- Public entry point --------------------------------------------------

export async function getMarketBenchmark(venueId: string, productId: string): Promise<MarketBenchmarkResult> {
  // 1. Cache check
  const cached = readCache(venueId, productId)
  if (cached) return cached

  // 2. Load product + venue context
  const product = await prisma.product.findFirst({
    where: { id: productId, venueId },
    select: {
      id: true,
      name: true,
      price: true,
      cost: true,
      category: { select: { name: true } },
      recipe: { select: { totalCost: true } },
      venue: {
        select: {
          currency: true,
          city: true,
          address: true,
          latitude: true,
          longitude: true,
        },
      },
    },
  })

  if (!product) throw new NotFoundError('Producto no encontrado en este venue')

  // 3. Resolve coordinates
  let lat = product.venue.latitude?.toNumber() ?? null
  let lng = product.venue.longitude?.toNumber() ?? null

  if (lat === null || lng === null) {
    if (!product.venue.address) {
      throw new AppError(
        'No se puede analizar el mercado: el venue no tiene coordenadas ni dirección configurada.',
        422,
      )
    }
    const geocoded = await geocode(product.venue.address)
    if (!geocoded) {
      throw new AppError('No se pudo geocodificar la dirección del venue', 422)
    }
    lat = geocoded.lat
    lng = geocoded.lng
  }

  // 4. Find competitors
  const nearby = await fetchNearbyVenues(lat, lng, 1000)
  logger.info('[MARKET_BENCHMARK] competitors found', {
    venueId,
    productId,
    count: nearby.length,
  })

  // 5. Ask OpenAI
  const cost = product.recipe?.totalCost?.toNumber() ?? product.cost?.toNumber() ?? null
  const estimate = await askOpenAI(
    buildPrompt({
      productName: product.name,
      category: product.category?.name ?? null,
      currency: product.venue.currency,
      city: product.venue.city,
      nearby,
      currentPrice: product.price.toNumber(),
      currentCost: cost,
    }),
  )

  // 6. Build result + cache
  const result: MarketBenchmarkResult = {
    productId: product.id,
    productName: product.name,
    currency: product.venue.currency,
    comparablesFound: nearby.length,
    comparableVenues: nearby.slice(0, 8).map(n => n.name),
    medianEstimate: estimate.medianEstimate,
    rangeLow: estimate.rangeLow,
    rangeHigh: estimate.rangeHigh,
    confidence: estimate.confidence,
    reasoning: estimate.reasoning,
    generatedAt: new Date().toISOString(),
    cached: false,
  }
  writeCache(venueId, productId, result)
  return result
}

// ---- Test helpers --------------------------------------------------------

/** Test-only: reset the in-memory cache between unit tests. */
export function __resetBenchmarkCacheForTests() {
  cache.clear()
}
