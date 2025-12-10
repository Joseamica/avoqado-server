/**
 * Blumon MCC Lookup Service
 *
 * Automatiza el proceso de determinar tasas de procesamiento basado en:
 * 1. Nombre del negocio → Sinónimos → MCC → Familia → Tasas
 *
 * Ejemplo:
 *   Input: "Gimnasio CrossFit"
 *   → Synonym match: "crossfit" → MCC 7941
 *   → Familia: "Entretenimiento"
 *   → Tasas: { credito: 1.70%, debito: 1.63%, internacional: 3.30%, amex: 3.00% }
 */

import fs from 'fs'
import path from 'path'

// Load JSON data
const dataDir = path.join(__dirname, '../../data/blumon-pricing')
const familiasTasas = JSON.parse(fs.readFileSync(path.join(dataDir, 'familias-tasas.json'), 'utf-8'))
const businessSynonyms = JSON.parse(fs.readFileSync(path.join(dataDir, 'business-synonyms.json'), 'utf-8'))

export interface BlumonRates {
  credito: number
  debito: number
  internacional: number
  amex: number
}

export interface MCCLookupResult {
  found: boolean
  mcc?: string
  familia?: string
  rates?: BlumonRates
  matchType?: 'exact_synonym' | 'partial_synonym' | 'fuzzy_description' | 'default'
  matchedTerm?: string
  nota?: string
  confidence: number // 0-100
}

/**
 * Normaliza texto para comparación
 * - Lowercase
 * - Remove accents
 * - Remove extra spaces
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove accents
    .replace(/[^a-z0-9\s]/g, ' ') // Replace special chars with space
    .replace(/\s+/g, ' ') // Collapse multiple spaces
    .trim()
}

/**
 * Busca tasas por nombre de negocio
 *
 * @param businessName - Nombre o descripción del negocio (ej: "Gimnasio", "Restaurante de tacos")
 *                       También acepta nombres de familia directamente (ej: "Entretenimiento", "Restaurantes")
 * @returns MCCLookupResult con las tasas encontradas
 */
export function lookupRatesByBusinessName(businessName: string): MCCLookupResult {
  const normalized = normalizeText(businessName)

  // Handle edge cases: empty or very short input
  if (normalized.length < 3) {
    const defaultRates = getRatesByFamilia('Otros')
    return {
      found: false,
      familia: 'Otros',
      rates: defaultRates,
      matchType: 'default',
      confidence: 0,
      nota: 'Input demasiado corto para clasificar.',
    }
  }

  // 0. Check if input is directly a familia name
  const directFamiliaRates = getRatesByFamilia(businessName)
  if (directFamiliaRates) {
    // Find the exact familia name (might differ in case/accents)
    const familias = familiasTasas.familias as Record<string, BlumonRates>
    let matchedFamilia = businessName
    for (const familiaName of Object.keys(familias)) {
      if (normalizeText(familiaName) === normalized) {
        matchedFamilia = familiaName
        break
      }
    }
    return {
      found: true,
      familia: matchedFamilia,
      rates: directFamiliaRates,
      matchType: 'exact_synonym',
      matchedTerm: matchedFamilia,
      nota: `Familia directa: ${matchedFamilia}`,
      confidence: 100,
    }
  }

  const words = normalized.split(' ').filter(w => w.length > 0)

  // 1. Exact synonym match
  const synonyms = businessSynonyms.synonyms as Record<string, { mcc: string; familia: string; nota: string }>

  if (synonyms[normalized]) {
    const match = synonyms[normalized]
    const rates = getRatesByFamilia(match.familia)
    return {
      found: true,
      mcc: match.mcc,
      familia: match.familia,
      rates,
      matchType: 'exact_synonym',
      matchedTerm: normalized,
      nota: match.nota,
      confidence: 100,
    }
  }

  // 2. Partial synonym match (check if any word matches)
  for (const word of words) {
    if (word.length >= 3 && synonyms[word]) {
      const match = synonyms[word]
      const rates = getRatesByFamilia(match.familia)
      return {
        found: true,
        mcc: match.mcc,
        familia: match.familia,
        rates,
        matchType: 'partial_synonym',
        matchedTerm: word,
        nota: match.nota,
        confidence: 85,
      }
    }
  }

  // 3. Check for compound matches (e.g., "comida rapida")
  for (let i = 0; i < words.length - 1; i++) {
    const compound = `${words[i]} ${words[i + 1]}`
    if (synonyms[compound]) {
      const match = synonyms[compound]
      const rates = getRatesByFamilia(match.familia)
      return {
        found: true,
        mcc: match.mcc,
        familia: match.familia,
        rates,
        matchType: 'exact_synonym',
        matchedTerm: compound,
        nota: match.nota,
        confidence: 95,
      }
    }
  }

  // 4. Fuzzy match against synonym keys
  for (const [key, value] of Object.entries(synonyms)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      const rates = getRatesByFamilia(value.familia)
      return {
        found: true,
        mcc: value.mcc,
        familia: value.familia,
        rates,
        matchType: 'fuzzy_description',
        matchedTerm: key,
        nota: value.nota,
        confidence: 70,
      }
    }
  }

  // 5. Default to "Otros" if not found
  const defaultRates = getRatesByFamilia('Otros')
  return {
    found: false,
    familia: 'Otros',
    rates: defaultRates,
    matchType: 'default',
    confidence: 0,
    nota: 'No se encontró coincidencia. Usando categoría "Otros" por defecto.',
  }
}

