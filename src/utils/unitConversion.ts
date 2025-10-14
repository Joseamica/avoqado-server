import logger from '@/config/logger'
import { Unit, UnitType } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

/**
 * Unit metadata with conversion information
 */
export interface UnitMetadata {
  unit: Unit
  type: UnitType
  baseUnit: Unit // The base unit for this type (e.g., GRAM for WEIGHT)
  toBaseConversion: number // Factor to convert to base unit
  displayName: string
  displaySymbol: string
  pluralName?: string
}

/**
 * Complete unit metadata catalog
 */
export const UNIT_METADATA: Record<Unit, UnitMetadata> = {
  // Weight units (base: GRAM)
  [Unit.MILLIGRAM]: {
    unit: Unit.MILLIGRAM,
    type: UnitType.WEIGHT,
    baseUnit: Unit.GRAM,
    toBaseConversion: 0.001,
    displayName: 'Milligram',
    displaySymbol: 'mg',
    pluralName: 'Milligrams',
  },
  [Unit.GRAM]: {
    unit: Unit.GRAM,
    type: UnitType.WEIGHT,
    baseUnit: Unit.GRAM,
    toBaseConversion: 1,
    displayName: 'Gram',
    displaySymbol: 'g',
    pluralName: 'Grams',
  },
  [Unit.KILOGRAM]: {
    unit: Unit.KILOGRAM,
    type: UnitType.WEIGHT,
    baseUnit: Unit.GRAM,
    toBaseConversion: 1000,
    displayName: 'Kilogram',
    displaySymbol: 'kg',
    pluralName: 'Kilograms',
  },
  [Unit.TON]: {
    unit: Unit.TON,
    type: UnitType.WEIGHT,
    baseUnit: Unit.GRAM,
    toBaseConversion: 1000000,
    displayName: 'Ton',
    displaySymbol: 't',
    pluralName: 'Tons',
  },
  [Unit.OUNCE]: {
    unit: Unit.OUNCE,
    type: UnitType.WEIGHT,
    baseUnit: Unit.GRAM,
    toBaseConversion: 28.3495,
    displayName: 'Ounce',
    displaySymbol: 'oz',
    pluralName: 'Ounces',
  },
  [Unit.POUND]: {
    unit: Unit.POUND,
    type: UnitType.WEIGHT,
    baseUnit: Unit.GRAM,
    toBaseConversion: 453.592,
    displayName: 'Pound',
    displaySymbol: 'lb',
    pluralName: 'Pounds',
  },

  // Volume units (base: MILLILITER)
  [Unit.MILLILITER]: {
    unit: Unit.MILLILITER,
    type: UnitType.VOLUME,
    baseUnit: Unit.MILLILITER,
    toBaseConversion: 1,
    displayName: 'Milliliter',
    displaySymbol: 'ml',
    pluralName: 'Milliliters',
  },
  [Unit.LITER]: {
    unit: Unit.LITER,
    type: UnitType.VOLUME,
    baseUnit: Unit.MILLILITER,
    toBaseConversion: 1000,
    displayName: 'Liter',
    displaySymbol: 'L',
    pluralName: 'Liters',
  },
  [Unit.TEASPOON]: {
    unit: Unit.TEASPOON,
    type: UnitType.VOLUME,
    baseUnit: Unit.MILLILITER,
    toBaseConversion: 4.92892,
    displayName: 'Teaspoon',
    displaySymbol: 'tsp',
    pluralName: 'Teaspoons',
  },
  [Unit.TABLESPOON]: {
    unit: Unit.TABLESPOON,
    type: UnitType.VOLUME,
    baseUnit: Unit.MILLILITER,
    toBaseConversion: 14.7868,
    displayName: 'Tablespoon',
    displaySymbol: 'tbsp',
    pluralName: 'Tablespoons',
  },
  [Unit.FLUID_OUNCE]: {
    unit: Unit.FLUID_OUNCE,
    type: UnitType.VOLUME,
    baseUnit: Unit.MILLILITER,
    toBaseConversion: 29.5735,
    displayName: 'Fluid Ounce',
    displaySymbol: 'fl oz',
    pluralName: 'Fluid Ounces',
  },
  [Unit.CUP]: {
    unit: Unit.CUP,
    type: UnitType.VOLUME,
    baseUnit: Unit.MILLILITER,
    toBaseConversion: 236.588,
    displayName: 'Cup',
    displaySymbol: 'cup',
    pluralName: 'Cups',
  },
  [Unit.PINT]: {
    unit: Unit.PINT,
    type: UnitType.VOLUME,
    baseUnit: Unit.MILLILITER,
    toBaseConversion: 473.176,
    displayName: 'Pint',
    displaySymbol: 'pt',
    pluralName: 'Pints',
  },
  [Unit.QUART]: {
    unit: Unit.QUART,
    type: UnitType.VOLUME,
    baseUnit: Unit.MILLILITER,
    toBaseConversion: 946.353,
    displayName: 'Quart',
    displaySymbol: 'qt',
    pluralName: 'Quarts',
  },
  [Unit.GALLON]: {
    unit: Unit.GALLON,
    type: UnitType.VOLUME,
    baseUnit: Unit.MILLILITER,
    toBaseConversion: 3785.41,
    displayName: 'Gallon',
    displaySymbol: 'gal',
    pluralName: 'Gallons',
  },

  // Count units (base: UNIT)
  [Unit.UNIT]: {
    unit: Unit.UNIT,
    type: UnitType.COUNT,
    baseUnit: Unit.UNIT,
    toBaseConversion: 1,
    displayName: 'Unit',
    displaySymbol: 'unit',
    pluralName: 'Units',
  },
  [Unit.PIECE]: {
    unit: Unit.PIECE,
    type: UnitType.COUNT,
    baseUnit: Unit.UNIT,
    toBaseConversion: 1,
    displayName: 'Piece',
    displaySymbol: 'pc',
    pluralName: 'Pieces',
  },
  [Unit.DOZEN]: {
    unit: Unit.DOZEN,
    type: UnitType.COUNT,
    baseUnit: Unit.UNIT,
    toBaseConversion: 12,
    displayName: 'Dozen',
    displaySymbol: 'dz',
    pluralName: 'Dozens',
  },
  [Unit.CASE]: {
    unit: Unit.CASE,
    type: UnitType.COUNT,
    baseUnit: Unit.UNIT,
    toBaseConversion: 24, // Typical case size
    displayName: 'Case',
    displaySymbol: 'case',
    pluralName: 'Cases',
  },
  [Unit.BOX]: {
    unit: Unit.BOX,
    type: UnitType.COUNT,
    baseUnit: Unit.UNIT,
    toBaseConversion: 1,
    displayName: 'Box',
    displaySymbol: 'box',
    pluralName: 'Boxes',
  },
  [Unit.BAG]: {
    unit: Unit.BAG,
    type: UnitType.COUNT,
    baseUnit: Unit.UNIT,
    toBaseConversion: 1,
    displayName: 'Bag',
    displaySymbol: 'bag',
    pluralName: 'Bags',
  },
  [Unit.BOTTLE]: {
    unit: Unit.BOTTLE,
    type: UnitType.COUNT,
    baseUnit: Unit.UNIT,
    toBaseConversion: 1,
    displayName: 'Bottle',
    displaySymbol: 'btl',
    pluralName: 'Bottles',
  },
  [Unit.CAN]: {
    unit: Unit.CAN,
    type: UnitType.COUNT,
    baseUnit: Unit.UNIT,
    toBaseConversion: 1,
    displayName: 'Can',
    displaySymbol: 'can',
    pluralName: 'Cans',
  },
  [Unit.JAR]: {
    unit: Unit.JAR,
    type: UnitType.COUNT,
    baseUnit: Unit.UNIT,
    toBaseConversion: 1,
    displayName: 'Jar',
    displaySymbol: 'jar',
    pluralName: 'Jars',
  },

  // Length units (base: METER)
  [Unit.MILLIMETER]: {
    unit: Unit.MILLIMETER,
    type: UnitType.LENGTH,
    baseUnit: Unit.METER,
    toBaseConversion: 0.001,
    displayName: 'Millimeter',
    displaySymbol: 'mm',
    pluralName: 'Millimeters',
  },
  [Unit.CENTIMETER]: {
    unit: Unit.CENTIMETER,
    type: UnitType.LENGTH,
    baseUnit: Unit.METER,
    toBaseConversion: 0.01,
    displayName: 'Centimeter',
    displaySymbol: 'cm',
    pluralName: 'Centimeters',
  },
  [Unit.METER]: {
    unit: Unit.METER,
    type: UnitType.LENGTH,
    baseUnit: Unit.METER,
    toBaseConversion: 1,
    displayName: 'Meter',
    displaySymbol: 'm',
    pluralName: 'Meters',
  },
  [Unit.INCH]: {
    unit: Unit.INCH,
    type: UnitType.LENGTH,
    baseUnit: Unit.METER,
    toBaseConversion: 0.0254,
    displayName: 'Inch',
    displaySymbol: 'in',
    pluralName: 'Inches',
  },
  [Unit.FOOT]: {
    unit: Unit.FOOT,
    type: UnitType.LENGTH,
    baseUnit: Unit.METER,
    toBaseConversion: 0.3048,
    displayName: 'Foot',
    displaySymbol: 'ft',
    pluralName: 'Feet',
  },

  // Temperature units (base: CELSIUS)
  [Unit.CELSIUS]: {
    unit: Unit.CELSIUS,
    type: UnitType.TEMPERATURE,
    baseUnit: Unit.CELSIUS,
    toBaseConversion: 1,
    displayName: 'Celsius',
    displaySymbol: '°C',
    pluralName: 'Celsius',
  },
  [Unit.FAHRENHEIT]: {
    unit: Unit.FAHRENHEIT,
    type: UnitType.TEMPERATURE,
    baseUnit: Unit.CELSIUS,
    toBaseConversion: 1, // Special conversion formula needed
    displayName: 'Fahrenheit',
    displaySymbol: '°F',
    pluralName: 'Fahrenheit',
  },

  // Time units (base: MINUTE)
  [Unit.MINUTE]: {
    unit: Unit.MINUTE,
    type: UnitType.TIME,
    baseUnit: Unit.MINUTE,
    toBaseConversion: 1,
    displayName: 'Minute',
    displaySymbol: 'min',
    pluralName: 'Minutes',
  },
  [Unit.HOUR]: {
    unit: Unit.HOUR,
    type: UnitType.TIME,
    baseUnit: Unit.MINUTE,
    toBaseConversion: 60,
    displayName: 'Hour',
    displaySymbol: 'hr',
    pluralName: 'Hours',
  },
  [Unit.DAY]: {
    unit: Unit.DAY,
    type: UnitType.TIME,
    baseUnit: Unit.MINUTE,
    toBaseConversion: 1440,
    displayName: 'Day',
    displaySymbol: 'day',
    pluralName: 'Days',
  },
}

