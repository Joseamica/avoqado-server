/**
 * Planes editables (B4, Task 2): el nombre de los planes en correos y avisos sigue a la versión vigente del editor; sin ella
 * (o con la v1, o si leerla falla) es el de hoy.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { definicionDePrueba, idsDeLaVersion, punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'
import logger from '@/config/logger'
import { nombreDelPlanParaAvisos, nombresDeLosPlanes } from '@/services/billing/nombresDeLosPlanes'

const pointer = prismaMock.planOfferPointer.findUnique as jest.Mock
const v2Plus = () =>
  punteroA('ver_v2', 2, definicionDePrueba({ ids: idsDeLaVersion('v2'), nombres: { PRO: 'Plus' }, productos: { PRO: 'Avoqado Plus' } }))

beforeEach(() => {
  pointer.mockReset().mockResolvedValue(null)
  ;(logger.warn as jest.Mock).mockClear()
})

describe('nombresDeLosPlanes', () => {
  it('sin versiones: Gratis / Pro / Premium', async () => {
    expect(await nombresDeLosPlanes()).toEqual({ FREE: 'Gratis', PRO: 'Pro', PREMIUM: 'Premium' })
  })

  it('con la v1: Gratis / Pro / Premium', async () => {
    pointer.mockResolvedValue(punteroA('ver_v1', 1, versionUno()))
    expect(await nombresDeLosPlanes()).toEqual({ FREE: 'Gratis', PRO: 'Pro', PREMIUM: 'Premium' })
  })

  it('con la vigente dañada: los de hoy y un warn, sin lanzar', async () => {
    pointer.mockResolvedValue(punteroA('ver_v2', 2, { schemaVersion: 1 }))
    expect(await nombresDeLosPlanes()).toEqual({ FREE: 'Gratis', PRO: 'Pro', PREMIUM: 'Premium' })
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('con la v2 «Plus»: PRO es Plus', async () => {
    pointer.mockResolvedValue(v2Plus())
    expect(await nombresDeLosPlanes()).toEqual({ FREE: 'Gratis', PRO: 'Plus', PREMIUM: 'Premium' })
  })
})

describe('nombreDelPlanParaAvisos', () => {
  it('sin versión: el nombre de hoy, tal cual', async () => {
    expect(await nombreDelPlanParaAvisos('PLAN_PRO', 'Plan Avoqado Pro')).toBe('Plan Avoqado Pro')
  })

  it('con la v2: «Plan Avoqado Plus»', async () => {
    pointer.mockResolvedValue(v2Plus())
    expect(await nombreDelPlanParaAvisos('PLAN_PRO', 'Plan Avoqado Pro')).toBe('Plan Avoqado Plus')
    expect(await nombreDelPlanParaAvisos('PLAN_PREMIUM', 'Plan Avoqado Premium')).toBe('Plan Avoqado Premium')
  })

  it('con la vigente dañada: el nombre de hoy', async () => {
    pointer.mockResolvedValue(punteroA('ver_v2', 2, { schemaVersion: 1 }))
    expect(await nombreDelPlanParaAvisos('PLAN_PRO', 'Plan Avoqado Pro')).toBe('Plan Avoqado Pro')
  })
})
