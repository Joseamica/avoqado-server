import { getEffectivePaymentConfig } from '@/services/organization-payment-config.service'
jest.mock('@/services/organization-payment-config.service', () => ({ getEffectivePaymentConfig: jest.fn() }))
import { TpvCommandQueueService } from '@/services/tpv/command-queue.service'
import { prismaMock } from '@tests/__helpers__/setup'
const service = new TpvCommandQueueService()
const command = {
  id: 'c1',
  terminalId: 't1',
  venueId: 'v1',
  status: 'SENT',
  commandType: 'LOCK',
  terminal: { id: 't1', serialNumber: '123', venueId: 'v1' },
}
beforeEach(() => {
  ;(getEffectivePaymentConfig as jest.Mock).mockResolvedValue({
    config: { primaryAccount: { active: true, provider: { code: 'BLUMON' } } },
  })
  prismaMock.$transaction.mockImplementation(async (callback: any) => callback({ ...prismaMock }))
  prismaMock.tpvCommandQueue.findUnique.mockResolvedValue(command as any)
  prismaMock.tpvCommandQueue.updateMany.mockResolvedValue({ count: 1 })
  jest.spyOn(service as any, 'createHistoryEntry').mockResolvedValue(undefined)
  jest.spyOn(service as any, 'broadcastStatusChange').mockResolvedValue(undefined)
})
it.each(['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'])('P1 socket result cannot overwrite %s', async status => {
  prismaMock.tpvCommandQueue.findUnique.mockResolvedValue({ ...command, status } as any)
  await service.handleCommandResult('c1', '123', 'FAILED')
  expect(prismaMock.tpvCommandQueue.update).not.toHaveBeenCalled()
  expect(prismaMock.tpvCommandQueue.updateMany).not.toHaveBeenCalled()
})
it('socket ACK cannot change another terminal command', async () => {
  await expect(service.handleCommandAck('c1', '999')).rejects.toMatchObject({ statusCode: 403 })
})
it('cancel uses a conditional update against delivery, inside a transaction', async () => {
  prismaMock.tpvCommandQueue.findUnique.mockResolvedValue({ ...command, status: 'QUEUED' } as any)
  prismaMock.tpvCommandQueue.updateMany.mockResolvedValue({ count: 0 })
  await expect(service.cancelCommand('c1', 'u1')).rejects.toMatchObject({ statusCode: 400 })
  expect(prismaMock.$transaction).toHaveBeenCalled()
  expect(prismaMock.tpvCommandQueue.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: 'c1', status: { in: ['PENDING', 'QUEUED'] } } }),
  )
})

it('an execution permit is replayable only by the same app session', async () => {
  const sessionId = 'boot1'
  prismaMock.tpvCommandQueue.findUnique.mockResolvedValue({
    ...command,
    status: 'EXECUTING',
    resultPayload: { executionSessionId: sessionId },
    terminal: { ...command.terminal, commandSessionId: sessionId },
  } as any)
  expect(await service.updateCommandStatus('c1', 'EXECUTING', undefined, undefined, 't1', { executionSessionId: sessionId })).toBe(true)
  expect(await service.updateCommandStatus('c1', 'EXECUTING', undefined, undefined, 't1', { executionSessionId: 'boot2' })).toBe(false)
  expect(prismaMock.tpvCommandQueue.updateMany).not.toHaveBeenCalled()
})

it('commits a server-owned migration intent only inside the safe execution permit', async () => {
  const sessionId = 'boot1'
  prismaMock.tpvCommandQueue.findUnique.mockResolvedValue({
    ...command,
    commandType: 'FACTORY_RESET',
    payload: { _deliveryProtocol: 2, _migrationIntent: { toVenueId: 'v2', assignedMerchantIds: [] } },
    requestedBy: 'u1',
    terminal: { ...command.terminal, commandSessionId: sessionId },
  } as any)
  prismaMock.venue.findUnique.mockResolvedValue({ id: 'v2', organizationId: 'o1' } as any)
  prismaMock.terminal.updateMany.mockResolvedValue({ count: 1 })
  expect(await service.updateCommandStatus('c1', 'EXECUTING', undefined, undefined, 't1', { executionSessionId: sessionId })).toBe(true)
  expect(prismaMock.terminal.updateMany).toHaveBeenCalledWith({
    where: { id: 't1', venueId: 'v1' },
    data: { venueId: 'v2', assignedMerchantIds: [] },
  })
  expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        action: 'TERMINAL_MIGRATION_COMMITTED',
        entityId: 't1',
        venueId: 'v2',
        staffId: 'u1',
      }),
    }),
  )
})

it('durable delivery can be cancelled before a permit, never during EXECUTING', async () => {
  prismaMock.tpvCommandQueue.findUnique.mockResolvedValue({ ...command, payload: { _deliveryProtocol: 2 } } as any)
  await service.cancelCommand('c1', 'u1')
  prismaMock.tpvCommandQueue.findUnique.mockResolvedValue({ ...command, status: 'EXECUTING', payload: { _deliveryProtocol: 2 } } as any)
  await expect(service.cancelCommand('c1', 'u1')).rejects.toMatchObject({ statusCode: 400 })
})

it('an indefinite migration revalidates its inherited payment config before moving', async () => {
  const sessionId = 'boot1'
  prismaMock.tpvCommandQueue.findUnique.mockResolvedValue({
    ...command,
    commandType: 'FACTORY_RESET',
    payload: { _deliveryProtocol: 2, _migrationIntent: { toVenueId: 'v2', assignedMerchantIds: [] } },
    terminal: { ...command.terminal, commandSessionId: sessionId },
  } as any)
  prismaMock.venue.findUnique.mockResolvedValue({ id: 'v2', organizationId: 'o1' } as any)
  ;(getEffectivePaymentConfig as jest.Mock).mockResolvedValue(null)
  await expect(
    service.updateCommandStatus('c1', 'EXECUTING', undefined, undefined, 't1', { executionSessionId: sessionId }),
  ).rejects.toMatchObject({ statusCode: 400 })
  expect(prismaMock.terminal.updateMany).not.toHaveBeenCalled()
})

it('a generic payload cannot inject a server-owned migration intent', async () => {
  await expect(
    service.queueCommand({
      terminalId: 't1',
      venueId: 'v1',
      commandType: 'FACTORY_RESET',
      requestedBy: 'u1',
      payload: { _migrationIntent: { toVenueId: 'v2', assignedMerchantIds: [] } },
    }),
  ).rejects.toMatchObject({ statusCode: 400 })
  expect(prismaMock.tpvCommandQueue.create).not.toHaveBeenCalled()
})
