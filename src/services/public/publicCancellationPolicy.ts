import type { ReservationConfig } from '../dashboard/reservationSettings.service'

/**
 * Lista BLANCA de `reservationSettings.cancellation` para respuestas **anónimas**
 * (`GET /api/v1/public/venues/:slug/info`). Misma idea que `publicBookingPayload.ts`: lo que no
 * está aquí, NO sale. Se publica lo que la clienta necesita para saber si recupera su crédito;
 * los cobros por no llegar y los demás ajustes internos se quedan en el servidor.
 */
export const PUBLIC_CANCELLATION_KEYS = [
  'allowCustomerCancel',
  'minHoursBeforeStart',
  'creditRefundMode',
  'creditFreeRefundHoursBefore',
  'creditLateRefundPercent',
] as const

export type PublicCancellationPolicy = {
  allowCustomerCancel: boolean
  minHoursBeforeStart: number | null
  creditRefundMode: 'NEVER' | 'ALWAYS' | 'TIME_BASED'
  creditFreeRefundHoursBefore: number
  creditLateRefundPercent: number
}

/**
 * Proyección de los ajustes YA resueltos por `getReservationSettings` (que aplica los defaults).
 * Sin `allowCustomerCancel` booleano los datos no están completos: `null`, nunca inventar.
 */
export function toPublicCancellationPolicy(
  c: Partial<ReservationConfig['cancellation']> | null | undefined,
): PublicCancellationPolicy | null {
  if (typeof c?.allowCustomerCancel !== 'boolean') return null
  return {
    allowCustomerCancel: c.allowCustomerCancel,
    minHoursBeforeStart: c.minHoursBeforeStart ?? null,
    creditRefundMode: c.creditRefundMode as PublicCancellationPolicy['creditRefundMode'],
    creditFreeRefundHoursBefore: c.creditFreeRefundHoursBefore as number,
    creditLateRefundPercent: c.creditLateRefundPercent as number,
  }
}
