/**
 * Business Category Helper
 *
 * Derives the high-level business category from a specific BusinessType.
 * Used for dashboard UI adaptation (Menu vs Catálogo vs Servicios).
 *
 * This approach avoids adding a separate BusinessCategory column to the database,
 * keeping the schema simple while still allowing UI customization.
 */

import { BusinessType } from '@prisma/client'

/**
 * High-level business category for UI adaptation
 */
export type BusinessCategory = 'FOOD_SERVICE' | 'RETAIL' | 'SERVICES' | 'HOSPITALITY' | 'ENTERTAINMENT' | 'OTHER'

/**
 * Mapping of BusinessType to BusinessCategory
 */
const CATEGORY_MAPPING: Record<BusinessType, BusinessCategory> = {
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

  // === SERVICES ===
  SALON: 'SERVICES',
  SPA: 'SERVICES',
  FITNESS: 'SERVICES',
  CLINIC: 'SERVICES',
  VETERINARY: 'SERVICES',
  AUTO_SERVICE: 'SERVICES',
  LAUNDRY: 'SERVICES',
  REPAIR_SHOP: 'SERVICES',

  // === HOSPITALITY ===
  HOTEL: 'HOSPITALITY',
  HOSTEL: 'HOSPITALITY',
  RESORT: 'HOSPITALITY',

  // === ENTERTAINMENT ===
  CINEMA: 'ENTERTAINMENT',
  ARCADE: 'ENTERTAINMENT',
  EVENT_VENUE: 'ENTERTAINMENT',
  NIGHTCLUB: 'ENTERTAINMENT',
  BOWLING: 'ENTERTAINMENT',

  // === OTHER ===
  OTHER: 'OTHER',
}

/**
 * Get the business category for a given business type
 */
export function getBusinessCategory(type: BusinessType): BusinessCategory {
  return CATEGORY_MAPPING[type] || 'OTHER'
}

/**
 * Check if a business type belongs to a specific category
 */
export function isBusinessCategory(type: BusinessType, category: BusinessCategory): boolean {
  return getBusinessCategory(type) === category
}

/**
 * Get all business types that belong to a specific category
 */
export function getBusinessTypesForCategory(category: BusinessCategory): BusinessType[] {
  return Object.entries(CATEGORY_MAPPING)
    .filter(([, cat]) => cat === category)
    .map(([type]) => type as BusinessType)
}

/**
 * UI Terminology mapping by business category
 * Used to adapt dashboard labels based on business type
 */
export const CATEGORY_TERMINOLOGY: Record<
  BusinessCategory,
  {
    menu: string
    menuPlural: string
    item: string
    itemPlural: string
    order: string
    orderPlural: string
    table: string
    tablePlural: string
  }
> = {
  FOOD_SERVICE: {
    menu: 'Menú',
    menuPlural: 'Menús',
    item: 'Platillo',
    itemPlural: 'Platillos',
    order: 'Orden',
    orderPlural: 'Órdenes',
    table: 'Mesa',
    tablePlural: 'Mesas',
  },
  RETAIL: {
    menu: 'Catálogo',
    menuPlural: 'Catálogos',
    item: 'Producto',
    itemPlural: 'Productos',
    order: 'Venta',
    orderPlural: 'Ventas',
    table: 'Caja',
    tablePlural: 'Cajas',
  },
  SERVICES: {
    menu: 'Servicios',
    menuPlural: 'Servicios',
    item: 'Servicio',
    itemPlural: 'Servicios',
    order: 'Cita',
    orderPlural: 'Citas',
    table: 'Estación',
    tablePlural: 'Estaciones',
  },
  HOSPITALITY: {
    menu: 'Servicios',
    menuPlural: 'Servicios',
    item: 'Servicio',
    itemPlural: 'Servicios',
    order: 'Reservación',
    orderPlural: 'Reservaciones',
    table: 'Habitación',
    tablePlural: 'Habitaciones',
  },
  ENTERTAINMENT: {
    menu: 'Eventos',
    menuPlural: 'Eventos',
    item: 'Evento',
    itemPlural: 'Eventos',
    order: 'Entrada',
    orderPlural: 'Entradas',
    table: 'Sala',
    tablePlural: 'Salas',
  },
  OTHER: {
    menu: 'Catálogo',
    menuPlural: 'Catálogos',
    item: 'Item',
    itemPlural: 'Items',
    order: 'Orden',
    orderPlural: 'Órdenes',
    table: 'Ubicación',
    tablePlural: 'Ubicaciones',
  },
}

/**
 * Get terminology for a specific business type
 */
export function getTerminology(type: BusinessType) {
  const category = getBusinessCategory(type)
  return CATEGORY_TERMINOLOGY[category]
}
