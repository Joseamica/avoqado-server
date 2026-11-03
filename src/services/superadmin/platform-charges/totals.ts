/**
 * «Por cobrar» — totales al centavo, como los calcula el PAC (spec 2026-11-02-por-cobrar-superadmin §3.2).
 *
 * Se suman las partes SIN redondear y se redondea al final, porque el PAC guarda cada concepto con 6 decimales y redondea los
 * totales: redondear renglón por renglón puede diferir en un centavo con dos conceptos o más. Con A = suma de montos sin IVA
 * y B = suma de montos con IVA, ambos en centavos:
 *
 *   subtotal = redondear(A + B·100/116)      = redondear((A·2900 + B·2500) / 2900)
 *   iva      = redondear(A·16/100 + B·16/116) = redondear((A·464  + B·400)  / 2900)
 *   total    = subtotal + iva
 *
 * Todo con enteros (denominador común 2900), nunca con flotantes. Tiene su espejo en SUPERADMIN (`charge-totals.ts`) para la
 * vista previa, con la misma tabla de casos en las dos pruebas. La fórmula es una suposición sobre el PAC que se comprueba en
 * el modo de prueba de Facturapi: si difiere, manda lo que el PAC diga y se corrige esta función.
 */
import type { PlatformCfdiLineInput } from '@/services/superadmin/platform-billing/types'
import type { ChargeConcept, ChargeTotals } from './types'

/** IVA fijo del 16 %: renta de equipo y licencias siempre lo causan, así que no hay «exento» ni otra tasa. */
const IVA_RATE = 0.16

/**
 * Tope de cada suma (A y B), en centavos: mil millones de pesos. Con él, 2·(A·2900 + B·2500) + 2900 queda ocho veces por debajo
 * de Number.MAX_SAFE_INTEGER y los enteros de JavaScript siguen exactos; sin tope un monto absurdo daría un total que miente.
 */
const MAX_SUM_CENTS = 100_000_000_000

/**
 * redondear(n/d) = floor((2n + d) / (2d)), el centavo más cercano. Se saca el piso restando el resto en vez de dividir
 * flotantes: así es exacto aunque el cociente sea grande. (Una mitad exacta nunca ocurre: 29 y 725 son impares.)
 */
function redondear(n: number, d: number): number {
  const x = 2 * n + d
  const y = 2 * d
  return (x - (x % y)) / y
}

export function computeChargeTotals(concepts: ChargeConcept[]): ChargeTotals {
  if (concepts.length === 0) throw new Error('Un cobro necesita al menos un concepto')

  let withoutIva = 0 // A
  let withIva = 0 // B
  for (const concept of concepts) {
    // Los conceptos vienen de un JSON de la base: se comprueba lo que los tipos no pueden garantizar.
    if (!Number.isSafeInteger(concept.amountCents) || concept.amountCents <= 0) {
      throw new Error(`El monto de un concepto debe ser un entero positivo de centavos (llegó ${String(concept.amountCents)})`)
    }
    if (concept.ivaMode === 'WITHOUT_IVA') withoutIva += concept.amountCents
    else if (concept.ivaMode === 'WITH_IVA') withIva += concept.amountCents
    else throw new Error(`El modo de IVA "${String(concept.ivaMode)}" no existe`)
  }
  if (withoutIva > MAX_SUM_CENTS || withIva > MAX_SUM_CENTS) throw new Error('El cobro suma un monto demasiado grande')

  const subtotalCents = redondear(withoutIva * 2900 + withIva * 2500, 2900)
  const taxCents = redondear(withoutIva * 464 + withIva * 400, 2900)
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents }
}

/** El renglón del CFDI de un concepto: una unidad, al 16 %. Con IVA, el precio ya lo trae y el PAC saca la base (`taxIncluded`). */
export function conceptToCfdiLine(concept: ChargeConcept): PlatformCfdiLineInput {
  return {
    description: concept.description,
    satProductKey: concept.satProductKey,
    satUnitKey: concept.satUnitKey,
    quantity: 1,
    unitPriceCents: concept.amountCents,
    taxRate: IVA_RATE,
    taxIncluded: concept.ivaMode === 'WITH_IVA',
  }
}
