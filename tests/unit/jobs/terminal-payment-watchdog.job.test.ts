/**
 * El vigía de cobros remotos (cada 30 s). Cobro simple · S1 (22-nov): en este orden concilia o mete a «sin respuesta» lo vencido,
 * le pregunta a la terminal por las SENT sin final, concilia lo tardío, CIERRA lo que cumplió sus 10 s (la red del temporizador y
 * las filas de antes de S1) y recupera el long-poll desde la fila. Ya no corren la ventana de 30 s, S2 (cese) ni el techo D26: con
 * S1 una duda no aparta la terminal y se cierra sola. Cada paso en su propio try/catch: uno que truena no tumba a los demás.
 */
jest.mock('@/services/terminal-payment.service', () => ({
  terminalPaymentService: {
    reconcileStaleRequests: jest.fn().mockResolvedValue({ completed: 0, unknown: 0, cancelled: 0 }),
    preguntarPorSolicitudesSinFinal: jest.fn().mockResolvedValue({ entradas: 0, preguntas: 0 }),
    reconcileUnknownRequests: jest.fn().mockResolvedValue(undefined),
    cerrarSinRespuestaVencidas: jest.fn().mockResolvedValue({}),
    resolvePendingFromDurableState: jest.fn().mockResolvedValue({ resolved: 0, checked: 0 }),
    releaseUnprovenNegativesAfterWindow: jest.fn(),
    liberarTrasCierreDeEjecucion: jest.fn(),
    liberarPorTechoTrasCancelar: jest.fn(),
  },
}))
jest.mock('@/services/tpv/angelpay-webhook.service', () => ({ recuperarAvisosAprobadosSinReferencias: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/observability/jobContext', () => ({ scheduleJob: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })) }))

import logger from '@/config/logger'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { TerminalPaymentWatchdogJob } from '@/jobs/terminal-payment-watchdog.job'

const s = terminalPaymentService as unknown as Record<string, jest.Mock>

describe('Cobro simple · S1 · el vigía', () => {
  beforeEach(() => jest.clearAllMocks())

  it('corre los pasos de S1 en orden y ya no la ventana, S2 ni el techo', async () => {
    await new TerminalPaymentWatchdogJob().run()
    const orden = [
      s.reconcileStaleRequests,
      s.preguntarPorSolicitudesSinFinal,
      s.reconcileUnknownRequests,
      s.cerrarSinRespuestaVencidas,
      s.resolvePendingFromDurableState,
    ].map(m => {
      expect(m).toHaveBeenCalledTimes(1)
      return m.mock.invocationCallOrder[0]
    })
    expect(orden).toEqual([...orden].sort((a, b) => a - b))
    expect(s.releaseUnprovenNegativesAfterWindow).not.toHaveBeenCalled()
    expect(s.liberarTrasCierreDeEjecucion).not.toHaveBeenCalled()
    expect(s.liberarPorTechoTrasCancelar).not.toHaveBeenCalled()
  })

  it('un paso que truena no tumba a los demás ni deja el vigía trabado', async () => {
    s.cerrarSinRespuestaVencidas.mockRejectedValueOnce(new Error('db down'))
    const job = new TerminalPaymentWatchdogJob()
    await expect(job.run()).resolves.toBeUndefined()
    expect(s.resolvePendingFromDurableState).toHaveBeenCalledTimes(1)
    expect((logger.error as jest.Mock).mock.calls.some(([m]) => String(m).includes('no-response close sweep failed'))).toBe(true)
    await job.run()
    expect(s.cerrarSinRespuestaVencidas).toHaveBeenCalledTimes(2)
  })
})
