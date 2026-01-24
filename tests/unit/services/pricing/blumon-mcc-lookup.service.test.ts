/**
 * Exhaustive tests for Blumon MCC Lookup Service
 */

import {
  lookupRatesByBusinessName,
  getRatesByFamilia,
  listAllFamilias,
  calculateProcessingCost,
  findBestMatch,
  BlumonRates,
} from '../../../../src/services/pricing/blumon-mcc-lookup.service'

describe('BlumonMCCLookupService', () => {
  describe('lookupRatesByBusinessName', () => {
    describe('VenueType enum mappings (English)', () => {
      const venueTypeMappings: Array<{
        input: string
        expectedFamilia: string
        minConfidence: number
      }> = [
        // Food & Beverage
        { input: 'RESTAURANT', expectedFamilia: 'Restaurantes', minConfidence: 70 },
        { input: 'BAR', expectedFamilia: 'Restaurantes', minConfidence: 100 },
        { input: 'CAFE', expectedFamilia: 'Restaurantes', minConfidence: 100 },
        { input: 'BAKERY', expectedFamilia: 'Ventas al detalle (Retail)', minConfidence: 100 },
        { input: 'FOOD_TRUCK', expectedFamilia: 'Comida rápida', minConfidence: 95 },
        { input: 'FAST_FOOD', expectedFamilia: 'Comida rápida', minConfidence: 95 },

        // Beauty & Wellness
        { input: 'SALON', expectedFamilia: 'Salones de belleza', minConfidence: 100 },
        { input: 'SPA', expectedFamilia: 'Salones de belleza', minConfidence: 100 },
        { input: 'FITNESS', expectedFamilia: 'Entretenimiento', minConfidence: 100 },

        // Healthcare
        { input: 'CLINIC', expectedFamilia: 'Médicos y dentistas', minConfidence: 100 },
        { input: 'VETERINARY', expectedFamilia: 'Médicos y dentistas', minConfidence: 100 },
        { input: 'PHARMACY', expectedFamilia: 'Farmacias', minConfidence: 100 },

        // Retail
        { input: 'RETAIL_STORE', expectedFamilia: 'Ventas al detalle (Retail)', minConfidence: 95 },
        { input: 'JEWELRY', expectedFamilia: 'Ventas al detalle (Retail)', minConfidence: 100 },
        { input: 'SUPERMARKET', expectedFamilia: 'Supermercados', minConfidence: 100 },

        // Hospitality & Transport
        { input: 'HOTEL', expectedFamilia: 'Hoteles', minConfidence: 100 },
        { input: 'GAS_STATION', expectedFamilia: 'Gasolineras', minConfidence: 95 },
      ]

      test.each(venueTypeMappings)(
        '$input should map to $expectedFamilia with >= $minConfidence% confidence',
        ({ input, expectedFamilia, minConfidence }) => {
          const result = lookupRatesByBusinessName(input)
          expect(result.familia).toBe(expectedFamilia)
          expect(result.confidence).toBeGreaterThanOrEqual(minConfidence)
          expect(result.rates).toBeDefined()
        },
      )
    })

    describe('Spanish business names (exact matches)', () => {
      const spanishExactMatches: Array<{
        input: string
        expectedFamilia: string
      }> = [
        // Fitness
        { input: 'gimnasio', expectedFamilia: 'Entretenimiento' },
        { input: 'yoga', expectedFamilia: 'Entretenimiento' },
        { input: 'pilates', expectedFamilia: 'Entretenimiento' },
        { input: 'crossfit', expectedFamilia: 'Entretenimiento' },

        // Restaurants
        { input: 'restaurante', expectedFamilia: 'Restaurantes' },
        { input: 'taqueria', expectedFamilia: 'Restaurantes' },
        { input: 'cafeteria', expectedFamilia: 'Restaurantes' },
        { input: 'mariscos', expectedFamilia: 'Restaurantes' },
        { input: 'sushi', expectedFamilia: 'Restaurantes' },

        // Bars
        { input: 'bar', expectedFamilia: 'Restaurantes' },
        { input: 'antro', expectedFamilia: 'Restaurantes' },
        { input: 'discoteca', expectedFamilia: 'Restaurantes' },
        { input: 'mezcaleria', expectedFamilia: 'Restaurantes' },

        // Fast food
        { input: 'comida rapida', expectedFamilia: 'Comida rápida' },
        { input: 'hamburguesas', expectedFamilia: 'Comida rápida' },
        { input: 'food truck', expectedFamilia: 'Comida rápida' },

        // Beauty
        { input: 'salon de belleza', expectedFamilia: 'Salones de belleza' },
        { input: 'barberia', expectedFamilia: 'Salones de belleza' },
        { input: 'estetica', expectedFamilia: 'Salones de belleza' },
        { input: 'peluqueria', expectedFamilia: 'Salones de belleza' },

        // Healthcare
        { input: 'dentista', expectedFamilia: 'Médicos y dentistas' },
        { input: 'medico', expectedFamilia: 'Médicos y dentistas' },
        { input: 'consultorio medico', expectedFamilia: 'Médicos y dentistas' },
        { input: 'veterinaria', expectedFamilia: 'Médicos y dentistas' },

        // Hospitals
        { input: 'hospital', expectedFamilia: 'Hospitales' },
        { input: 'clinica', expectedFamilia: 'Hospitales' },

        // Pharmacy
        { input: 'farmacia', expectedFamilia: 'Farmacias' },

        // Education
        { input: 'guarderia', expectedFamilia: 'Guarderías' },
        { input: 'kinder', expectedFamilia: 'Educación básica' },
        { input: 'universidad', expectedFamilia: 'Colegios y universidades' },

        // Hotels
        { input: 'hotel', expectedFamilia: 'Hoteles' },
        { input: 'motel', expectedFamilia: 'Hoteles' },
        { input: 'hostal', expectedFamilia: 'Hoteles' },

        // Retail
        { input: 'tienda de ropa', expectedFamilia: 'Ventas al detalle (Retail)' },
        { input: 'joyeria', expectedFamilia: 'Ventas al detalle (Retail)' },
        { input: 'zapateria', expectedFamilia: 'Ventas al detalle (Retail)' },

        // Hardware
        { input: 'ferreteria', expectedFamilia: 'Refacciones y ferreterías' },
        { input: 'tlapaleria', expectedFamilia: 'Refacciones y ferreterías' },

        // Supermarkets
        { input: 'supermercado', expectedFamilia: 'Supermercados' },

        // Misc stores
        { input: 'miscelanea', expectedFamilia: 'Misceláneas' },
        { input: 'abarrotes', expectedFamilia: 'Misceláneas' },

        // Gas stations
        { input: 'gasolinera', expectedFamilia: 'Gasolineras' },

        // Parking
        { input: 'estacionamiento', expectedFamilia: 'Estacionamientos' },

        // Entertainment
        { input: 'cine', expectedFamilia: 'Entretenimiento' },
        { input: 'teatro', expectedFamilia: 'Entretenimiento' },
        { input: 'boliche', expectedFamilia: 'Entretenimiento' },
        { input: 'museo', expectedFamilia: 'Entretenimiento' },

        // Travel
        { input: 'agencia de viajes', expectedFamilia: 'Agencias de viajes' },
      ]

      test.each(spanishExactMatches)('"$input" should map to $expectedFamilia', ({ input, expectedFamilia }) => {
        const result = lookupRatesByBusinessName(input)
        expect(result.familia).toBe(expectedFamilia)
        expect(result.found).toBe(true)
      })
    })

    describe('Compound business names (partial matches)', () => {
      const compoundNames: Array<{
        input: string
        expectedFamilia: string
        minConfidence: number
      }> = [
        { input: 'Gimnasio CrossFit Box', expectedFamilia: 'Entretenimiento', minConfidence: 85 },
        { input: 'Estudio de Yoga Zen', expectedFamilia: 'Entretenimiento', minConfidence: 85 },
        { input: 'Restaurante El Mexicano', expectedFamilia: 'Restaurantes', minConfidence: 85 },
        { input: 'Taquería El Güero', expectedFamilia: 'Restaurantes', minConfidence: 85 },
        { input: 'Mariscos La Costa Azul', expectedFamilia: 'Restaurantes', minConfidence: 85 },
        { input: 'Bar de Mezcal Oaxaca', expectedFamilia: 'Restaurantes', minConfidence: 85 },
        { input: 'Salón de Belleza Lupita', expectedFamilia: 'Salones de belleza', minConfidence: 85 },
        { input: 'Consultorio Médico Dr. García', expectedFamilia: 'Médicos y dentistas', minConfidence: 85 },
        { input: 'Hospital General del Sur', expectedFamilia: 'Hospitales', minConfidence: 85 },
        { input: 'Farmacia San José', expectedFamilia: 'Farmacias', minConfidence: 85 },
        { input: 'Hotel Boutique Paraíso', expectedFamilia: 'Hoteles', minConfidence: 85 },
        { input: 'Supermercado La Comercial', expectedFamilia: 'Supermercados', minConfidence: 85 },
        { input: 'Ferretería El Tornillo', expectedFamilia: 'Refacciones y ferreterías', minConfidence: 85 },
        { input: 'Agencia de Viajes Mundo Tours', expectedFamilia: 'Agencias de viajes', minConfidence: 70 },
      ]

      test.each(compoundNames)(
        '"$input" should map to $expectedFamilia with >= $minConfidence% confidence',
        ({ input, expectedFamilia, minConfidence }) => {
          const result = lookupRatesByBusinessName(input)
          expect(result.familia).toBe(expectedFamilia)
          expect(result.confidence).toBeGreaterThanOrEqual(minConfidence)
        },
      )
    })

    describe('Studio variations (user requirement)', () => {
      const studioVariations = [
        'Studio',
        'studio',
        'STUDIO',
        'Estudio',
        'Estudio de Yoga',
        'Pilates Studio',
        'Fitness Studio',
        'CrossFit Studio',
        'Dance Studio',
        'Spinning Studio',
      ]

      test.each(studioVariations)('"%s" should map to Entretenimiento', input => {
        const result = lookupRatesByBusinessName(input)
        expect(result.familia).toBe('Entretenimiento')
        expect(result.confidence).toBeGreaterThanOrEqual(70)
      })
    })

    describe('Case insensitivity', () => {
      const caseCombinations = [
        { input: 'RESTAURANTE', expected: 'Restaurantes' },
        { input: 'restaurante', expected: 'Restaurantes' },
        { input: 'Restaurante', expected: 'Restaurantes' },
        { input: 'ReStAuRaNtE', expected: 'Restaurantes' },
        { input: 'GIMNASIO', expected: 'Entretenimiento' },
        { input: 'gimnasio', expected: 'Entretenimiento' },
        { input: 'Gimnasio', expected: 'Entretenimiento' },
      ]

      test.each(caseCombinations)('$input should map to $expected regardless of case', ({ input, expected }) => {
        const result = lookupRatesByBusinessName(input)
        expect(result.familia).toBe(expected)
      })
    })

    describe('Accent normalization', () => {
      const accentVariations = [
        { input: 'cafetería', expected: 'Restaurantes' },
        { input: 'cafeteria', expected: 'Restaurantes' },
        { input: 'estética', expected: 'Salones de belleza' },
        { input: 'estetica', expected: 'Salones de belleza' },
        { input: 'peluquería', expected: 'Salones de belleza' },
        { input: 'peluqueria', expected: 'Salones de belleza' },
        { input: 'médico', expected: 'Médicos y dentistas' },
        { input: 'medico', expected: 'Médicos y dentistas' },
        { input: 'panadería', expected: 'Ventas al detalle (Retail)' },
        { input: 'panaderia', expected: 'Ventas al detalle (Retail)' },
      ]

      test.each(accentVariations)('"$input" should map to $expected with or without accents', ({ input, expected }) => {
        const result = lookupRatesByBusinessName(input)
        expect(result.familia).toBe(expected)
      })
    })

    describe('Special characters handling', () => {
      const specialCharCases = [
        { input: 'Taquería "El Güero"', expectedFamilia: 'Restaurantes' },
        { input: "Mariscos 'La Costa'", expectedFamilia: 'Restaurantes' },
        { input: 'Café & Bistro', expectedFamilia: 'Restaurantes' },
        { input: 'Spa/Salón', expectedFamilia: 'Salones de belleza' },
        { input: 'Gimnasio #1', expectedFamilia: 'Entretenimiento' },
        { input: 'Hotel ***', expectedFamilia: 'Hoteles' },
      ]

      test.each(specialCharCases)('"$input" should handle special characters and map correctly', ({ input, expectedFamilia }) => {
        const result = lookupRatesByBusinessName(input)
        expect(result.familia).toBe(expectedFamilia)
      })
    })

    describe('Default fallback behavior', () => {
      const unknownBusinesses = [
        'XYZ Corporation',
        'ABC Industries',
        'Negocio Raro No Clasificado',
        'Lorem Ipsum LLC',
        '12345',
        'zzzzzzz',
        'qwertyuiop',
      ]

      test.each(unknownBusinesses)('"%s" should fallback to "Otros"', input => {
        const result = lookupRatesByBusinessName(input)
        expect(result.found).toBe(false)
        expect(result.familia).toBe('Otros')
        expect(result.matchType).toBe('default')
        expect(result.confidence).toBe(0)
        expect(result.rates).toBeDefined()
      })
    })

    describe('Edge cases', () => {
      test('empty string should fallback to Otros', () => {
        const result = lookupRatesByBusinessName('')
        expect(result.familia).toBe('Otros')
        expect(result.confidence).toBe(0)
      })

      test('whitespace only should fallback to Otros', () => {
        const result = lookupRatesByBusinessName('   ')
        expect(result.familia).toBe('Otros')
        expect(result.confidence).toBe(0)
      })

      test('single character should fallback to Otros', () => {
        const result = lookupRatesByBusinessName('a')
        expect(result.familia).toBe('Otros')
        expect(result.confidence).toBe(0)
      })

      test('two character word should fallback to Otros', () => {
        const result = lookupRatesByBusinessName('ab')
        expect(result.familia).toBe('Otros')
        expect(result.confidence).toBe(0)
      })

      test('numbers only should fallback to Otros', () => {
        const result = lookupRatesByBusinessName('123456')
        expect(result.familia).toBe('Otros')
        expect(result.confidence).toBe(0)
      })

      test('very long input should still work', () => {
        const longName = 'Restaurante '.repeat(50)
        const result = lookupRatesByBusinessName(longName)
        expect(result.familia).toBe('Restaurantes')
      })
    })

    describe('Match type accuracy', () => {
      test('exact synonym match should return matchType "exact_synonym"', () => {
        const result = lookupRatesByBusinessName('gimnasio')
        expect(result.matchType).toBe('exact_synonym')
        expect(result.confidence).toBe(100)
      })

      test('partial synonym match should return matchType "partial_synonym"', () => {
        const result = lookupRatesByBusinessName('Mi Gimnasio Fitness Center')
        expect(result.matchType).toBe('partial_synonym')
        expect(result.confidence).toBe(85)
      })

      test('compound match should return matchType "exact_synonym" with 95% confidence', () => {
        const result = lookupRatesByBusinessName('comida rapida')
        expect(result.matchType).toBe('exact_synonym')
        expect(result.confidence).toBe(100)
      })

      test('fuzzy match should return matchType "fuzzy_description"', () => {
        // This tests when the input contains or is contained by a synonym key
        const result = lookupRatesByBusinessName('RESTAURANT')
        expect(result.matchType).toBe('fuzzy_description')
        expect(result.confidence).toBe(70)
      })
    })
  })

  describe('getRatesByFamilia', () => {
    describe('All familias should return valid rates', () => {
      const expectedFamilias = [
        'Beneficiencia',
        'Educación básica',
        'Guarderías',
        'Médicos y dentistas',
        'Misceláneas',
        'Refacciones y ferreterías',
        'Salones de belleza',
        'Gasolineras',
        'Gobierno',
        'Estacionamientos',
        'Colegios y universidades',
        'Comida rápida',
        'Entretenimiento',
        'Peaje',
        'Transporte Terrestre de pasajeros',
        'Telecomunicaciones',
        'Transporte Aéreo',
        'Hospitales',
        'Otros',
        'Supermercados',
        'Ventas al menudeo',
        'Aseguradoras',
        'Agencias de viajes',
        'Hoteles',
        'Renta de autos',
        'Restaurantes',
        'Agregadores',
        'Farmacias',
        'Ventas al detalle (Retail)',
      ]

      test.each(expectedFamilias)('"%s" should return valid rates', familia => {
        const rates = getRatesByFamilia(familia)
        expect(rates).toBeDefined()
        expect(rates!.credito).toBeGreaterThan(0)
        expect(rates!.debito).toBeGreaterThan(0)
        expect(rates!.internacional).toBeGreaterThan(0)
        expect(rates!.amex).toBeGreaterThan(0)
      })
    })

    test('non-existent familia should return undefined', () => {
      const rates = getRatesByFamilia('Familia Inexistente')
      expect(rates).toBeUndefined()
    })

    test('case-insensitive familia lookup should work', () => {
      const rates = getRatesByFamilia('restaurantes')
      expect(rates).toBeDefined()
      expect(rates!.credito).toBe(2.3)
    })

    test('accent-insensitive familia lookup should work', () => {
      const rates = getRatesByFamilia('Educacion basica')
      expect(rates).toBeDefined()
    })
  })

  describe('listAllFamilias', () => {
    test('should return 29 familias', () => {
      const familias = listAllFamilias()
      expect(familias.length).toBe(29)
    })

    test('each familia should have valid structure', () => {
      const familias = listAllFamilias()
      familias.forEach(({ familia, rates }) => {
        expect(typeof familia).toBe('string')
        expect(familia.length).toBeGreaterThan(0)
        expect(rates.credito).toBeGreaterThanOrEqual(1)
        expect(rates.credito).toBeLessThanOrEqual(3)
        expect(rates.debito).toBeGreaterThanOrEqual(1)
        expect(rates.debito).toBeLessThanOrEqual(2)
        expect(rates.internacional).toBe(3.3)
        expect(rates.amex).toBe(3)
      })
    })

    test('should include key familias', () => {
      const familias = listAllFamilias()
      const familiaNames = familias.map(f => f.familia)

      expect(familiaNames).toContain('Restaurantes')
      expect(familiaNames).toContain('Entretenimiento')
      expect(familiaNames).toContain('Salones de belleza')
      expect(familiaNames).toContain('Médicos y dentistas')
      expect(familiaNames).toContain('Hoteles')
      expect(familiaNames).toContain('Otros')
    })
  })

  describe('calculateProcessingCost', () => {
    const testRates: BlumonRates = {
      credito: 2.3,
      debito: 1.68,
      internacional: 3.3,
      amex: 3.0,
    }

    describe('Basic calculations', () => {
      test('should calculate credit card cost correctly', () => {
        const result = calculateProcessingCost(1000, testRates, 'credito')
        expect(result.rate).toBe(2.3)
        expect(result.cost).toBe(23)
      })

      test('should calculate debit card cost correctly', () => {
        const result = calculateProcessingCost(1000, testRates, 'debito')
        expect(result.rate).toBe(1.68)
        expect(result.cost).toBe(16.8)
      })

      test('should calculate international card cost correctly', () => {
        const result = calculateProcessingCost(1000, testRates, 'internacional')
        expect(result.rate).toBe(3.3)
        expect(result.cost).toBe(33)
      })

      test('should calculate amex cost correctly', () => {
        const result = calculateProcessingCost(1000, testRates, 'amex')
        expect(result.rate).toBe(3.0)
        expect(result.cost).toBe(30)
      })
    })

    describe('Edge cases', () => {
      test('should handle zero amount', () => {
        const result = calculateProcessingCost(0, testRates, 'credito')
        expect(result.cost).toBe(0)
      })

      test('should handle decimal amounts', () => {
        const result = calculateProcessingCost(99.99, testRates, 'credito')
        expect(result.cost).toBeCloseTo(2.29977, 4)
      })

      test('should handle large amounts', () => {
        const result = calculateProcessingCost(1000000, testRates, 'credito')
        expect(result.cost).toBe(23000)
      })

      test('should handle small amounts', () => {
        const result = calculateProcessingCost(1, testRates, 'credito')
        expect(result.cost).toBe(0.023)
      })
    })

    describe('Real-world scenarios', () => {
      test('Restaurant $500 MXN credit card transaction', () => {
        const restaurantResult = lookupRatesByBusinessName('restaurante')
        const { cost } = calculateProcessingCost(500, restaurantResult.rates!, 'credito')
        expect(cost).toBe(11.5) // 500 * 2.3%
      })

      test('Gym $1000 MXN debit card transaction', () => {
        const gymResult = lookupRatesByBusinessName('gimnasio')
        const { cost } = calculateProcessingCost(1000, gymResult.rates!, 'debito')
        expect(cost).toBe(16.3) // 1000 * 1.63%
      })

      test('Salon $300 MXN credit card transaction', () => {
        const salonResult = lookupRatesByBusinessName('salon de belleza')
        const { cost } = calculateProcessingCost(300, salonResult.rates!, 'credito')
        expect(cost).toBe(3) // 300 * 1.0%
      })

      test('International card at hotel', () => {
        const hotelResult = lookupRatesByBusinessName('hotel')
        const { cost } = calculateProcessingCost(5000, hotelResult.rates!, 'internacional')
        expect(cost).toBe(165) // 5000 * 3.3%
      })
    })
  })

  describe('findBestMatch', () => {
    test('should return best match from multiple terms', () => {
      const terms = ['xyz', 'restaurante', 'abc']
      const result = findBestMatch(terms)
      expect(result.familia).toBe('Restaurantes')
      expect(result.confidence).toBe(100)
    })

    test('should return highest confidence match', () => {
      const terms = ['restaurant', 'RESTAURANTE'] // fuzzy vs will match restaurante
      const result = findBestMatch(terms)
      expect(result.confidence).toBeGreaterThanOrEqual(70)
    })

    test('should handle all unknown terms', () => {
      const terms = ['xyz', 'abc', '123']
      const result = findBestMatch(terms)
      expect(result.found).toBe(false)
      expect(result.confidence).toBe(0)
    })

    test('should handle empty array', () => {
      const result = findBestMatch([])
      expect(result.found).toBe(false)
      expect(result.confidence).toBe(0)
    })

    test('should handle single term', () => {
      const result = findBestMatch(['gimnasio'])
      expect(result.familia).toBe('Entretenimiento')
      expect(result.confidence).toBe(100)
    })
  })

  describe('Rate consistency checks', () => {
    test('Beneficencia should have lowest rates (1%)', () => {
      const rates = getRatesByFamilia('Beneficiencia')
      expect(rates!.credito).toBe(1.0)
      expect(rates!.debito).toBe(1.0)
    })

    test('Restaurantes should have higher rates', () => {
      const rates = getRatesByFamilia('Restaurantes')
      expect(rates!.credito).toBe(2.3)
      expect(rates!.debito).toBe(1.68)
    })

    test('International rates should be consistent at 3.3%', () => {
      const familias = listAllFamilias()
      familias.forEach(({ rates }) => {
        expect(rates.internacional).toBe(3.3)
      })
    })

    test('Amex rates should be consistent at 3.0%', () => {
      const familias = listAllFamilias()
      familias.forEach(({ rates }) => {
        expect(rates.amex).toBe(3.0)
      })
    })

    test('Debit should always be <= Credit', () => {
      const familias = listAllFamilias()
      familias.forEach(({ rates }) => {
        expect(rates.debito).toBeLessThanOrEqual(rates.credito)
      })
    })
  })

  describe('MCC code validation', () => {
    test('Fitness businesses should return MCC 7941', () => {
      const result = lookupRatesByBusinessName('gimnasio')
      expect(result.mcc).toBe('7941')
    })

    test('Restaurants should return MCC 5812', () => {
      const result = lookupRatesByBusinessName('restaurante')
      expect(result.mcc).toBe('5812')
    })

    test('Hotels should return MCC 7011', () => {
      const result = lookupRatesByBusinessName('hotel')
      expect(result.mcc).toBe('7011')
    })

    test('Pharmacies should return MCC 5912', () => {
      const result = lookupRatesByBusinessName('farmacia')
      expect(result.mcc).toBe('5912')
    })

    test('Gas stations should return MCC 5541', () => {
      const result = lookupRatesByBusinessName('gasolinera')
      expect(result.mcc).toBe('5541')
    })
  })

  describe('Performance tests', () => {
    test('should handle 1000 lookups in reasonable time', () => {
      const startTime = Date.now()
      const testNames = ['restaurante', 'gimnasio', 'hotel', 'farmacia', 'bar', 'cafe', 'spa', 'clinica', 'tienda', 'supermercado']

      for (let i = 0; i < 1000; i++) {
        lookupRatesByBusinessName(testNames[i % testNames.length])
      }

      const endTime = Date.now()
      const duration = endTime - startTime

      // Should complete 1000 lookups in less than 1 second
      expect(duration).toBeLessThan(1000)
    })
  })
})
