import { getEffectivePaymentConfig } from '@/services/organization-payment-config.service'
import { borrarDisenoAlCambiarDeNegocio, invalidateCustomerDisplayCache } from '@/services/customer-display/customerDisplayVenueChange'
jest.mock('@/services/organization-payment-config.service', () => ({ getEffectivePaymentConfig: jest.fn() }))
jest.mock('@/services/customer-display/customerDisplayVenueChange', () => ({
  borrarDisenoAlCambiarDeNegocio: jest.fn().mockResolvedValue({ cambio: true, disenoBorrado: false, fromVenueId: 'v1' }),
  invalidateCustomerDisplayCache: jest.fn(),
}))
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

// 🔴 §4.3 del plan de la pantalla del cliente: el permiso de ejecución del protocolo 2 MUDA la terminal. El gancho va en
// esa misma transacción, antes del `terminal.updateMany` que escribe `venueId`, y la caché se invalida sólo tras el commit.
describe('el gancho de la pantalla del cliente cuando el permiso de ejecución muda la terminal', () => {
  const mockGancho = borrarDisenoAlCambiarDeNegocio as jest.Mock
  const mockInvalidar = invalidateCustomerDisplayCache as jest.Mock
  const sessionId = 'boot1'
  let tx: any
  let confirmar!: () => void
  let fallarCommit!: (e: unknown) => void
  const flush = () => new Promise(r => setImmediate(r))
  const conIntencion = (over: Record<string, unknown> = {}) => ({
    ...command,
    commandType: 'FACTORY_RESET',
    payload: { _deliveryProtocol: 2, _migrationIntent: { toVenueId: 'v2', assignedMerchantIds: [] } },
    requestedBy: 'u1',
    terminal: { ...command.terminal, commandSessionId: sessionId },
    ...over,
  })
  const ejecutar = () => service.updateCommandStatus('c1', 'EXECUTING', undefined, undefined, 't1', { executionSessionId: sessionId })

  beforeEach(() => {
    tx = { ...prismaMock } // un `tx` DISTINTO del cliente global
    prismaMock.$transaction.mockImplementation(
      (fn: any) =>
        new Promise((resolve, reject) => {
          Promise.resolve(fn(tx)).then(v => {
            confirmar = () => resolve(v)
            fallarCommit = reject
          }, reject)
        }),
    )
    prismaMock.venue.findUnique.mockResolvedValue({ id: 'v2', organizationId: 'o1' } as any)
    prismaMock.terminal.updateMany.mockResolvedValue({ count: 1 })
  })

  it('(d) EXECUTING con intención: gancho en la transacción, antes de escribir venueId; invalida sólo tras el commit', async () => {
    prismaMock.tpvCommandQueue.findUnique.mockResolvedValue(conIntencion() as any)
    const permiso = ejecutar()
    await flush()

    expect(mockGancho).toHaveBeenCalledTimes(1)
    expect(mockGancho).toHaveBeenCalledWith(tx, { terminalId: 't1', toVenueId: 'v2', reason: 'terminal_moved', staffId: 'u1' })
    expect(mockGancho.mock.calls[0][0]).toBe(tx)
    expect(mockGancho.mock.calls[0][0]).not.toBe(prismaMock)
    expect(mockGancho.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.terminal.updateMany.mock.invocationCallOrder[0])
    expect(mockInvalidar).toHaveBeenCalledTimes(0)

    confirmar()
    expect(await permiso).toBe(true)
    expect(mockInvalidar).toHaveBeenCalledTimes(1)
    expect(mockInvalidar).toHaveBeenCalledWith('t1')
  })

  it('(d) si el commit falla, no se invalida nada', async () => {
    prismaMock.tpvCommandQueue.findUnique.mockResolvedValue(conIntencion() as any)
    const permiso = ejecutar()
    await flush()
    expect(mockGancho).toHaveBeenCalledTimes(1)

    fallarCommit(new Error('commit'))
    await expect(permiso).rejects.toThrow('commit')
    expect(mockInvalidar).toHaveBeenCalledTimes(0)
  })

  it("(e) una orden de 'system' llega al gancho con staffId null", async () => {
    prismaMock.tpvCommandQueue.findUnique.mockResolvedValue(conIntencion({ requestedBy: 'system' }) as any)
    const permiso = ejecutar()
    await flush()
    confirmar()
    await permiso

    expect(mockGancho).toHaveBeenCalledWith(tx, { terminalId: 't1', toVenueId: 'v2', reason: 'terminal_moved', staffId: null })
  })

  it('(f) EXECUTING sin intención, la repetición de la misma sesión y un ACK: ni gancho ni invalidación', async () => {
    // EXECUTING sin `_migrationIntent`: no muda nada.
    prismaMock.tpvCommandQueue.findUnique.mockResolvedValue({
      ...command,
      terminal: { ...command.terminal, commandSessionId: sessionId },
    } as any)
    let r = ejecutar()
    await flush()
    confirmar()
    expect(await r).toBe(true)

    // La repetición del permiso por la MISMA sesión: ya se había mudado; se contesta sin volver a escribir.
    prismaMock.tpvCommandQueue.findUnique.mockResolvedValue(
      conIntencion({ status: 'EXECUTING', resultPayload: { executionSessionId: sessionId } }) as any,
    )
    r = ejecutar()
    await flush()
    confirmar()
    expect(await r).toBe(true)

    // Un ACK (RECEIVED) de una orden con intención: todavía no hay permiso de ejecución.
    prismaMock.tpvCommandQueue.findUnique.mockResolvedValue(conIntencion() as any)
    const ack = service.handleCommandAck('c1', 't1')
    await flush()
    confirmar()
    await ack

    expect(mockGancho).not.toHaveBeenCalled()
    expect(mockInvalidar).not.toHaveBeenCalled()
  })
})