/**
 * Get unit metadata by unit enum
 */
export function getUnitMetadata(unit: Unit): UnitMetadata {
  return UNIT_METADATA[unit]
}

/**
 * Get unit type (WEIGHT, VOLUME, COUNT, etc.)
 */
export function getUnitType(unit: Unit): UnitType {
  return UNIT_METADATA[unit].type
}

/**
 * Check if two units are compatible for conversion (same type)
 */
export function areUnitsCompatible(fromUnit: Unit, toUnit: Unit): boolean {
  const fromMeta = UNIT_METADATA[fromUnit]
  const toMeta = UNIT_METADATA[toUnit]
  return fromMeta.type === toMeta.type
}

/**
 * Convert quantity from one unit to another
 * @throws Error if units are incompatible
 */
export function convertUnit(quantity: Decimal | number, fromUnit: Unit, toUnit: Unit): Decimal {
  if (fromUnit === toUnit) {
    return new Decimal(quantity)
  }

  const fromMeta = UNIT_METADATA[fromUnit]
  const toMeta = UNIT_METADATA[toUnit]

  // Check compatibility
  if (fromMeta.type !== toMeta.type) {
    throw new Error(`Cannot convert between incompatible unit types: ${fromMeta.type} and ${toMeta.type}`)
  }

  // Special handling for temperature
  if (fromMeta.type === UnitType.TEMPERATURE) {
    return convertTemperature(new Decimal(quantity), fromUnit, toUnit)
  }

  // Standard conversion: from -> base -> to
  // 1. Convert to base unit
  const inBaseUnit = new Decimal(quantity).mul(fromMeta.toBaseConversion)

  // 2. Convert from base unit to target unit
  const result = inBaseUnit.div(toMeta.toBaseConversion)

  return result
}

