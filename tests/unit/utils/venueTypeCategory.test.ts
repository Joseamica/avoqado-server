import { VenueType } from '@prisma/client'
import { venueTypeToCategory, categoryOfVenueType } from '../../../src/utils/venueTypeCategory'

describe('venueTypeCategory', () => {
  // ===== CASOS NUEVOS =====
  it('clasifica los tres valores que el helper viejo no tenia', () => {
    expect(categoryOfVenueType(VenueType.TELECOMUNICACIONES)).toBe('RETAIL')
    expect(categoryOfVenueType(VenueType.HOTEL_RESTAURANT)).toBe('HOSPITALITY')
    expect(categoryOfVenueType(VenueType.FITNESS_STUDIO)).toBe('SERVICES')
  })

  it('clasifica ejemplos representativos de cada categoria', () => {
    expect(categoryOfVenueType(VenueType.RESTAURANT)).toBe('FOOD_SERVICE')
    expect(categoryOfVenueType(VenueType.PHARMACY)).toBe('RETAIL')
    expect(categoryOfVenueType(VenueType.SALON)).toBe('SERVICES')
    expect(categoryOfVenueType(VenueType.HOTEL)).toBe('HOSPITALITY')
    expect(categoryOfVenueType(VenueType.CINEMA)).toBe('ENTERTAINMENT')
    expect(categoryOfVenueType(VenueType.OTHER)).toBe('OTHER')
  })

  // ===== REGRESION / GUARDIA =====
  it('cubre TODOS los VenueType: agregar uno nuevo sin clasificar rompe aqui', () => {
    const sinClasificar = Object.values(VenueType).filter(t => !(t in venueTypeToCategory))
    expect(sinClasificar).toEqual([])
  })
})
