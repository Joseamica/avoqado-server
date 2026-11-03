/**
 * «Por cobrar» — tipos compartidos (spec 2026-11-02-por-cobrar-superadmin).
 *
 * Dinero SIEMPRE en centavos enteros (MXN), como PlatformCfdi: alimenta directo al CFDI. Nunca flotantes ni pesos.
 * Fechas SIEMPRE de calendario de CDMX, sin hora: ver `schedule.ts`.
 */

/** Un día de calendario de CDMX, sin hora: `'YYYY-MM-DD'`. Nunca un instante. */
export type CalendarDay = string

/** `WITHOUT_IVA`: el monto no trae IVA y se le suma el 16 %. `WITH_IVA`: el monto ya lo trae. */
export type ChargeIvaMode = 'WITHOUT_IVA' | 'WITH_IVA'

/** Un renglón de un cobro: la forma del JSON `concepts` de PlatformCharge y de la foto de cada ocurrencia. */
export interface ChargeConcept {
  description: string
  /** Centavos enteros, mayor a 0. */
  amountCents: number
  ivaMode: ChargeIvaMode
  /** c_ClaveProdServ del SAT. */
  satProductKey: string
  /** c_ClaveUnidad del SAT. */
  satUnitKey: string
}

/** Lo que se deposita, al centavo: `totalCents = subtotalCents + taxCents`. */
export interface ChargeTotals {
  subtotalCents: number
  taxCents: number
  totalCents: number
}