/**
 * Special temperature conversion (non-linear)
 */
function convertTemperature(value: Decimal, fromUnit: Unit, toUnit: Unit): Decimal {
  if (fromUnit === toUnit) return value

  if (fromUnit === Unit.CELSIUS && toUnit === Unit.FAHRENHEIT) {
    // C to F: (C × 9/5) + 32
    return value.mul(9).div(5).add(32)
  } else if (fromUnit === Unit.FAHRENHEIT && toUnit === Unit.CELSIUS) {
    // F to C: (F - 32) × 5/9
    return value.sub(32).mul(5).div(9)
  }

  return value
}

/**
 * Format unit display with quantity
 */
export function formatQuantityWithUnit(quantity: Decimal | number, unit: Unit, usePlural = true): string {
  const meta = UNIT_METADATA[unit]
  const qty = new Decimal(quantity)

  // Use plural if quantity is not 1 and plural name exists
  const shouldUsePlural = usePlural && !qty.equals(1) && meta.pluralName
  const name = shouldUsePlural ? meta.pluralName : meta.displayName

  return `${qty.toFixed()} ${name}`
}

/**
 * Get all units of a specific type
 */
export function getUnitsByType(type: UnitType): Unit[] {
  return Object.values(Unit).filter(unit => UNIT_METADATA[unit]?.type === type)
}

