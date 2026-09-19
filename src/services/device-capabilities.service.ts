import { Prisma, TerminalType, TpvCommandType } from '@prisma/client'
import { ValidationError } from '@/errors/AppError'
// Sólo el TIPO: los tipos se borran al compilar, así que esto NO crea un ciclo en runtime
// con tpv.dashboard.service (que sí importa ACTIVATABLE_TERMINAL_TYPES de aquí).
import type { TpvSettings } from './dashboard/tpv.dashboard.service'

export type CapabilityState = 'SUPPORTED' | 'UNSUPPORTED' | 'UNKNOWN'

export interface DeviceCapabilitySnapshot {
  type: TerminalType
  customerDisplayPresent: boolean | null
  customerDisplayInvertible: boolean | null
  displayModeProtocolVersion: number | null
  capabilitiesObservedAt: Date | null
}

export interface EffectiveDeviceCapabilities {
  requiresActivation: boolean
  canManagePaymentConfiguration: boolean
  canAcceptTerminalPaymentRequests: boolean
  customerDisplay: {
    presence: CapabilityState
    invertibility: CapabilityState
    canRequestInversion: boolean
    observedAt: string | null
    stale: boolean
  }
  supportedRemoteCommands: TpvCommandType[]
  /** Ajustes de TPV que ESTE tipo de aparato admite. Ver `assertSettingsConfigurable`. */
  configurableSettings: TpvSettingsKey[]
}

export type DeviceAction = { kind: 'REMOTE_COMMAND'; commandType: TpvCommandType } | { kind: 'TERMINAL_PAYMENT_REQUEST' }

export type DeviceManagementDto<T extends DeviceCapabilitySnapshot> = T & {
  capabilities: EffectiveDeviceCapabilities
}

export const ACTIVATABLE_TERMINAL_TYPES = [TerminalType.TPV_ANDROID, TerminalType.TPV_IOS] as const

export const DEVICE_CAPABILITY_SELECT = {
  type: true,
  customerDisplayPresent: true,
  customerDisplayInvertible: true,
  displayModeProtocolVersion: true,
  capabilitiesObservedAt: true,
  customerDisplayInverted: true,
  customerDisplayRequest: true,
  customerDisplayRequestVersion: true,
} satisfies Prisma.TerminalSelect

export const CAPABILITY_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000

const TPV_ANDROID_COMMANDS: readonly TpvCommandType[] = [
  'LOCK',
  'UNLOCK',
  'MAINTENANCE_MODE',
  'EXIT_MAINTENANCE',
  'REACTIVATE',
  'REMOTE_ACTIVATE',
  'RESTART',
  'SHUTDOWN',
  'CLEAR_CACHE',
  'FORCE_UPDATE',
  'REQUEST_UPDATE',
  'INSTALL_VERSION',
  'SYNC_DATA',
  'FACTORY_RESET',
  'EXPORT_LOGS',
  'UPDATE_CONFIG',
  'REFRESH_MENU',
  'UPDATE_MERCHANT',
  'FETCH_ANGELPAY_MERCHANTS',
]

export type TpvSettingsKey = keyof TpvSettings

/**
 * 🔴 El catálogo COMPLETO de ajustes de TPV, con garantía de exhaustividad.
 *
 * `satisfies Record<TpvSettingsKey, true>` es lo que hace que esto no se pudra: el día que alguien
 * agregue un ajuste a `TpvSettings` y no lo liste aquí, **TypeScript falla** y le obliga a decidir
 * qué aparatos lo admiten. Sin eso, un ajuste nuevo nacería invisible para esta distinción — que es
 * justo el descuido que esta función existe para impedir.
 */
