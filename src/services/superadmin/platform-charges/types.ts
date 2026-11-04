/**
 * «Por cobrar» — tipos compartidos (spec 2026-11-02-por-cobrar-superadmin).
 *
 * Dinero SIEMPRE en centavos enteros (MXN), como PlatformCfdi: alimenta directo al CFDI. Nunca flotantes ni pesos.
 * Fechas SIEMPRE de calendario de CDMX, sin hora: ver `schedule.ts`.
 */

import type { PlatformCfdiStatus, Prisma } from '@prisma/client'

/** Un día de calendario de CDMX, sin hora: `'YYYY-MM-DD'`. Nunca un instante. */
export type CalendarDay = string

/**
 * 🔴 Cuándo una factura de una fecha de cobro cuenta como VIVA: ya existe ante el SAT (`STAMPED`), su cancelación sigue en trámite
 * (`CANCEL_REQUESTED`) o el timbrado puede estar en camino (`STAMPING`). Con una factura así la fecha no se edita ni se vuelve a
 * facturar: hacerlo cobraría o timbraría dos veces lo mismo. Un solo lugar para no definir «viva» en cada servicio (editar un cobro,
 * anexar una factura, filtrar la lista): si está mal, se corrige aquí. `DRAFT`, `STAMP_FAILED` y `CANCELLED` no cuentan.
 */
export const LIVE_INVOICE_STATUSES: PlatformCfdiStatus[] = ['STAMPED', 'CANCEL_REQUESTED', 'STAMPING']

/** De la más nueva a la más vieja, con `id` de desempate: la que gana entre varias facturas de una fecha. */
export const NEWEST_INVOICE_FIRST: Prisma.PlatformCfdiOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { id: 'desc' }]

/**
 * 🔴 La factura ANEXADA a una fecha y todavía viva. Viene de «Facturas CFDI» con otra llave, así que `resolverIntento`, que busca por la
 * llave del intento, no la ve: lo que timbra o deshace pregunta aparte por ella.
 */
export const linkedLiveWhere = (occurrenceId: string): Prisma.PlatformCfdiWhereInput => ({
  platformChargeOccurrenceId: occurrenceId,
  chargeLinkedAt: { not: null },
  status: { in: LIVE_INVOICE_STATUSES },
})

/** `WITHOUT_IVA`: el monto no trae IVA y se le suma el 16 %. `WITH_IVA`: el monto ya lo trae. */
export type ChargeIvaMode = 'WITHOUT_IVA' | 'WITH_IVA'

/** Un renglón de un cobro: la forma del JSON `concepts` de PlatformCharge y de la foto de cada ocurrencia. */
export interface ChargeConcept {
  description: string
  /** Centavos enteros, mayor a 0. */
  amountCents: number
  ivaMode: ChargeIvaMode
  /** c_ClaveProdServ del SAT. Vacía en un cobro sin factura (`NONE`): se pide al facturar. */
  satProductKey: string
  /** c_ClaveUnidad del SAT. Vacía en un cobro sin factura (`NONE`): se pide al facturar. */
  satUnitKey: string
}

/** Lo que se deposita, al centavo: `totalCents = subtotalCents + taxCents`. */
export interface ChargeTotals {
  subtotalCents: number
  taxCents: number
  totalCents: number
}
