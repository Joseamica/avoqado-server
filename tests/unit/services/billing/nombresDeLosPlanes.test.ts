/**
 * Planes editables (B4, Task 2): el nombre de los planes en correos y avisos sigue a la versión vigente del editor; sin ella
 * (o con la v1, o si leerla falla) es el de hoy.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { definicionDePrueba, idsDeLaVersion, punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'
import logger from '@/config/logger'
import {
  diasDeLaPrueba,
  nombreDeLaFeatureParaAvisos,
  nombreDelPlanParaAvisos,
  nombresDeLosPlanes,
} from '@/services/billing/nombresDeLosPlanes'

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

describe('diasDeLaPrueba (M3)', () => {
  const DIA = 86_400
  const HORA = 3_600
  it('una prueba de 14 días abierta 13 h después de su cotización sigue diciendo 14', () => {
    expect(diasDeLaPrueba(1_000, 1_000 + 14 * DIA - 13 * HORA)).toBe(14)
  })
  it('una prueba de 1 día abierta 13 h después de su cotización dice 1, nunca «30»', () => {
    expect(diasDeLaPrueba(1_000, 1_000 + 1 * DIA - 13 * HORA)).toBe(1)
  })
  it('exacta, sin prueba o sin las dos fechas', () => {
    expect(diasDeLaPrueba(0, 30 * DIA)).toBe(30)
    expect(diasDeLaPrueba(null, null)).toBeUndefined()
    expect(diasDeLaPrueba(undefined, 5)).toBeUndefined()
    expect(diasDeLaPrueba(10, 10)).toBeUndefined()
  })
})

describe('nombreDeLaFeatureParaAvisos', () => {
  it('un plan lleva el nombre del editor; cualquier otra función, su Feature.name', async () => {
    pointer.mockResolvedValue(v2Plus())
    expect(await nombreDeLaFeatureParaAvisos({ code: 'PLAN_PRO', name: 'Plan Avoqado Pro' })).toBe('Plan Avoqado Plus')
    expect(await nombreDeLaFeatureParaAvisos({ code: 'CHATBOT', name: 'Chatbot' })).toBe('Chatbot')
  })
})
