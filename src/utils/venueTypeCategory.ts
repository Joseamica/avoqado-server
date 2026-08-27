import { VenueType } from '@prisma/client'
import type { BusinessCategory } from './businessCategory'

/**
 * VenueType -> categoría de negocio, para segmentar anuncios de plataforma por giro.
 *
 * 🔴 NO reusar `getBusinessCategory()` de `businessCategory.ts`: ese opera sobre el enum
 * `BusinessType`, que es DISTINTO de `VenueType` y no contiene `TELECOMUNICACIONES`,
 * `HOTEL_RESTAURANT` ni `FITNESS_STUDIO`. Reusarlo no compila, o clasifica mal en silencio.
 *
 * La anotación `Record<VenueType, ...>` es deliberada: agregar un `VenueType` nuevo sin
 * clasificarlo ROMPE el typecheck, en vez de caer en 'OTHER' sin que nadie se entere.
 */
export const venueTypeToCategory: Record<VenueType, BusinessCategory> = {
  // === FOOD_SERVICE ===
  RESTAURANT: 'FOOD_SERVICE',
  BAR: 'FOOD_SERVICE',
  CAFE: 'FOOD_SERVICE',
  BAKERY: 'FOOD_SERVICE',
  FOOD_TRUCK: 'FOOD_SERVICE',
  FAST_FOOD: 'FOOD_SERVICE',
  CATERING: 'FOOD_SERVICE',
  CLOUD_KITCHEN: 'FOOD_SERVICE',

  // === RETAIL ===
  RETAIL_STORE: 'RETAIL',
  JEWELRY: 'RETAIL',
  CLOTHING: 'RETAIL',
  ELECTRONICS: 'RETAIL',
  PHARMACY: 'RETAIL',
  CONVENIENCE_STORE: 'RETAIL',
  SUPERMARKET: 'RETAIL',
  LIQUOR_STORE: 'RETAIL',
  FURNITURE: 'RETAIL',
  HARDWARE: 'RETAIL',
  BOOKSTORE: 'RETAIL',
  PET_STORE: 'RETAIL',
  TELECOMUNICACIONES: 'RETAIL',

  // === SERVICES ===
  SALON: 'SERVICES',
  SPA: 'SERVICES',
  FITNESS: 'SERVICES',
  CLINIC: 'SERVICES',
  VETERINARY: 'SERVICES',
  AUTO_SERVICE: 'SERVICES',
  LAUNDRY: 'SERVICES',
  REPAIR_SHOP: 'SERVICES',
  FITNESS_STUDIO: 'SERVICES',

  // === HOSPITALITY ===
  HOTEL: 'HOSPITALITY',
  HOSTEL: 'HOSPITALITY',
  RESORT: 'HOSPITALITY',
  HOTEL_RESTAURANT: 'HOSPITALITY',

  // === ENTERTAINMENT ===
  CINEMA: 'ENTERTAINMENT',
  ARCADE: 'ENTERTAINMENT',
  EVENT_VENUE: 'ENTERTAINMENT',
  NIGHTCLUB: 'ENTERTAINMENT',
  BOWLING: 'ENTERTAINMENT',

  OTHER: 'OTHER',
}

export function categoryOfVenueType(type: VenueType): BusinessCategory {
  return venueTypeToCategory[type] ?? 'OTHER'
}
