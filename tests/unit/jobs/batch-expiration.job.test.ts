/**
 * El cron de expiración de lotes existe y delega en markExpiredBatches.
 *
 * Contexto (auditoría FIFO 2026-06-11): markExpiredBatches existía pero NADA
 * lo invocaba — los lotes caducados se quedaban ACTIVE para siempre y FIFO los
 * seguía consumiendo. Este test fija que el job exista, corra a diario y
 * llame al servicio.
 */

import { batchExpirationJob } from '@/jobs/batch-expiration.job'
import * as fifoBatchService from '@/services/dashboard/fifoBatch.service'

jest.mock('@/services/dashboard/fifoBatch.service', () => ({
  markExpiredBatches: jest.fn().mockResolvedValue(3),
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

describe('batchExpirationJob', () => {
  it('runNow() ejecuta markExpiredBatches para todos los venues', async () => {
    await batchExpirationJob.runNow()

    expect(fifoBatchService.markExpiredBatches).toHaveBeenCalledTimes(1)
    expect(fifoBatchService.markExpiredBatches).toHaveBeenCalledWith()
  })

  it('expone start/stop para el ciclo de vida del servidor', () => {
    expect(typeof batchExpirationJob.start).toBe('function')
    expect(typeof batchExpirationJob.stop).toBe('function')
  })
})
