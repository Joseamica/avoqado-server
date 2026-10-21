import type { HorarioSemanal } from '@/services/delivery-channels/core/deliveryHours.service'

export type AcceptingStatus = 'OPEN' | 'CLOSED' | 'PAUSED' | 'OFFLINE' | 'DISABLED'
export type AcceptingReason = 'NOT_ENABLED' | 'MANUAL_PAUSE' | 'OUTSIDE_HOURS' | 'NO_DEVICE' | 'TOO_BUSY' | null

/** Sólo aceptación manual (F1) y sólo pagar al recoger en la v1 (R20): sin `acceptanceMode` ni `acceptsCardOnline`. */
export interface OnlineOrderingConfig {
  enabled: boolean
  minOrderAmount: number
  defaultPrepMinutes: number
  acceptsPayAtPickup: boolean
  manualPause: boolean
  pausedUntil: string | null
  hours: HorarioSemanal | null
}

export type OnlineOrderingSettingsPatch = Partial<OnlineOrderingConfig>

export interface AcceptingState {
  status: AcceptingStatus
  reason: AcceptingReason
  config: OnlineOrderingConfig
}

/** A10: cómo se hace la lectura de candidatos de una sincronización (el job la envuelve en su reintento por conexión). */
export type ReadCandidates = <T>(read: () => Promise<T>) => Promise<T>

/** R12: lo que se puede frenar desde el piso con `online-orders:pause` (D7: gerente para arriba, o con su PIN en el POS). */
export type FloorPauseMinutes = 15 | 30 | 60
