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
let terminar: jest.Mock
const nuevoJob = () => new AltasAMedioPagoJob({ cron: { start: jest.fn(), stop: jest.fn() }, resolver, terminar })
const findMany = () => prisma.onboardingProgress.findMany as jest.Mock
/** Las consultas de cada lote: el de «esperando al banco» (IN_PROGRESS) y el de H0 (plan ACTIVE sin terminar). */
const consultasDel = (estado: string) => findMany().mock.calls.filter(c => c[0].where.planActivationStatus === estado)

beforeEach(() => {
  jest.clearAllMocks()
  resolver = jest.fn().mockResolvedValue('NADA')
  terminar = jest.fn().mockResolvedValue({ estado: 'NADA', motivo: 'CIERRE_EN_CURSO' })
  findMany().mockResolvedValue([])
})

describe('altas-a-medio-pago', () => {
  it('J.1 revisa sólo altas a medio pago, con suscripción, sin lease vivo y quietas 15 min; lote acotado', async () => {
    const ahora = Date.now()
    await nuevoJob().runNow()

    const { where, take } = consultasDel('IN_PROGRESS')[0][0]
    expect(take).toBe(25)
    expect(where).toMatchObject({ completedAt: null, planActivationStatus: 'IN_PROGRESS', planStripeSubscriptionId: { not: null } })
    expect(where.OR).toEqual([{ planActivationLeaseUntil: null }, { planActivationLeaseUntil: { lt: expect.any(Date) } }])
    const quieta = where.updatedAt.lt.getTime()
    expect(ahora - quieta).toBeGreaterThanOrEqual(15 * 60_000 - 1_000)
    expect(ahora - quieta).toBeLessThanOrEqual(15 * 60_000 + 5_000)
  })

  it('J.2 una alta que falla no detiene a las demás', async () => {
    findMany().mockImplementation(async ({ where }: { where: { planActivationStatus: string } }) =>
      where.planActivationStatus === 'IN_PROGRESS'
        ? [
            { id: 'op-1', organizationId: 'org-1' },
            { id: 'op-2', organizationId: 'org-2' },
          ]
        : [],
    )
    resolver.mockRejectedValueOnce(new Error('Stripe no contestó')).mockResolvedValueOnce('CERRADA')

    const r = await nuevoJob().runNow()

    expect(resolver).toHaveBeenCalledWith('org-1')
    expect(resolver).toHaveBeenCalledWith('org-2')
    expect(r).toEqual({ revisadas: 2, cerradas: 1, liberadas: 0, terminadas: 0, fallidas: 1 })
  })

  it('J.3 el cursor rota: la siguiente corrida empieza después de la última revisada', async () => {
    const job = nuevoJob()
    findMany().mockImplementationOnce(async () => [{ id: 'op-1', organizationId: 'org-1' }])
    await job.runNow()
    await job.runNow()

    expect(consultasDel('IN_PROGRESS')[1][0]).toMatchObject({ cursor: { id: 'op-1' }, skip: 1 })
  })

  describe('🔴 H0: el plan ACTIVE con el alta sin terminar (o a medias) se termina aquí', () => {
    it('J.4 revisa el plan ACTIVE sin terminar o con la organización sin terminar, quieto 2 min; lote acotado', async () => {
      const ahora = Date.now()
      await nuevoJob().runNow()

      const { where, take } = consultasDel('ACTIVE')[0][0]
      expect(take).toBe(25)
      expect(where.OR).toEqual([{ completedAt: null }, { organization: { onboardingCompletedAt: null } }])
      const quieta = where.updatedAt.lt.getTime()
      expect(ahora - quieta).toBeGreaterThanOrEqual(2 * 60_000 - 1_000)
      expect(ahora - quieta).toBeLessThanOrEqual(2 * 60_000 + 5_000)
    })

    it('J.5 cada una se termina con el cierre compartido; una que falla no detiene a las demás', async () => {
      findMany().mockImplementation(async ({ where }: { where: { planActivationStatus: string } }) =>
        where.planActivationStatus === 'ACTIVE'
          ? [
              { id: 'op-7', organizationId: 'org-7' },
              { id: 'op-8', organizationId: 'org-8' },
            ]
          : [],
      )
      terminar.mockRejectedValueOnce(new Error('base caída')).mockResolvedValueOnce({ estado: 'TERMINADA', venue: { id: 'v-8' } })

      const r = await nuevoJob().runNow()

      expect(terminar).toHaveBeenCalledWith('org-7')
      expect(terminar).toHaveBeenCalledWith('org-8')
      expect(resolver).not.toHaveBeenCalled()
      expect(r).toEqual({ revisadas: 2, cerradas: 0, liberadas: 0, terminadas: 1, fallidas: 1 })
    })

    it('J.6 su cursor es independiente del lote IN_PROGRESS', async () => {
      const job = nuevoJob()
      findMany().mockImplementation(async ({ where }: { where: { planActivationStatus: string } }) =>
        where.planActivationStatus === 'ACTIVE' ? [{ id: 'op-9', organizationId: 'org-9' }] : [],
      )
      await job.runNow()
      await job.runNow()

      expect(consultasDel('ACTIVE')[1][0]).toMatchObject({ cursor: { id: 'op-9' }, skip: 1 })
      expect(consultasDel('IN_PROGRESS')[1][0].cursor).toBeUndefined()
    })
  })
})