const ALL_TPV_SETTINGS = {
  showReviewScreen: true,
  showTipScreen: true,
  showReceiptScreen: true,
  defaultTipPercentage: true,
  tipSuggestions: true,
  requirePinLogin: true,
  requireAvoqadoServerForCardPayment: true,
  showVerificationScreen: true,
  requireVerificationPhoto: true,
  requireVerificationBarcode: true,
  requireClockInPhoto: true,
  requireClockOutPhoto: true,
  requireClockInToLogin: true,
  kioskModeEnabled: true,
  kioskDefaultMerchantId: true,
  showQuickPayment: true,
  showOrderManagement: true,
  showReports: true,
  showPayments: true,
  showSupport: true,
  showGoals: true,
  showMessages: true,
  showTrainings: true,
  showCheckout: true,
  requireDepositPhoto: true,
  requireFacadePhoto: true,
  enableCashPayments: true,
  enableCardPayments: true,
  enableBarcodeScanner: true,
  enableSerializedInventory: true,
  attendanceTracking: true,
  cellularFailoverMode: true,
  cellularFailoverBadReadingsThreshold: true,
  cellularFailoverCooldownSeconds: true,
  cellularFailoverMinCellHoldSeconds: true,
  paymentLedgerMode: true,
} satisfies Record<TpvSettingsKey, true>

const TPV_CONFIGURABLE_SETTINGS = Object.keys(ALL_TPV_SETTINGS) as TpvSettingsKey[]

/**
 * Lo que una app POS (tablet Android, iPad, teléfono) puede configurar sobre SU PROPIA ficha.
 *
 * 🔴 Es corta A PROPÓSITO, y no es una opinión: son los ajustes que `avoqado-android` y
 * `avoqado-ios` de verdad OBEDECEN (medido 2026-09-18 — de los 35, los demás están declarados en
 * sus modelos y nadie los lee: son de la terminal de cobro). Mostrarle a una tablet el catálogo de
 * la PAX sería darle 33 interruptores que no hacen nada.
 *
 * Los dos que quedan son lo mismo: **qué ve el cliente entre que se cobra y se acaba** — que es
 * también el corte que hace Square, cuyo POS expone el comportamiento del momento del cobro y deja
 * el resto en el dashboard.
 */
const POS_CONFIGURABLE_SETTINGS: TpvSettingsKey[] = ['showReviewScreen', 'showTipScreen', 'tipSuggestions']

/**
 * Los ajustes que este TIPO de aparato admite. Depende sólo del tipo, así que un consumidor que ya
 * tiene el `type` a mano no necesita cargar el snapshot entero de capacidades.
 */
export function resolveConfigurableSettings(type: TerminalType): TpvSettingsKey[] {
  if (type === TerminalType.TPV_ANDROID || type === TerminalType.TPV_IOS) return [...TPV_CONFIGURABLE_SETTINGS]
  if (type === TerminalType.POS_ANDROID || type === TerminalType.POS_IOS) return [...POS_CONFIGURABLE_SETTINGS]
  return []
}

const UNSUPPORTED_DISPLAY: EffectiveDeviceCapabilities['customerDisplay'] = {
  presence: 'UNSUPPORTED',
  invertibility: 'UNSUPPORTED',
  canRequestInversion: false,
  observedAt: null,
  stale: false,
}

function resolvePosAndroidDisplay(terminal: DeviceCapabilitySnapshot, now: Date): EffectiveDeviceCapabilities['customerDisplay'] {
  const observedAt = terminal.capabilitiesObservedAt

  if (!observedAt || now.getTime() - observedAt.getTime() > CAPABILITY_FRESHNESS_MS) {
    return {
      presence: 'UNKNOWN',
      invertibility: 'UNKNOWN',
      canRequestInversion: false,
      observedAt: observedAt?.toISOString() ?? null,
      stale: true,
    }
  }

  const toCapabilityState = (value: boolean | null): CapabilityState => (value === null ? 'UNKNOWN' : value ? 'SUPPORTED' : 'UNSUPPORTED')
  const presence = toCapabilityState(terminal.customerDisplayPresent)
  const invertibility = toCapabilityState(terminal.customerDisplayInvertible)

  return {
    presence,
    invertibility,
    canRequestInversion:
      terminal.customerDisplayPresent === true && terminal.customerDisplayInvertible === true && terminal.displayModeProtocolVersion === 1,
    observedAt: observedAt.toISOString(),
    stale: false,
  }
}

