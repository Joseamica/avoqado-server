import { TerminalType } from '@prisma/client'

import {
  ACTIVATABLE_TERMINAL_TYPES,
  assertDeviceActionSupported,
  type DeviceCapabilitySnapshot,
  resolveEffectiveDeviceCapabilities,
  toDeviceManagementDto,
} from '@/services/device-capabilities.service'

const NOW = new Date('2026-08-30T12:00:00.000Z')
const FRESH_OBSERVATION = new Date('2026-08-30T11:00:00.000Z')
const STALE_OBSERVATION = new Date('2026-08-23T11:59:59.999Z')

const TPV_ANDROID_COMMANDS = [
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

function device(type: TerminalType, overrides: Partial<DeviceCapabilitySnapshot> = {}): DeviceCapabilitySnapshot {
  return {
    type,
    customerDisplayPresent: null,
    customerDisplayInvertible: null,
    displayModeProtocolVersion: null,
    capabilitiesObservedAt: null,
    ...overrides,
  }
}

describe('resolveEffectiveDeviceCapabilities', () => {
  it('returns the full TPV Android capability set derived from its real command executor', () => {
    expect(resolveEffectiveDeviceCapabilities(device(TerminalType.TPV_ANDROID), { now: NOW })).toEqual({
      requiresActivation: true,
      canManagePaymentConfiguration: true,
      canAcceptTerminalPaymentRequests: true,
      customerDisplay: {
        presence: 'UNSUPPORTED',
        invertibility: 'UNSUPPORTED',
        canRequestInversion: false,
        observedAt: null,
        stale: false,
      },
      supportedRemoteCommands: TPV_ANDROID_COMMANDS,
    })
  })

  it('keeps TPV iOS provisioned but does not expose payment requests or remote commands without an executor', () => {
    expect(resolveEffectiveDeviceCapabilities(device(TerminalType.TPV_IOS), { now: NOW })).toEqual({
      requiresActivation: true,
      canManagePaymentConfiguration: true,
      canAcceptTerminalPaymentRequests: false,
      customerDisplay: {
        presence: 'UNSUPPORTED',
        invertibility: 'UNSUPPORTED',
        canRequestInversion: false,
        observedAt: null,
        stale: false,
      },
      supportedRemoteCommands: [],
    })
  })

  it('reports fresh POS Android display facts separately and only accepts inversion protocol v1', () => {
    const fullDisplay = resolveEffectiveDeviceCapabilities(
      device(TerminalType.POS_ANDROID, {
        customerDisplayPresent: true,
        customerDisplayInvertible: true,
        displayModeProtocolVersion: 1,
        capabilitiesObservedAt: FRESH_OBSERVATION,
      }),
      { now: NOW },
    )
    const presentOnly = resolveEffectiveDeviceCapabilities(
      device(TerminalType.POS_ANDROID, {
        customerDisplayPresent: true,
        customerDisplayInvertible: false,
        displayModeProtocolVersion: 1,
        capabilitiesObservedAt: FRESH_OBSERVATION,
      }),
      { now: NOW },
    )

    expect(fullDisplay).toEqual({
      requiresActivation: false,
      canManagePaymentConfiguration: false,
      canAcceptTerminalPaymentRequests: false,
      customerDisplay: {
        presence: 'SUPPORTED',
        invertibility: 'SUPPORTED',
        canRequestInversion: true,
        observedAt: '2026-08-30T11:00:00.000Z',
        stale: false,
      },
      supportedRemoteCommands: [],
    })
    expect(presentOnly.customerDisplay).toEqual({
      presence: 'SUPPORTED',
      invertibility: 'UNSUPPORTED',
      canRequestInversion: false,
      observedAt: '2026-08-30T11:00:00.000Z',
      stale: false,
    })
  })

  it('does not infer POS Android display capabilities when the report is missing or stale', () => {
    const missing = resolveEffectiveDeviceCapabilities(device(TerminalType.POS_ANDROID), { now: NOW })
    const stale = resolveEffectiveDeviceCapabilities(
      device(TerminalType.POS_ANDROID, {
        customerDisplayPresent: true,
        customerDisplayInvertible: true,
        displayModeProtocolVersion: 1,
        capabilitiesObservedAt: STALE_OBSERVATION,
      }),
      { now: NOW },
    )

    expect(missing.customerDisplay).toEqual({
      presence: 'UNKNOWN',
      invertibility: 'UNKNOWN',
      canRequestInversion: false,
      observedAt: null,
      stale: true,
    })
    expect(stale.customerDisplay).toEqual({
      presence: 'UNKNOWN',
      invertibility: 'UNKNOWN',
      canRequestInversion: false,
      observedAt: '2026-08-23T11:59:59.999Z',
      stale: true,
    })
  })

  it('preserves UNKNOWN independently for fresh nullable POS Android display facts', () => {
    const missingPresence = resolveEffectiveDeviceCapabilities(
      device(TerminalType.POS_ANDROID, {
        customerDisplayPresent: null,
        customerDisplayInvertible: true,
        displayModeProtocolVersion: 1,
        capabilitiesObservedAt: FRESH_OBSERVATION,
      }),
      { now: NOW },
    )
    const missingInvertibility = resolveEffectiveDeviceCapabilities(
      device(TerminalType.POS_ANDROID, {
        customerDisplayPresent: true,
        customerDisplayInvertible: null,
        displayModeProtocolVersion: 1,
        capabilitiesObservedAt: FRESH_OBSERVATION,
      }),
      { now: NOW },
    )

    expect(missingPresence.customerDisplay).toEqual({
      presence: 'UNKNOWN',
      invertibility: 'SUPPORTED',
      canRequestInversion: false,
      observedAt: FRESH_OBSERVATION.toISOString(),
      stale: false,
    })
    expect(missingInvertibility.customerDisplay).toEqual({
      presence: 'SUPPORTED',
      invertibility: 'UNKNOWN',
      canRequestInversion: false,
      observedAt: FRESH_OBSERVATION.toISOString(),
      stale: false,
    })
  })

  it.each([TerminalType.POS_IOS, TerminalType.POS_DESKTOP, TerminalType.KDS, TerminalType.PRINTER_RECEIPT, TerminalType.PRINTER_KITCHEN])(
    '%s is explicitly unsupported rather than unknown',
    type => {
      expect(resolveEffectiveDeviceCapabilities(device(type), { now: NOW })).toEqual({
        requiresActivation: false,
        canManagePaymentConfiguration: false,
        canAcceptTerminalPaymentRequests: false,
        customerDisplay: {
          presence: 'UNSUPPORTED',
          invertibility: 'UNSUPPORTED',
          canRequestInversion: false,
          observedAt: null,
          stale: false,
        },
        supportedRemoteCommands: [],
      })
    },
  )

  it.each([
    { customerDisplayPresent: false, customerDisplayInvertible: true, displayModeProtocolVersion: 1 },
    { customerDisplayPresent: true, customerDisplayInvertible: false, displayModeProtocolVersion: 1 },
    { customerDisplayPresent: true, customerDisplayInvertible: true, displayModeProtocolVersion: null },
    { customerDisplayPresent: true, customerDisplayInvertible: true, displayModeProtocolVersion: 2 },
  ])('requires fresh present and invertible hardware plus protocol v1 before requesting inversion: %o', report => {
    const capabilities = resolveEffectiveDeviceCapabilities(
      device(TerminalType.POS_ANDROID, {
        ...report,
        capabilitiesObservedAt: FRESH_OBSERVATION,
      }),
      { now: NOW },
    )

    expect(capabilities.customerDisplay.canRequestInversion).toBe(false)
  })
})

describe('toDeviceManagementDto', () => {
  it('adds the canonical capabilities without mutating the source or manufacturing deviceUid', () => {
    const source = {
      id: 'pos-1',
      name: 'Sunmi mostrador',
      type: TerminalType.POS_ANDROID,
      customerDisplayPresent: true,
      customerDisplayInvertible: true,
      displayModeProtocolVersion: 1,
      capabilitiesObservedAt: FRESH_OBSERVATION,
      customerDisplayInverted: true,
      customerDisplayRequest: { requestId: 'request-1', desiredInverted: false },
      customerDisplayRequestVersion: 4,
    }

    const result = toDeviceManagementDto(source, { now: NOW })

    expect(result).toEqual({
      ...source,
      capabilities: resolveEffectiveDeviceCapabilities(source, { now: NOW }),
    })
    expect(result).not.toBe(source)
    expect(result).not.toHaveProperty('deviceUid')
    expect(source).not.toHaveProperty('capabilities')
  })

  it('preserves an already-authorized deviceUid instead of changing it', () => {
    const source = {
      ...device(TerminalType.TPV_ANDROID),
      id: 'tpv-1',
      deviceUid: 'authorized-device-uid',
    }

    expect(toDeviceManagementDto(source, { now: NOW }).deviceUid).toBe('authorized-device-uid')
  })
})

describe('ACTIVATABLE_TERMINAL_TYPES', () => {
  it('is the explicit canonical set used by database filters', () => {
    expect(ACTIVATABLE_TERMINAL_TYPES).toEqual([TerminalType.TPV_ANDROID, TerminalType.TPV_IOS])
  })
})

describe('assertDeviceActionSupported', () => {
  it('accepts only commands present in the canonical TPV Android allowlist', () => {
    expect(
      assertDeviceActionSupported(device(TerminalType.TPV_ANDROID), {
        kind: 'REMOTE_COMMAND',
        commandType: 'REMOTE_ACTIVATE',
      }),
    ).toMatchObject({ supportedRemoteCommands: expect.arrayContaining(['REMOTE_ACTIVATE']) })

    expect(() =>
      assertDeviceActionSupported(device(TerminalType.TPV_ANDROID), {
        kind: 'REMOTE_COMMAND',
        commandType: 'SCHEDULE',
      }),
    ).toThrow(
      expect.objectContaining({
        statusCode: 422,
        code: 'COMMAND_NOT_SUPPORTED',
      }),
    )
  })

  it('rejects a remote command for a non-TPV device with an operational 422', () => {
    expect(() =>
      assertDeviceActionSupported(device(TerminalType.POS_ANDROID), {
        kind: 'REMOTE_COMMAND',
        commandType: 'RESTART',
      }),
    ).toThrow(
      expect.objectContaining({
        statusCode: 422,
        code: 'COMMAND_NOT_SUPPORTED',
      }),
    )
  })

  it('accepts TPV Android and rejects every other payment/refund target through the same resolver', () => {
    expect(
      assertDeviceActionSupported(device(TerminalType.TPV_ANDROID), {
        kind: 'TERMINAL_PAYMENT_REQUEST',
      }),
    ).toMatchObject({ canAcceptTerminalPaymentRequests: true })

    expect(() =>
      assertDeviceActionSupported(device(TerminalType.POS_ANDROID), {
        kind: 'TERMINAL_PAYMENT_REQUEST',
      }),
    ).toThrow(
      expect.objectContaining({
        statusCode: 422,
        code: 'DEVICE_ACTION_UNSUPPORTED',
      }),
    )
  })
})
