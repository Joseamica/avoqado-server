import type { HorarioSemanal } from '@/services/delivery-channels/core/deliveryHours.service'

export type AcceptingStatus = 'OPEN' | 'CLOSED' | 'PAUSED' | 'OFFLINE' | 'DISABLED'
export type AcceptingReason = 'NOT_ENABLED' | 'MANUAL_PAUSE' | 'OUTSIDE_HOURS' | 'NO_DEVICE' | 'TOO_BUSY' | 'NO_PAYMENT_MODE' | null

/** Sólo aceptación manual (F1): sin `acceptanceMode`. `acceptsCardOnline` (fase 2): el switch de pagar con tarjeta al pedir. */
export interface OnlineOrderingConfig {
  enabled: boolean
  minOrderAmount: number
  defaultPrepMinutes: number
  acceptsPayAtPickup: boolean
  acceptsCardOnline: boolean
  manualPause: boolean
  pausedUntil: string | null
  hours: HorarioSemanal | null
  /** Tienda híbrida: `true` = «Mi equipo» confirma cada pedido; `false` = «Nadie» (nace aceptado y se paga en caja). */
  requiresAcceptance: boolean
}

export type OnlineOrderingSettingsPatch = Partial<OnlineOrderingConfig>

export interface AcceptingState {
  status: AcceptingStatus
  reason: AcceptingReason
  config: OnlineOrderingConfig
}

/**
 * R52 (parada «reloj viejo»): el reloj que se lee EN EL MOMENTO de escribir una hora bajo el candado o en un CAS, o de decidir algo de
 * días o plazos. Nunca una hora capturada al empezar la pasada o la petición: ésa sólo elige candidatos. En producción es
 * `() => new Date()`; las pruebas lo fijan o lo hacen avanzar.
 */
export type Reloj = () => Date

/** A10: cómo se hace la lectura de candidatos de una sincronización (el job la envuelve en su reintento por conexión). */
export type ReadCandidates = <T>(read: () => Promise<T>) => Promise<T>

/** R12: lo que se puede frenar desde el piso con `online-orders:pause` (D7: gerente para arriba, o con su PIN en el POS). */
export type FloorPauseMinutes = 15 | 30 | 60