/**
 * Normalize string unit to Unit enum (migration helper)
 */
export function normalizeStringToUnit(unitString: string): Unit {
  const normalized = unitString.toUpperCase().trim()

  // Direct mappings
  const directMap: Record<string, Unit> = {
    // Weight
    G: Unit.GRAM,
    KG: Unit.KILOGRAM,
    KILOGRAM: Unit.KILOGRAM,
    KILOGRAMS: Unit.KILOGRAM,
    GRAM: Unit.GRAM,
    GRAMS: Unit.GRAM,
    MG: Unit.MILLIGRAM,
    MILLIGRAM: Unit.MILLIGRAM,
    OZ: Unit.OUNCE,
    OUNCE: Unit.OUNCE,
    LB: Unit.POUND,
    POUND: Unit.POUND,
    TON: Unit.TON,

    // Volume
    ML: Unit.MILLILITER,
    MILLILITER: Unit.MILLILITER,
    L: Unit.LITER,
    LITER: Unit.LITER,
    LITERS: Unit.LITER,
    GAL: Unit.GALLON,
    GALLON: Unit.GALLON,
    QT: Unit.QUART,
    QUART: Unit.QUART,
    PT: Unit.PINT,
    PINT: Unit.PINT,
    CUP: Unit.CUP,
    CUPS: Unit.CUP,
    TSP: Unit.TEASPOON,
    TEASPOON: Unit.TEASPOON,
    TBSP: Unit.TABLESPOON,
    TABLESPOON: Unit.TABLESPOON,
    'FL OZ': Unit.FLUID_OUNCE,
    FLOZ: Unit.FLUID_OUNCE,

    // Count
    UNIT: Unit.UNIT,
    UNITS: Unit.UNIT,
    PIECE: Unit.PIECE,
    PIECES: Unit.PIECE,
    PC: Unit.PIECE,
    PCS: Unit.PIECE,
    PZA: Unit.PIECE, // Spanish: pieza
    PZAS: Unit.PIECE,
    DZ: Unit.DOZEN,
    DOZEN: Unit.DOZEN,
    CASE: Unit.CASE,
    CASES: Unit.CASE,
    BOX: Unit.BOX,
    BOXES: Unit.BOX,
    BAG: Unit.BAG,
    BAGS: Unit.BAG,
    BOTTLE: Unit.BOTTLE,
    BOTTLES: Unit.BOTTLE,
    BTL: Unit.BOTTLE,
    CAN: Unit.CAN,
    CANS: Unit.CAN,
    JAR: Unit.JAR,
    JARS: Unit.JAR,

    // Length
    MM: Unit.MILLIMETER,
    CM: Unit.CENTIMETER,
    M: Unit.METER,
    METER: Unit.METER,
    IN: Unit.INCH,
    INCH: Unit.INCH,
    FT: Unit.FOOT,
    FOOT: Unit.FOOT,
    FEET: Unit.FOOT,
  }

  const mapped = directMap[normalized]
  if (mapped) {
    return mapped
  }

  // Default fallback to UNIT if no match
  logger.warn(`Unknown unit string "${unitString}", defaulting to UNIT`)
  return Unit.UNIT
}

/**
 * Get base unit for a given unit type
 */
export function getBaseUnit(type: UnitType): Unit {
  switch (type) {
    case UnitType.WEIGHT:
      return Unit.GRAM
    case UnitType.VOLUME:
      return Unit.MILLILITER
    case UnitType.COUNT:
      return Unit.UNIT
    case UnitType.LENGTH:
      return Unit.METER
    case UnitType.TEMPERATURE:
      return Unit.CELSIUS
    case UnitType.TIME:
      return Unit.MINUTE
    default:
      throw new Error(`Unknown unit type: ${type}`)
  }
}