/**
 * Obtiene las tasas para una familia específica
 */
export function getRatesByFamilia(familiaName: string): BlumonRates | undefined {
  const familias = familiasTasas.familias as Record<string, BlumonRates>

  // Direct match
  if (familias[familiaName]) {
    return familias[familiaName]
  }

  // Normalized match
  const normalizedInput = normalizeText(familiaName)
  for (const [key, value] of Object.entries(familias)) {
    if (normalizeText(key) === normalizedInput) {
      return value
    }
  }

  return undefined
}

/**
 * Lista todas las familias disponibles con sus tasas
 */
export function listAllFamilias(): Array<{ familia: string; rates: BlumonRates }> {
  const familias = familiasTasas.familias as Record<string, BlumonRates>
  return Object.entries(familias).map(([familia, rates]) => ({
    familia,
    rates,
  }))
}

/**
 * Busca múltiples términos y devuelve el mejor match
 */
export function findBestMatch(terms: string[]): MCCLookupResult {
  let bestMatch: MCCLookupResult = {
    found: false,
    confidence: 0,
  }

  for (const term of terms) {
    const result = lookupRatesByBusinessName(term)
    if (result.confidence > bestMatch.confidence) {
      bestMatch = result
    }
  }

  return bestMatch
}

/**
 * Calcula el costo de procesamiento para una transacción
 */
export function calculateProcessingCost(
  amount: number,
  rates: BlumonRates,
  cardType: 'credito' | 'debito' | 'internacional' | 'amex',
): { rate: number; cost: number } {
  const rate = rates[cardType]
  const cost = (amount * rate) / 100
  return { rate, cost }
}

/**
 * VenueType to MCC search term mapping
 *
 * Maps Prisma VenueType enum values to search terms that match our business-synonyms.json
 * This allows automatic MCC lookup based on the venue's type selected during onboarding.
 */
const VENUE_TYPE_TO_SEARCH_TERM: Record<string, string> = {
  // === FOOD_SERVICE Category ===
  RESTAURANT: 'restaurante',
  BAR: 'bar',
  CAFE: 'cafe',
  BAKERY: 'panaderia',
  FOOD_TRUCK: 'food truck',
  FAST_FOOD: 'comida rapida',
  CATERING: 'restaurante', // Uses restaurant rates
  CLOUD_KITCHEN: 'restaurante', // Uses restaurant rates

  // === RETAIL Category ===
  RETAIL_STORE: 'retail',
  JEWELRY: 'joyeria',
  CLOTHING: 'boutique',
  ELECTRONICS: 'electronica',
  PHARMACY: 'farmacia',
  CONVENIENCE_STORE: 'tienda de conveniencia',
  SUPERMARKET: 'supermercado',
  LIQUOR_STORE: 'retail', // Uses general retail rates
  FURNITURE: 'retail',
  HARDWARE: 'ferreteria',
  BOOKSTORE: 'libreria',
  PET_STORE: 'retail',

  // === SERVICES Category ===
  SALON: 'salon de belleza',
  SPA: 'spa',
  FITNESS: 'fitness',
  CLINIC: 'clinica medica',
  VETERINARY: 'veterinaria',
  AUTO_SERVICE: 'taller mecanico',
  LAUNDRY: 'lavanderia',
  REPAIR_SHOP: 'retail', // Uses general retail rates

  // === HOSPITALITY Category ===
  HOTEL: 'hotel',
  HOSTEL: 'hostal',
  RESORT: 'hotel',

  // === ENTERTAINMENT Category ===
  CINEMA: 'cine',
  ARCADE: 'arcade',
  EVENT_VENUE: 'cine', // Uses entertainment rates
  NIGHTCLUB: 'antro',
  BOWLING: 'boliche',

  // === LEGACY ===
  HOTEL_RESTAURANT: 'restaurante',
  FITNESS_STUDIO: 'fitness',

  // === OTHER ===
  OTHER: 'otros',
}

/**
 * Looks up rates by VenueType enum value
 *
 * This is the preferred method when creating MerchantAccounts for venues,
 * as the venueType is already selected during onboarding.
 *
 * @param venueType - The VenueType enum value (e.g., 'FITNESS', 'RESTAURANT')
 * @returns MCCLookupResult with the rates for that venue type
 */
export function lookupRatesByVenueType(venueType: string): MCCLookupResult {
  const searchTerm = VENUE_TYPE_TO_SEARCH_TERM[venueType]

  if (!searchTerm) {
    // Unknown venue type, use default
    const defaultRates = getRatesByFamilia('Otros')
    return {
      found: false,
      familia: 'Otros',
      rates: defaultRates,
      matchType: 'default',
      confidence: 0,
      nota: `VenueType "${venueType}" no tiene mapeo definido. Usando categoría "Otros" por defecto.`,
    }
  }

  // Use the existing business name lookup with the mapped search term
  const result = lookupRatesByBusinessName(searchTerm)

  // If successful, add context about the VenueType mapping
  if (result.found) {
    return {
      ...result,
      nota: `VenueType: ${venueType} → ${searchTerm}. ${result.nota || ''}`.trim(),
    }
  }

  return result
}

/**
 * Get the mapping of VenueType to search terms
 * Useful for debugging or displaying in admin UI
 */
export function getVenueTypeMapping(): Record<string, string> {
  return { ...VENUE_TYPE_TO_SEARCH_TERM }
}

// Export types for external use
export type { BlumonRates as BlumonProcessingRates }
