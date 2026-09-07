/**
 * Decisiones puras del backfill de `TransactionCost` por merchant.
 *
 * 🔴 Aquí NO se calcula dinero. La aritmética (tasa efectiva con IVA, comisión,
 * neto, margen) vive en `recomputeEconomics`
 * (`src/services/superadmin/rateCorrection/rateRecompute.ts`), que ya está
 * probada y atada por su prueba de paridad al camino vivo. Copiarla aquí sería
 * la cuarta versión de la misma regla, y la memoria del workspace
 * (`una-regla-copiada-en-n-sitios`) dice cómo termina eso.
 *
 * Lo que sí vive aquí son las tres decisiones que el backfill agrega:
 * qué ranura le toca al pago, si se puede recalcular hoy, y si lo escrito
 * cuadra con lo prometido.
 */

/** Las tres ranuras de cuenta que un negocio puede tener configuradas. */
export type Ranura = 'PRIMARY' | 'SECONDARY' | 'TERTIARY'

/** Sólo los ids de `VenuePaymentConfig`; el resto de la fila no decide nada aquí. */
export interface RanurasDelNegocio {
  primaryAccountId?: string | null
  secondaryAccountId?: string | null
  tertiaryAccountId?: string | null
}

/**
 * Espejo EXACTO de la resolución de ranura de `createTransactionCost`
 * (`transactionCost.service.ts`, Step 2): secundaria → terciaria → primaria, y
 * cualquier otra cosa cae a PRIMARY.
 *
 * 🔴 La comparación exige que el pago traiga cuenta ANTES de comparar: sin esa
 * guarda, un pago sin cuenta (`null`) contra una ranura vacía (`null`) da
 * `null === null` y el pago se resolvería como SECONDARY — cobrándole al
 * negocio con una tarifa que no le corresponde.
 */
export function resolverRanura(ranuras: RanurasDelNegocio, merchantAccountIdDelPago: string | null | undefined): Ranura {
  if (!merchantAccountIdDelPago) return 'PRIMARY'
  if (ranuras.secondaryAccountId === merchantAccountIdDelPago) return 'SECONDARY'
  if (ranuras.tertiaryAccountId === merchantAccountIdDelPago) return 'TERTIARY'
  return 'PRIMARY'
}

/** Por qué un pago se recalcula o no. */
export type Clasificacion = 'LISTO' | 'EN_CERO' | 'SIN_CONFIG_DE_PAGOS' | 'SIN_COSTO_VIGENTE' | 'SIN_TARIFA_VIGENTE'

export interface EntradaClasificacion {
  /** base + propina: es sobre el total que cruza la terminal que cobra el procesador. */
  bruto: number
  /** ¿El negocio del pago tiene `VenuePaymentConfig`, propia o de su organización? */
  hayConfigDePagos: boolean
  /** `ProviderCostStructure` vigente a la FECHA DEL PAGO, o null si no hay. */
  costoVigente: unknown | null
  /** `VenuePricingStructure` vigente a la FECHA DEL PAGO (con su respaldo a PRIMARY), o null. */
  tarifaVigente: unknown | null
}

/**
 * Contesta «¿este pago se puede recalcular hoy?» ANTES de llamar al servicio.
 *
 * Sin esta guarda, un merchant al que le falta la estructura de costo produce
 * una tanda de `BadRequestError` idénticos contra producción y la simulación no
 * podría decir de antemano qué va a pasar — que es justo para lo que se corre.
 */
export function clasificarPago(entrada: EntradaClasificacion): Clasificacion {
  if (!(entrada.bruto > 0)) return 'EN_CERO'
  // El orden espeja el del servicio: la configuración se resuelve en su Step 2, las
  // estructuras en el 3 y el 4. 🔴 Y se CLASIFICA en vez de abortar la corrida: un
  // merchant puede servir a varios negocios, y uno mal configurado no puede dejar sin
  // reparar a los demás — lo destapó correrlo contra datos reales.
  if (!entrada.hayConfigDePagos) return 'SIN_CONFIG_DE_PAGOS'
  if (!entrada.costoVigente) return 'SIN_COSTO_VIGENTE'
  if (!entrada.tarifaVigente) return 'SIN_TARIFA_VIGENTE'
  return 'LISTO'
}

/**
 * ¿Lo ESCRITO cuadra con lo que la simulación prometió, a la precisión de su
 * columna? `Payment.feeAmount` es `Decimal(10,2)` y
 * `TransactionCost.venueChargeAmount` es `Decimal(10,4)`: el valor guardado es
 * el previsto redondeado, así que exigir igualdad exacta daría un descuadre
 * falso en cada corrida.
 *
 * Un `NaN` (Decimal ilegible, columna nula) tampoco cuadra, y hay prueba de
 * eso — pero conviene saber POR QUÉ: no lo protege una guarda, lo garantiza
 * IEEE-754, donde toda comparación con NaN es falsa. Se escribió una guarda
 * explícita, se saboteó quitándola y la prueba siguió en verde: era código
 * muerto, así que se retiró en vez de dejar una línea que aparenta proteger
 * algo. La prueba se queda porque fija el contrato, no porque cubra esa línea.
 */
export function cuadraRedondeado(escrito: number, esperado: number, decimales: number): boolean {
  const margen = 0.5 * Math.pow(10, -decimales) + 1e-9
  return Math.abs(escrito - esperado) <= margen
}
