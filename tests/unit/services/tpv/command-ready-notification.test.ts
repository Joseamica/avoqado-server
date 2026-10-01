import { TpvCommandQueueService } from '@/services/tpv/command-queue.service'
import { TpvCommandExecutionService } from '@/services/tpv/command-execution.service'
import { broadcastTpvCommand } from '@/communication/sockets'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/communication/sockets', () => ({
  broadcastTpvCommand: jest.fn(),
  broadcastTpvCommandStatusChanged: jest.fn(),
  broadcastTpvCommandQueued: jest.fn(),
  broadcastTpvStatusUpdate: jest.fn(),
}))

const service = new TpvCommandQueueService()
const input = { terminalId: 't1', venueId: 'v1', commandType: 'RESTART' as const, requestedBy: 'admin' }
let committed = false
beforeEach(() => {
  jest.clearAllMocks()
  ;(broadcastTpvCommand as jest.Mock).mockReset()
  committed = false
  prismaMock.$transaction.mockImplementation(async (fn: any) => {
    const result = await fn({ ...prismaMock })
    committed = true
    return result
  })
  ;(prismaMock as any).idempotencyRequest = { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() }
  prismaMock.terminal.findUnique.mockResolvedValue({
    id: 't1',
    serialNumber: 'AVQD-N860W173397',
    venueId: 'v1',
    type: 'TPV_ANDROID',
    status: 'ACTIVE',
    commandProtocolVersion: 2,
    lastHeartbeat: new Date(),
    venue: { name: 'Test', organizationId: 'org1' },
  } as any)
  prismaMock.tpvCommandQueue.create.mockResolvedValue({ id: 'cmd1', correlationId: 'corr1' } as any)
  jest.spyOn(service as any, 'createHistoryEntry').mockResolvedValue(undefined)
})

it('notifies the device after persisting a durable command without its action payload', async () => {
  await service.queueCommand({ ...input, payload: { privateAction: 'not-in-hint' } })
  expect(broadcastTpvCommand).toHaveBeenCalledWith(
    'AVQD-N860W173397',
    'v1',
    expect.objectContaining({
      commandId: 'cmd1',
      type: 'RESTART',
      payload: { _deliveryProtocol: 2 },
    }),
  )
  expect(prismaMock.tpvCommandQueue.create).toHaveBeenCalled()
})

it('notifies an idempotent request after commit and never notifies its replay', async () => {
  ;(broadcastTpvCommand as jest.Mock).mockImplementation(() => expect(committed).toBe(true))
  await service.queueCommand({ ...input, idempotencyKey: 'request1' })
  const saved = (prismaMock as any).idempotencyRequest.create.mock.calls[0][0].data
  ;(prismaMock as any).idempotencyRequest.findUnique.mockResolvedValue(saved)
  await service.queueCommand({ ...input, idempotencyKey: 'request1' })
  expect(broadcastTpvCommand).toHaveBeenCalledTimes(1)
})

it('does not notify a transaction that its caller has not committed', async () => {
  await service.queueCommand(input, { ...prismaMock } as any)
  expect(broadcastTpvCommand).not.toHaveBeenCalled()
})

it('does not wake a device for a scheduled command before its due time', async () => {
  await service.queueCommand({ ...input, scheduledFor: new Date(Date.now() + 60000) })
  expect(broadcastTpvCommand).not.toHaveBeenCalled()
})

it('the delivery service only hints durable commands and never marks them SENT', async () => {
  prismaMock.tpvCommandQueue.findUnique.mockResolvedValue({
    id: 'cmd1',
    commandType: 'RESTART',
    status: 'QUEUED',
    venueId: 'v1',
    requestedBy: 'admin',
    payload: { _deliveryProtocol: 2 },
    terminal: { id: 't1', serialNumber: 'AVQD-N860W173397', venueId: 'v1' },
  } as any)
  await new TpvCommandExecutionService().sendCommandToTerminal('cmd1')
  expect(broadcastTpvCommand).toHaveBeenCalledTimes(1)
  expect(prismaMock.tpvCommandQueue.update).not.toHaveBeenCalled()
  expect(prismaMock.tpvCommandQueue.updateMany).not.toHaveBeenCalled()
})