export function resolveEffectiveDeviceCapabilities(
  terminal: DeviceCapabilitySnapshot,
  context: { now?: Date } = {},
): EffectiveDeviceCapabilities {
  if (terminal.type === TerminalType.TPV_ANDROID) {
    return {
      requiresActivation: true,
      canManagePaymentConfiguration: true,
      canAcceptTerminalPaymentRequests: true,
      customerDisplay: { ...UNSUPPORTED_DISPLAY },
      supportedRemoteCommands: [...TPV_ANDROID_COMMANDS],
      configurableSettings: resolveConfigurableSettings(terminal.type),
    }
  }

  if (terminal.type === TerminalType.TPV_IOS) {
    return {
      requiresActivation: true,
      canManagePaymentConfiguration: true,
      canAcceptTerminalPaymentRequests: false,
      customerDisplay: { ...UNSUPPORTED_DISPLAY },
      supportedRemoteCommands: [],
      configurableSettings: resolveConfigurableSettings(terminal.type),
    }
  }

  if (terminal.type === TerminalType.POS_ANDROID || terminal.type === TerminalType.POS_IOS) {
    return {
      requiresActivation: false,
      canManagePaymentConfiguration: false,
      canAcceptTerminalPaymentRequests: false,
      customerDisplay:
        terminal.type === TerminalType.POS_ANDROID
          ? resolvePosAndroidDisplay(terminal, context.now ?? new Date())
          : { ...UNSUPPORTED_DISPLAY },
      supportedRemoteCommands: [],
      configurableSettings: resolveConfigurableSettings(terminal.type),
    }
  }

  return {
    requiresActivation: false,
    canManagePaymentConfiguration: false,
    canAcceptTerminalPaymentRequests: false,
    customerDisplay: { ...UNSUPPORTED_DISPLAY },
    supportedRemoteCommands: [],
    configurableSettings: resolveConfigurableSettings(terminal.type),
  }
}

/**
 * Guard técnico hermano de `assertDeviceActionSupported`: ningún rol —ni el dueño— puede escribir
 * en un aparato un ajuste que ese aparato no obedece. El permiso del actor se sigue revisando en la
 * ruta; esto es la otra mitad, la del hardware.
 */
export function assertSettingsConfigurable(
  terminal: DeviceCapabilitySnapshot,
  keys: readonly string[],
  context: { now?: Date } = {},
): TpvSettingsKey[] {
  if (keys.length === 0) {
    throw new ValidationError('No se envió ningún ajuste que cambiar.', 'NO_SETTINGS_PROVIDED')
  }

  const allowed = resolveEffectiveDeviceCapabilities(terminal, context).configurableSettings
  const rejected = keys.filter(key => !(allowed as readonly string[]).includes(key))

  if (rejected.length > 0) {
    throw new ValidationError(
      `Este dispositivo no permite configurar: ${rejected.join(', ')}. Cámbialo desde el dashboard de Avoqado.`,
      'SETTING_NOT_SUPPORTED_BY_DEVICE',
    )
  }

  return keys as TpvSettingsKey[]
}

/**
 * Canonical technical action guard. Actor permissions intentionally stay at the
 * caller boundary: no role can make unsupported hardware execute an action.
 */
export function assertDeviceActionSupported(
  terminal: DeviceCapabilitySnapshot,
  action: DeviceAction,
  context: { now?: Date } = {},
): EffectiveDeviceCapabilities {
  const capabilities = resolveEffectiveDeviceCapabilities(terminal, context)

  if (action.kind === 'REMOTE_COMMAND') {
    if (!capabilities.supportedRemoteCommands.includes(action.commandType)) {
      throw new ValidationError(
        `Este dispositivo no admite el comando remoto ${action.commandType}. Selecciona una TPV Android compatible.`,
        'COMMAND_NOT_SUPPORTED',
      )
    }
    return capabilities
  }

  if (!capabilities.canAcceptTerminalPaymentRequests) {
    throw new ValidationError(
      'Este dispositivo no puede recibir solicitudes de pago o devolución. Selecciona una TPV Android compatible.',
      'DEVICE_ACTION_UNSUPPORTED',
    )
  }

  return capabilities
}

export function toDeviceManagementDto<T extends DeviceCapabilitySnapshot>(
  terminal: T,
  context: { now?: Date } = {},
): DeviceManagementDto<T> {
  const capabilities = resolveEffectiveDeviceCapabilities(terminal, context)

  return {
    ...terminal,
    capabilities,
  }
}
