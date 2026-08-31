import { TerminalStatus, TerminalType, TpvCommandType } from '@prisma/client'

import { TpvCommandQueueService } from '@/services/tpv/command-queue.service'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/communication/sockets', () => ({
  broadcastTpvCommandStatusChanged: jest.fn(),
  broadcastTpvCommandQueued: jest.fn(),
  broadcastTpvStatusUpdate: jest.fn(),
}))

const SUPPORTED_TPV_ANDROID_COMMANDS: TpvCommandType[] = [
  TpvCommandType.LOCK,
  TpvCommandType.UNLOCK,
  TpvCommandType.MAINTENANCE_MODE,
  TpvCommandType.EXIT_MAINTENANCE,
  TpvCommandType.REACTIVATE,
  TpvCommandType.REMOTE_ACTIVATE,
  TpvCommandType.RESTART,
  TpvCommandType.SHUTDOWN,
  TpvCommandType.CLEAR_CACHE,
  TpvCommandType.FORCE_UPDATE,
  TpvCommandType.REQUEST_UPDATE,
  TpvCommandType.INSTALL_VERSION,
  TpvCommandType.SYNC_DATA,
  TpvCommandType.FACTORY_RESET,
  TpvCommandType.EXPORT_LOGS,
  TpvCommandType.UPDATE_CONFIG,
  TpvCommandType.REFRESH_MENU,
  TpvCommandType.UPDATE_MERCHANT,
  TpvCommandType.FETCH_ANGELPAY_MERCHANTS,
]

const AUTOMATION_COMMANDS: TpvCommandType[] = [TpvCommandType.SCHEDULE, TpvCommandType.GEOFENCE_TRIGGER, TpvCommandType.TIME_RULE]

const UNSUPPORTED_DEVICE_TYPES: TerminalType[] = [
  TerminalType.TPV_IOS,
  TerminalType.POS_ANDROID,
  TerminalType.POS_IOS,
  TerminalType.POS_DESKTOP,
  TerminalType.KDS,
  TerminalType.PRINTER_RECEIPT,
  TerminalType.PRINTER_KITCHEN,
]

function terminal(type: TerminalType, commandType: TpvCommandType) {
  return {
    id: 'terminal-1',
    name: 'Terminal de prueba',
    serialNumber: 'AVQD-1234',
    type,
    status: commandType === TpvCommandType.EXIT_MAINTENANCE ? TerminalStatus.MAINTENANCE : TerminalStatus.ACTIVE,
    lastHeartbeat: null,
    isLocked: commandType === TpvCommandType.UNLOCK,
    venueId: 'venue-1',
    venue: { name: 'Sucursal Centro' },
    customerDisplayPresent: null,
    customerDisplayInvertible: null,
    displayModeProtocolVersion: null,
    capabilitiesObservedAt: null,
  }
}

function input(commandType: TpvCommandType) {
  return {
    terminalId: 'terminal-1',
    venueId: 'venue-1',
    commandType,
    requestedBy: 'staff-1',
  }
}

describe('TpvCommandQueueService canonical device capability guard', () => {
  let service: TpvCommandQueueService

  beforeEach(() => {
    service = new TpvCommandQueueService()
    jest.spyOn(service as any, 'createHistoryEntry').mockResolvedValue(undefined)
    jest.spyOn(service as any, 'broadcastQueuedNotification').mockResolvedValue(undefined)
  })

  it.each(UNSUPPORTED_DEVICE_TYPES)('rejects every generic command for %s before creating a queue row', async type => {
    prismaMock.terminal.findUnique.mockResolvedValue(terminal(type, TpvCommandType.RESTART))

    await expect(service.queueCommand(input(TpvCommandType.RESTART))).rejects.toMatchObject({
      statusCode: 422,
      code: 'COMMAND_NOT_SUPPORTED',
    })

    expect(prismaMock.tpvCommandQueue.create).not.toHaveBeenCalled()
  })

  it.each(AUTOMATION_COMMANDS)('rejects non-executable TPV Android automation command %s before queue creation', async commandType => {
    prismaMock.terminal.findUnique.mockResolvedValue(terminal(TerminalType.TPV_ANDROID, commandType))

    await expect(service.queueCommand(input(commandType))).rejects.toMatchObject({
      statusCode: 422,
      code: 'COMMAND_NOT_SUPPORTED',
    })

    expect(prismaMock.tpvCommandQueue.create).not.toHaveBeenCalled()
  })

  it('preserves the existing state rejection after technical capability succeeds', async () => {
    prismaMock.terminal.findUnique.mockResolvedValue({
      ...terminal(TerminalType.TPV_ANDROID, TpvCommandType.LOCK),
      isLocked: true,
    })

    await expect(service.queueCommand(input(TpvCommandType.LOCK))).rejects.toMatchObject({
      statusCode: 400,
      message: 'Terminal is already locked',
    })

    expect(prismaMock.tpvCommandQueue.create).not.toHaveBeenCalled()
  })

  it('preserves maintenance-state validation after technical capability succeeds', async () => {
    prismaMock.terminal.findUnique.mockResolvedValue({
      ...terminal(TerminalType.TPV_ANDROID, TpvCommandType.EXIT_MAINTENANCE),
      status: TerminalStatus.ACTIVE,
    })

    await expect(service.queueCommand(input(TpvCommandType.EXIT_MAINTENANCE))).rejects.toMatchObject({
      statusCode: 400,
      message: 'Terminal is not in maintenance mode',
    })

    expect(prismaMock.tpvCommandQueue.create).not.toHaveBeenCalled()
  })

  it.each(SUPPORTED_TPV_ANDROID_COMMANDS)(
    'preserves the existing single offline queue create for supported TPV Android command %s',
    async commandType => {
      prismaMock.terminal.findUnique.mockResolvedValue(terminal(TerminalType.TPV_ANDROID, commandType))
      prismaMock.tpvCommandQueue.create.mockResolvedValue({
        id: `command-${commandType}`,
        correlationId: `correlation-${commandType}`,
        terminalId: 'terminal-1',
        venueId: 'venue-1',
        commandType,
        expiresAt: new Date('2026-08-31T12:00:00.000Z'),
      })

      await expect(service.queueCommand(input(commandType))).resolves.toMatchObject({
        commandId: `command-${commandType}`,
        status: 'PENDING',
        queued: true,
        terminalOnline: false,
      })

      expect(prismaMock.tpvCommandQueue.create).toHaveBeenCalledTimes(1)
      expect(prismaMock.tpvCommandQueue.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ commandType, terminalId: 'terminal-1', venueId: 'venue-1' }) }),
      )
    },
  )

  it('keeps the allowlist exact instead of silently accepting a new enum member', () => {
    expect([...SUPPORTED_TPV_ANDROID_COMMANDS, ...AUTOMATION_COMMANDS].sort()).toEqual(Object.values(TpvCommandType).sort())
  })
})
