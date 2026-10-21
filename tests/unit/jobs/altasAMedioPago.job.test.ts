/**
 * 🔴 R1/R2 de la campaña 3DS: el barrido de las altas que se quedaron «esperando al banco» sin nadie en la pantalla.
 * La decisión de cada alta la toma `cerrarAltaSinNavegador` (probada en la suite de planActivation); aquí sólo se prueba
 * QUÉ altas se revisan y que una que falla no detiene a las demás.
 */
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { onboardingProgress: { findMany: jest.fn() } },
}))
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
jest.mock('@/observability/jobContext', () => ({ scheduleJob: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })) }))

import prisma from '@/utils/prismaClient'
import { AltasAMedioPagoJob } from '@/jobs/altas-a-medio-pago.job'

let resolver: jest.Mock
const nuevoJob = () => new AltasAMedioPagoJob({ cron: { start: jest.fn(), stop: jest.fn() }, resolver })
const findMany = () => prisma.onboardingProgress.findMany as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  resolver = jest.fn().mockResolvedValue('NADA')
  findMany().mockResolvedValue([])
})

describe('altas-a-medio-pago', () => {
  it('J.1 revisa sólo altas a medio pago, con suscripción, sin lease vivo y quietas 15 min; lote acotado', async () => {
    const ahora = Date.now()
    await nuevoJob().runNow()

    const { where, take } = findMany().mock.calls[0][0]
    expect(take).toBe(25)
    expect(where).toMatchObject({ completedAt: null, planActivationStatus: 'IN_PROGRESS', planStripeSubscriptionId: { not: null } })
    expect(where.OR).toEqual([{ planActivationLeaseUntil: null }, { planActivationLeaseUntil: { lt: expect.any(Date) } }])
    const quieta = where.updatedAt.lt.getTime()
    expect(ahora - quieta).toBeGreaterThanOrEqual(15 * 60_000 - 1_000)
    expect(ahora - quieta).toBeLessThanOrEqual(15 * 60_000 + 5_000)
  })

  it('J.2 una alta que falla no detiene a las demás', async () => {
    findMany().mockResolvedValue([
      { id: 'op-1', organizationId: 'org-1' },
      { id: 'op-2', organizationId: 'org-2' },
    ])
    resolver.mockRejectedValueOnce(new Error('Stripe no contestó')).mockResolvedValueOnce('CERRADA')

    const r = await nuevoJob().runNow()

    expect(resolver).toHaveBeenCalledWith('org-1')
    expect(resolver).toHaveBeenCalledWith('org-2')
    expect(r).toEqual({ revisadas: 2, cerradas: 1, liberadas: 0, fallidas: 1 })
  })

  it('J.3 el cursor rota: la siguiente corrida empieza después de la última revisada', async () => {
    const job = nuevoJob()
    findMany().mockResolvedValueOnce([{ id: 'op-1', organizationId: 'org-1' }])
    await job.runNow()
    await job.runNow()

    expect(findMany().mock.calls[1][0]).toMatchObject({ cursor: { id: 'op-1' }, skip: 1 })
  })
})
