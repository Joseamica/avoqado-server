/**
 * El guardia de propiedad del ACK contesta 403, no 500 (7-sep-2026).
 *
 * Cuando una terminal acusa un comando que NO es suyo (caso real: la NEXGO BLACK de
 * Testarudo acusando el FACTORY_RESET de la PAX WHITE), el guardia lanzaba un `Error`
 * pelón ⇒ `isOperational:false` ⇒ **500**. Para la cola offline de la TPV un 5xx es
 * TRANSITORIO (`cola-offline-clasificar-la-respuesta-del-server`): invitaba a reintentar
 * un acuse que jamás va a aceptarse. Un 403 es definitivo y la TPV lo descarta.
 *
 * La comparación de seriales sigue siendo la de siempre —con o sin `AVQD-`, sin importar
 * la caja— y se fija aquí para que endurecer el error no rompa un acuse legítimo.
 */
import { tpvHealthService } from '@/services/tpv/tpv-health.service'
import { ForbiddenError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminal: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    tpvCommandQueue: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  },
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  broadcastTpvStatusUpdate: jest.fn(),
  broadcastTpvCommandStatusChanged: jest.fn(),
}))
jest.mock('@/services/tpv/command-queue.service', () => ({
  __esModule: true,
  tpvCommandQueueService: { queueCommand: jest.fn() },
}))

const findUnique = prisma.tpvCommandQueue.findUnique as jest.Mock
const update = prisma.tpvCommandQueue.update as jest.Mock

const WHITE = 'AVQD-2841653112'
const BLACK = 'AVQD-N860W173400'

const comandoDeLaWhite = () => ({
  id: 'cmd-1',
  commandType: 'FACTORY_RESET',
  correlationId: 'corr-1',
  terminal: { id: 't-white', name: 'Testarudo PAX - WHITE', venueId: 'testarudo', serialNumber: WHITE, status: 'ACTIVE' },
})

beforeEach(() => {
  jest.clearAllMocks()
  findUnique.mockResolvedValue(comandoDeLaWhite())
  update.mockResolvedValue({})
  ;(prisma.terminal.update as jest.Mock).mockResolvedValue({})
})

describe('acknowledgeCommand — propiedad del comando', () => {
  it('🔴 una terminal AJENA que acusa recibe 403 (definitivo), no 500 (transitorio), y el comando no se toca', async () => {
    const intento = tpvHealthService.acknowledgeCommand('cmd-1', BLACK, 'SUCCESS', 'Factory reset completed')

    await expect(intento).rejects.toBeInstanceOf(ForbiddenError)
    await expect(intento).rejects.toMatchObject({ statusCode: 403, isOperational: true })
    expect(update).not.toHaveBeenCalled()
  })

  it.each([WHITE, '2841653112', 'avqd-2841653112'])('REGRESIÓN — la dueña acusa con «%s» y el comando se cierra', async serial => {
    await tpvHealthService.acknowledgeCommand('cmd-1', serial, 'FAILED', 'no pudo')

    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0][0]).toMatchObject({ where: { id: 'cmd-1' }, data: { status: 'FAILED', resultStatus: 'FAILED' } })
  })
})
