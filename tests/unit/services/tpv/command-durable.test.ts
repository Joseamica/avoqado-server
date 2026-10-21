import { TpvCommandQueueService } from '@/services/tpv/command-queue.service'
import { tpvHealthService } from '@/services/tpv/tpv-health.service'
import { prismaMock } from '@tests/__helpers__/setup'
const service = new TpvCommandQueueService()
beforeEach(() => {
  prismaMock.terminal.findUnique.mockResolvedValue({
    id: 't1',
    venueId: 'v1',
    type: 'TPV_ANDROID',
    commandProtocolVersion: 2,
    status: 'ACTIVE',
    lastHeartbeat: null,
    venue: { name: 'Test' },
  } as any)
  prismaMock.tpvCommandQueue.create.mockResolvedValue({ id: 'c1', correlationId: 'corr' } as any)
  prismaMock.tpvCommandQueue.findMany.mockResolvedValue([])
  prismaMock.tpvCommandQueue.updateMany.mockResolvedValue({ count: 1 })
  jest.spyOn(service as any, 'createHistoryEntry').mockResolvedValue(undefined)
})
it('new paired TPVs queue commands indefinitely with an explicit delivery protocol', async () => {
  await service.queueCommand({ terminalId: 't1', venueId: 'v1', commandType: 'RESTART', requestedBy: 'sa' })
  expect(prismaMock.tpvCommandQueue.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ expiresAt: null, payload: expect.objectContaining({ _deliveryProtocol: 2 }) }),
    }),
  )
})
it('durable recovery only includes SENT from the new protocol, never legacy destructive commands', async () => {
  await tpvHealthService.getPendingCommands('t1', true)
  const where = (prismaMock.tpvCommandQueue.findMany as jest.Mock).mock.calls[0][0].where
  expect(JSON.stringify(where)).toContain('_deliveryProtocol')
  expect(JSON.stringify(where)).toContain('SENT')
})
