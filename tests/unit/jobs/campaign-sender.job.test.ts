// tests/unit/jobs/campaign-sender.job.test.ts
/**
 * Fase 1A, Task 8 — el job que vacía el carril de envío. Nada aquí decide negocio (eso
 * vive probado en T6/T7); esto es puro cableado: reclama, despacha, y no se cae.
 */

const envMock: { MARKETING_KILL_SWITCH: string | undefined; MARKETING_TOPE_GLOBAL_POR_TICK: number; MARKETING_LOTE_POR_VENUE: number } = {
  MARKETING_KILL_SWITCH: undefined,
  MARKETING_TOPE_GLOBAL_POR_TICK: 250,
  MARKETING_LOTE_POR_VENUE: 50,
}
jest.mock('@/config/env', () => ({ env: envMock }))

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { customerCampaignDelivery: { count: jest.fn() } },
}))

jest.mock('@/services/marketing/campaignScheduler.service', () => ({
  reclamarLote: jest.fn(),
}))

jest.mock('@/services/marketing/campaignSender.service', () => ({
  enviarDelivery: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { reclamarLote } from '@/services/marketing/campaignScheduler.service'
import { enviarDelivery } from '@/services/marketing/campaignSender.service'
import { CampaignSenderJob } from '@/jobs/campaign-sender.job'

const mockCount = (prisma as unknown as { customerCampaignDelivery: { count: jest.Mock } }).customerCampaignDelivery.count
const mockReclamarLote = reclamarLote as jest.Mock
const mockEnviarDelivery = enviarDelivery as jest.Mock
const mockWarn = logger.warn as jest.Mock
const mockInfo = logger.info as jest.Mock
const mockError = logger.error as jest.Mock

/** Fila mínima que `tick()` necesita: sólo `id` y `venueId` se leen. */
const delivery = (id: string, venueId = 'venue-1') => ({
  id,
  venueId,
  campaignId: 'campaign-1',
  customerId: `customer-${id}`,
  attempts: 1,
  leaseUntil: new Date(),
  sendAttemptAt: new Date(),
})

describe('CampaignSenderJob', () => {
  let job: CampaignSenderJob

  beforeEach(() => {
    envMock.MARKETING_KILL_SWITCH = undefined
    envMock.MARKETING_TOPE_GLOBAL_POR_TICK = 250
    envMock.MARKETING_LOTE_POR_VENUE = 50
    mockCount.mockResolvedValue(1)
    mockReclamarLote.mockResolvedValue([])
    job = new CampaignSenderJob()
  })

  afterEach(() => {
    job.stop()
  })

  // ===== CASOS NUEVOS =====

  describe('kill switch (R2)', () => {
    it('con MARKETING_KILL_SWITCH=true no reclama nada — ni la cuenta de entrada', async () => {
      envMock.MARKETING_KILL_SWITCH = 'true'

      await (job as any).tick()

      expect(mockCount).not.toHaveBeenCalled()
      expect(mockReclamarLote).not.toHaveBeenCalled()
      expect(mockEnviarDelivery).not.toHaveBeenCalled()
    })

    it('lo registra UNA sola vez, no en cada tick', async () => {
      envMock.MARKETING_KILL_SWITCH = 'true'

      await (job as any).tick()
      await (job as any).tick()
      await (job as any).tick()

      expect(mockWarn).toHaveBeenCalledTimes(1)
    })

    it('si se apaga y se vuelve a prender, avisa otra vez (bandera de instancia, no de proceso)', async () => {
      envMock.MARKETING_KILL_SWITCH = 'true'
      await (job as any).tick()
      expect(mockWarn).toHaveBeenCalledTimes(1)

      envMock.MARKETING_KILL_SWITCH = 'false'
      mockCount.mockResolvedValueOnce(0)
      await (job as any).tick()

      envMock.MARKETING_KILL_SWITCH = 'true'
      await (job as any).tick()

      expect(mockWarn).toHaveBeenCalledTimes(2)
    })
  })

  describe('el fallo de una delivery no aborta el lote (R3)', () => {
    it('intenta las 3 aunque la segunda lance, y el job no lanza', async () => {
      mockReclamarLote.mockResolvedValue([delivery('a'), delivery('b'), delivery('c')])
      mockEnviarDelivery.mockResolvedValueOnce('SENT').mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('SKIPPED')

      await expect((job as any).tick()).resolves.not.toThrow()

      expect(mockEnviarDelivery).toHaveBeenCalledTimes(3)
      expect(mockEnviarDelivery).toHaveBeenNthCalledWith(1, 'a')
      expect(mockEnviarDelivery).toHaveBeenNthCalledWith(2, 'b')
      expect(mockEnviarDelivery).toHaveBeenNthCalledWith(3, 'c')
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining('reventó'), expect.objectContaining({ deliveryId: 'b' }))
    })

    it('el resumen del tick cuenta lo que sí resolvió, ignorando la que reventó', async () => {
      mockReclamarLote.mockResolvedValue([delivery('a'), delivery('b'), delivery('c')])
      mockEnviarDelivery.mockResolvedValueOnce('SENT').mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('SENT')

      await (job as any).tick()

      expect(mockInfo).toHaveBeenCalledWith('[campaign-sender] tick', expect.objectContaining({ reclamadas: 3, sent: 2, skipped: 0 }))
    })
  })

  describe('sin solapamiento (R4)', () => {
    it('un segundo tick mientras el primero corre no reclama nada', async () => {
      let resolverReclamo: (v: unknown[]) => void = () => {}
      mockReclamarLote.mockReturnValue(
        new Promise(resolve => {
          resolverReclamo = resolve
        }),
      )

      const primerTick = (job as any).tick()
      // El primer tick ya entró (isRunning=true) y está esperando a reclamarLote.
      await Promise.resolve()
      await Promise.resolve()

      const segundoTick = (job as any).tick()
      await segundoTick // el segundo debe salir de inmediato, sin tocar nada

      expect(mockReclamarLote).toHaveBeenCalledTimes(1)

      resolverReclamo([])
      await primerTick
    })
  })

  describe('el job nunca lanza hacia arriba (R5)', () => {
    it('un reclamarLote que revienta se registra y el tick termina limpio', async () => {
      mockReclamarLote.mockRejectedValue(new Error('la base se cayó'))

      await expect((job as any).tick()).resolves.not.toThrow()

      expect(mockError).toHaveBeenCalledWith('[campaign-sender] tick falló', expect.objectContaining({ err: expect.any(Error) }))
    })

    it('la cuenta de entrada agotando sus reintentos tampoco tumba el tick', async () => {
      mockCount.mockRejectedValue(new Error('P1001-ish, no reintentable por el shape del error'))

      await expect((job as any).tick()).resolves.not.toThrow()

      expect(mockReclamarLote).not.toHaveBeenCalled()
    })
  })

  describe('resumen del tick (R6)', () => {
    it('con lote vacío el tick es silencioso — sin info, sin llamar a enviarDelivery', async () => {
      mockCount.mockResolvedValue(0)

      await (job as any).tick()

      expect(mockReclamarLote).not.toHaveBeenCalled()
      expect(mockEnviarDelivery).not.toHaveBeenCalled()
      expect(mockInfo).not.toHaveBeenCalled()
    })

    it('con trabajo pendiente pero reclamarLote vacío (otro worker se lo llevó), tampoco loguea', async () => {
      mockCount.mockResolvedValue(1)
      mockReclamarLote.mockResolvedValue([])

      await (job as any).tick()

      expect(mockEnviarDelivery).not.toHaveBeenCalled()
      expect(mockInfo).not.toHaveBeenCalled()
    })

    it('reparte los 5 desenlaces posibles en el resumen', async () => {
      mockReclamarLote.mockResolvedValue([delivery('a'), delivery('b'), delivery('c'), delivery('d'), delivery('e')])
      mockEnviarDelivery
        .mockResolvedValueOnce('SENT')
        .mockResolvedValueOnce('SKIPPED')
        .mockResolvedValueOnce('RETRYING')
        .mockResolvedValueOnce('DEAD')
        .mockResolvedValueOnce('UNKNOWN')

      await (job as any).tick()

      expect(mockInfo).toHaveBeenCalledWith(
        '[campaign-sender] tick',
        expect.objectContaining({ reclamadas: 5, sent: 1, skipped: 1, retrying: 1, dead: 1, unknown: 1 }),
      )
    })
  })

  it('llama a reclamarLote con los topes de env.ts', async () => {
    envMock.MARKETING_TOPE_GLOBAL_POR_TICK = 77
    envMock.MARKETING_LOTE_POR_VENUE = 9
    mockReclamarLote.mockResolvedValue([])

    await (job as any).tick()

    expect(mockReclamarLote).toHaveBeenCalledWith(expect.objectContaining({ topeGlobal: 77, lotePorVenue: 9, ahora: expect.any(Date) }))
  })

  // ===== REGRESIÓN =====

  it('start()/stop() no lanzan', () => {
    expect(() => job.start()).not.toThrow()
    expect(() => job.stop()).not.toThrow()
  })
})
