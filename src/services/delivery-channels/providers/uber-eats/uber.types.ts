/**
 * TEMPORAL — el contrato se promovió a `core/types.ts` (plan 2026-08-20, Tarea 2).
 * Estos alias existen sólo para que los 7 tests de integración de la ingesta de Uber
 * sigan compilando durante la migración. Se BORRA en la Tarea 4.
 */
export type {
  NormalizedDeliveryModifier as NormalizedUberModifier,
  NormalizedDeliveryItem as NormalizedUberItem,
  NormalizedDeliveryPayment as NormalizedUberPayment,
  NormalizedDeliveryOrder as NormalizedUberOrder,
} from '../../core/types'
