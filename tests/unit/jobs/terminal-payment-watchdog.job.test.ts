/**
 * S5 (checkpoint 1 del webhook): el vigía de cobros remotos, además de conciliar filas viejas y UNKNOWN, recupera el
 * long-poll desde la fila (`resolvePendingFromDurableState`) — DESPUÉS de las conciliaciones, que son las que pueden
 * dejar una fila COMPLETED con Payment en ese mismo tick. Sin este cableado el método existe y nadie lo llama.
 */
jest.mock('@/services/terminal-payment.service', () => ({
  terminalPaymentService: {
    reconcileStaleRequests: jest.fn().mockResolvedValue({ completed: 0, unknown: 0, cancelled: 0 }),
    reconcileUnknownRequests: jest.fn().mockResolvedValue(undefined),
    resolvePendingFromDurableState: jest.fn().mockResolvedValue({ resolved: 0, checked: 0 }),
  },
}))
jest.mock('@/observability/jobContext', () => ({ scheduleJob: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })) }))

import { terminalPaymentService } from '@/services/terminal-payment.service'
import { TerminalPaymentWatchdogJob } from '@/jobs/terminal-payment-watchdog.job'

const s = terminalPaymentService as unknown as Record<string, jest.Mock>

describe('S5 · el vigía recupera el long-poll desde la fila en cada tick', () => {
  beforeEach(() => jest.clearAllMocks())

  it('llama a la recuperación durable en cada pasada, después de conciliar filas viejas y UNKNOWN', async () => {
    await new TerminalPaymentWatchdogJob().run()
    expect(s.reconcileStaleRequests).toHaveBeenCalledTimes(1)
    expect(s.reconcileUnknownRequests).toHaveBeenCalledTimes(1)
    expect(s.resolvePendingFromDurableState).toHaveBeenCalledTimes(1)
    const orden = [s.reconcileStaleRequests, s.reconcileUnknownRequests, s.resolvePendingFromDurableState].map(
      m => m.mock.invocationCallOrder[0],
    )
    expect(orden).toEqual([...orden].sort((a, b) => a - b))
  })

  it('un fallo de la recuperación no tumba el tick ni deja el vigía marcado como «corriendo»', async () => {
    s.resolvePendingFromDurableState.mockRejectedValueOnce(new Error('db down'))
    const job = new TerminalPaymentWatchdogJob()
    await expect(job.run()).resolves.toBeUndefined()
    await job.run()
    expect(s.reconcileStaleRequests).toHaveBeenCalledTimes(2)
  })
})
