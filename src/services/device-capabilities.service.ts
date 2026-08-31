import { Prisma, TerminalType, TpvCommandType } from '@prisma/client'
import { ValidationError } from '@/errors/AppError'

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
    }
  }

  if (terminal.type === TerminalType.TPV_IOS) {
    return {
      requiresActivation: true,
      canManagePaymentConfiguration: true,
      canAcceptTerminalPaymentRequests: false,
      customerDisplay: { ...UNSUPPORTED_DISPLAY },
      supportedRemoteCommands: [],
    }
  }

  if (terminal.type === TerminalType.POS_ANDROID) {
    return {
      requiresActivation: false,
      canManagePaymentConfiguration: false,
      canAcceptTerminalPaymentRequests: false,
      customerDisplay: resolvePosAndroidDisplay(terminal, context.now ?? new Date()),
      supportedRemoteCommands: [],
    }
  }

  return {
    requiresActivation: false,
    canManagePaymentConfiguration: false,
    canAcceptTerminalPaymentRequests: false,
    customerDisplay: { ...UNSUPPORTED_DISPLAY },
    supportedRemoteCommands: [],
  }
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
