import { prismaMock } from '@tests/__helpers__/setup'
import { definicionDePrueba, idsDeLaVersion } from '@tests/__helpers__/planOfferFixtures'

const listos = { SERVIDOR_LISTO_PARA_PLANES_EDITABLES: false, cuponDeIntroduccionRetirado: () => false }
jest.mock('@/services/billing/planesEditablesListos', () => ({
  __esModule: true,
  get SERVIDOR_LISTO_PARA_PLANES_EDITABLES() {
    return listos.SERVIDOR_LISTO_PARA_PLANES_EDITABLES
  },
  cuponDeIntroduccionRetirado: () => listos.cuponDeIntroduccionRetirado(),
}))

import {
  __resetInterruptorPlanesParaPruebas,
  apagarPlanesEditables,
  CLAVE_PLANES_EDITABLES,
  estadoDelInterruptor,
  planesEditablesPrendidos,
  prenderPlanesEditables,
  requisitosFaltantes,
} from '@/services/billing/interruptorPlanesEditables'

const fila = () => prismaMock.interruptorDePlataforma
const raw = () => prismaMock.$queryRaw as unknown as jest.Mock
const exec = () => prismaMock.$executeRaw as unknown as jest.Mock
const textoDe = (llamada: unknown[]) => (llamada[0] as string[]).join('?')

const conVigente = (def: unknown) =>
  (prismaMock.planOfferPointer.findUnique as jest.Mock).mockResolvedValue({
    currentVersion: { id: 'v1', number: 1, status: 'PUBLISHED', definition: def },
  })

beforeEach(() => {
  __resetInterruptorPlanesParaPruebas()
  listos.SERVIDOR_LISTO_PARA_PLANES_EDITABLES = false
  listos.cuponDeIntroduccionRetirado = () => false
  ;(prismaMock.planOfferPointer.findUnique as jest.Mock).mockResolvedValue(null)
})

describe('lectura', () => {
  it('sin renglón está apagado; con desde no nulo, prendido', async () => {
    fila().findUnique.mockResolvedValue(null)
    await expect(planesEditablesPrendidos({ sinCache: true })).resolves.toBe(false)
    fila().findUnique.mockResolvedValue({ desde: new Date() } as any)
    await expect(planesEditablesPrendidos({ sinCache: true })).resolves.toBe(true)
    expect(fila().findUnique).toHaveBeenCalledWith({ where: { clave: CLAVE_PLANES_EDITABLES }, select: { desde: true } })
  })

  it('lee con caché de 5 s y sinCache va a la base', async () => {
    fila().findUnique.mockResolvedValue(null)
    await planesEditablesPrendidos()
    await planesEditablesPrendidos()
    expect(fila().findUnique).toHaveBeenCalledTimes(1)
    await planesEditablesPrendidos({ sinCache: true })
    await planesEditablesPrendidos({ sinCache: true })
    expect(fila().findUnique).toHaveBeenCalledTimes(3)
  })
})

describe('requisitos y prender', () => {
  it('🔴 con el código de B1 no se puede prender: 409 PLAN_EDIT_PREREQUISITE con SERVIDOR_LISTO y no escribe', async () => {
    conVigente(definicionDePrueba({ ids: idsDeLaVersion('a') }))
    listos.cuponDeIntroduccionRetirado = () => true
    await expect(prenderPlanesEditables('s1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_EDIT_PREREQUISITE',
      details: { faltan: ['SERVIDOR_LISTO'] },
    })
    expect(raw()).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('faltan VERSION_1 sin vigente o con una ranura sin priceId; CUPON_DE_INTRODUCCION mientras legacyIntro exista', async () => {
    await expect(requisitosFaltantes()).resolves.toEqual(['VERSION_1', 'CUPON_DE_INTRODUCCION', 'SERVIDOR_LISTO'])
    conVigente(definicionDePrueba({ ids: { ...idsDeLaVersion('a'), 'PRO:annual': null } }))
    await expect(requisitosFaltantes()).resolves.toContain('VERSION_1')
    conVigente(definicionDePrueba({ ids: idsDeLaVersion('a') }))
    await expect(requisitosFaltantes()).resolves.toEqual(['CUPON_DE_INTRODUCCION', 'SERVIDOR_LISTO'])
  })

  it('con todo listo escribe desde con clock_timestamp después de tomar plan-offer-publish y deja bitácora PLAN_OFFER_SWITCH_ON', async () => {
    conVigente(definicionDePrueba({ ids: idsDeLaVersion('a') }))
    listos.SERVIDOR_LISTO_PARA_PLANES_EDITABLES = true
    listos.cuponDeIntroduccionRetirado = () => true
    const desde = new Date('2026-11-25T12:00:00Z')
    raw().mockResolvedValue([{ desde }])
    await expect(prenderPlanesEditables('s1')).resolves.toEqual({ desde })
    expect(textoDe(exec().mock.calls[0])).toContain('pg_advisory_xact_lock')
    expect(exec().mock.calls[0].slice(1)).toEqual(['plan-offer-publish'])
    expect(exec().mock.invocationCallOrder[0]).toBeLessThan(raw().mock.invocationCallOrder[0])
    expect(textoDe(raw().mock.calls[0])).toContain('clock_timestamp()')
    expect(raw().mock.calls[0].slice(1)).toEqual(expect.arrayContaining([CLAVE_PLANES_EDITABLES, 's1']))
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'PLAN_OFFER_SWITCH_ON', staffId: 's1' }) }),
    )
  })

  it('apagar toma plan-offer-publish, pone desde en NULL, deja bitácora y no toca versiones ni puntero', async () => {
    await apagarPlanesEditables('s1')
    const llamadas = exec().mock.calls
    expect(textoDe(llamadas[0])).toContain('pg_advisory_xact_lock')
    expect(llamadas[0].slice(1)).toEqual(['plan-offer-publish'])
    expect(textoDe(llamadas[1])).toContain('"desde" = NULL')
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'PLAN_OFFER_SWITCH_OFF' }) }),
    )
    expect(prismaMock.planOfferVersion.create).not.toHaveBeenCalled()
    expect(prismaMock.planOfferPointer.upsert).not.toHaveBeenCalled()
    expect(prismaMock.planOfferPointer.update).not.toHaveBeenCalled()
  })

  it('estadoDelInterruptor junta fila y faltantes', async () => {
    fila().findUnique.mockResolvedValue({ desde: null, actualizadoPor: 's9' } as any)
    await expect(estadoDelInterruptor()).resolves.toMatchObject({ prendido: false, desde: null, actualizadoPor: 's9' })
  })
})
