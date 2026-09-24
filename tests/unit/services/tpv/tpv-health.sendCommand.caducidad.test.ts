/**
 * `sendCommand` le pasa al socket la caducidad REAL del comando en la cola.
 *
 * 24-sep-2026, Nexgo `AVQD-N860W173570`: el socket le inventaba 5 min de vida a un
 * FACTORY_RESET que en la cola vivía 30. Con el reloj de la terminal 9 min adelantado,
 * seis «Borrar almacenamiento y caché» fallaron en 0.2 s como «expired before execution».
 */
import { tpvHealthService } from '@/services/tpv/tpv-health.service'
import { broadcastTpvCommand } from '@/communication/sockets'
import { tpvCommandQueueService } from '@/services/tpv/command-queue.service'

jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: {} }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  broadcastTpvCommand: jest.fn(),
  broadcastTpvStatusUpdate: jest.fn(),
  broadcastTpvCommandStatusChanged: jest.fn(),
}))
jest.mock('@/services/tpv/command-queue.service', () => ({
  __esModule: true,
  tpvCommandQueueService: { queueCommand: jest.fn() },
}))

const EXPIRA = new Date('2026-09-24T18:18:33.890Z')

const terminal = (lastHeartbeat: Date | null) =>
  ({ id: 'term-1', venueId: 'venue-1', serialNumber: 'AVQD-N860W173570', lastHeartbeat }) as any

beforeEach(() => {
  jest.clearAllMocks()
  ;(tpvCommandQueueService.queueCommand as jest.Mock).mockResolvedValue({
    commandId: 'cmd-1',
    correlationId: 'corr-1',
    status: 'QUEUED',
    queued: false,
    terminalOnline: true,
    message: 'Command sent to terminal',
    expiresAt: EXPIRA,
  })
})

describe('sendCommand — caducidad que viaja por el socket', () => {
  it('🔴 el socket recibe la caducidad del comando en la cola', async () => {
    await tpvHealthService.sendCommand(terminal(new Date()), { type: 'FACTORY_RESET', payload: {}, requestedBy: 'sa' } as any)

    expect(broadcastTpvCommand).toHaveBeenCalledWith(
      'AVQD-N860W173570',
      'venue-1',
      expect.objectContaining({ commandId: 'cmd-1', correlationId: 'corr-1', expiresAt: EXPIRA }),
    )
  })

  it('regresión: una terminal sin latido reciente no recibe socket (el latido lo lleva)', async () => {
    await tpvHealthService.sendCommand(terminal(null), { type: 'FACTORY_RESET', payload: {}, requestedBy: 'sa' } as any)

    expect(broadcastTpvCommand).not.toHaveBeenCalled()
  })
})
