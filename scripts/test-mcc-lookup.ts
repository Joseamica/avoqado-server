/**
 * Test script for Blumon MCC Lookup Service
 *
 * Run: npx ts-node -r tsconfig-paths/register scripts/test-mcc-lookup.ts
 */

import {
  lookupRatesByBusinessName,
  getRatesByFamilia,
  listAllFamilias,
  calculateProcessingCost,
} from '../src/services/pricing/blumon-mcc-lookup.service'

console.log('='.repeat(70))
console.log('🔍 BLUMON MCC LOOKUP SERVICE - TEST')
console.log('='.repeat(70))

// Test cases - diferentes tipos de negocios
const testCases = [
  // Gimnasios y fitness (el ejemplo del usuario)
  'Gimnasio',
  'CrossFit Box',
  'Estudio de Yoga',
  'Pilates Studio',
  'Entrenamiento Personal',

  // Restaurantes
  'Restaurante',
  'Taquería El Güero',
  'Cafetería',
  'Mariscos La Costa',
  'Sushi Bar',
  'Bar de mezcal',
  'Comida rápida',
  'Food Truck',

  // Salud
  'Consultorio Médico',
  'Dentista',
  'Veterinaria',
  'Hospital General',
  'Farmacia',

  // Belleza
  'Salón de Belleza',
  'Barbería',
  'Spa',
  'Estética',

  // Educación
  'Guardería',
  'Kinder',
  'Universidad',
  'Academia de Idiomas',
  'Escuela de Baile',

  // Retail
  'Tienda de Ropa',
  'Zapatería',
  'Joyería',
  'Ferretería',
  'Miscelánea',
  'Supermercado',
  'Oxxo',

  // Servicios
  'Estacionamiento',
  'Car Wash',
  'Taller Mecánico',
  'Agencia de Viajes',
  'Abogado',

  // Entretenimiento
  'Cine',
  'Boliche',
  'Parque de Diversiones',
  'Museo',

  // Casos edge
  'Negocio Raro No Clasificado',
  'XYZ Corp',
]

console.log('\n📊 RESULTADOS DE BÚSQUEDA:\n')

for (const businessName of testCases) {
  const result = lookupRatesByBusinessName(businessName)

  const status = result.found ? '✅' : '⚠️'
  const confidence = result.confidence.toString().padStart(3)

  console.log(`${status} "${businessName}"`)
  console.log(`   Familia: ${result.familia || 'N/A'}`)
  console.log(`   MCC: ${result.mcc || 'N/A'}`)
  console.log(`   Match: ${result.matchType} (${confidence}% confidence)`)
  if (result.matchedTerm) {
    console.log(`   Matched: "${result.matchedTerm}"`)
  }
  if (result.rates) {
    console.log(
      `   Tasas: Crédito ${result.rates.credito}% | Débito ${result.rates.debito}% | Int'l ${result.rates.internacional}% | Amex ${result.rates.amex}%`,
    )
  }
  if (result.nota) {
    console.log(`   Nota: ${result.nota}`)
  }
  console.log()
}

// Ejemplo de cálculo de costos
console.log('='.repeat(70))
console.log('💰 EJEMPLO DE CÁLCULO DE COSTOS')
console.log('='.repeat(70))

const gimnasio = lookupRatesByBusinessName('Gimnasio')
if (gimnasio.rates) {
  const transactionAmount = 1000 // $1,000 MXN

  console.log(`\nNegocio: Gimnasio (${gimnasio.familia})`)
  console.log(`Monto de transacción: $${transactionAmount} MXN\n`)

  const cardTypes: Array<'credito' | 'debito' | 'internacional' | 'amex'> = ['credito', 'debito', 'internacional', 'amex']

  for (const cardType of cardTypes) {
    const { rate, cost } = calculateProcessingCost(transactionAmount, gimnasio.rates, cardType)
    console.log(`  ${cardType.padEnd(13)}: ${rate.toFixed(2)}% = $${cost.toFixed(2)} MXN`)
  }
}

// Listar todas las familias
console.log('\n' + '='.repeat(70))
console.log('📋 TODAS LAS FAMILIAS DISPONIBLES')
console.log('='.repeat(70))

const allFamilias = listAllFamilias()
console.log(`\nTotal: ${allFamilias.length} familias\n`)

// Sort by credit rate
allFamilias.sort((a, b) => a.rates.credito - b.rates.credito)

for (const { familia, rates } of allFamilias) {
  console.log(`  ${familia.padEnd(35)} Crédito: ${rates.credito.toFixed(2)}% | Débito: ${rates.debito.toFixed(2)}%`)
}

console.log('\n✅ Test completado')
