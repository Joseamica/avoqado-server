import { TpvCommandQueueService } from '@/services/tpv/command-queue.service'
import { prismaMock } from '@tests/__helpers__/setup'
const input = { terminalId: 't1', venueId: 'v1', commandType: 'RESTART' as const, requestedBy: 'u1', idempotencyKey: 'retry-1' }
const service = new TpvCommandQueueService()
beforeEach(() => {
  prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
  ;(prismaMock as any).idempotencyRequest = { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() }
  prismaMock.terminal.findUnique.mockResolvedValue({
    id: 't1',
    venueId: 'v1',
    type: 'TPV_ANDROID',
    status: 'ACTIVE',
    lastHeartbeat: null,
    venue: { name: 'Test', organizationId: 'o1' },
  } as any)
  prismaMock.tpvCommandQueue.create.mockResolvedValue({ id: 'cmd-1', correlationId: 'corr-1' } as any)
  jest.spyOn(service as any, 'createHistoryEntry').mockResolvedValue(undefined)
})
it('P2 replays the same logical request without creating another command', async () => {
  const first = await service.queueCommand(input)
  const create = (prismaMock as any).idempotencyRequest.create
  expect(create).toHaveBeenCalledTimes(1)
  const saved = create.mock.calls[0][0].data
  ;(prismaMock as any).idempotencyRequest.findUnique.mockResolvedValue(saved)
  expect(await service.queueCommand(input)).toEqual({ ...first, replayed: true })
  expect(prismaMock.tpvCommandQueue.create).toHaveBeenCalledTimes(1)
})
it('same key with another command is a conflict', async () => {
  await service.queueCommand(input)
  const saved = (prismaMock as any).idempotencyRequest.create.mock.calls[0][0].data
  ;(prismaMock as any).idempotencyRequest.findUnique.mockResolvedValue(saved)
  await expect(service.queueCommand({ ...input, commandType: 'SHUTDOWN' })).rejects.toMatchObject({ statusCode: 409 })
})
