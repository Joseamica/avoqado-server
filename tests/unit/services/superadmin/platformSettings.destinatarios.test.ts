/**
 * Planes editables B1, Task 9: los destinatarios de los avisos internos del alta viven en `PlatformSettings`
 * (`avisosDelAltaCorreos`), nunca en el código. Se escriben con su propia función (`setDestinatariosDelAlta`), que los normaliza
 * (recortados, en minúsculas, sin repetidos, hasta 10, correo válido) y deja bitácora con el antes y el después.
 * `updatePlatformSettings` (la API vieja) no los toca.
 */
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

import { logAction } from '@/services/dashboard/activity-log.service'
import { getDestinatariosDelAlta, setDestinatariosDelAlta, updatePlatformSettings } from '@/services/superadmin/platformSettings.service'
import { prismaMock } from '@tests/__helpers__/setup'

const FILA = {
  id: 'default',
  ecommercePlatformFeeBpsDefault: 100,
  vatRateBps: 1600,
  updatedAt: new Date('2026-11-25T12:00:00Z'),
  updatedById: null,
}

beforeEach(() => {
  jest.mocked(logAction).mockClear()
  prismaMock.platformSettings.findUnique.mockReset()
  prismaMock.platformSettings.upsert.mockReset()
  prismaMock.platformSettings.create.mockReset()
})

describe('getDestinatariosDelAlta', () => {
  it('sin renglón de PlatformSettings devuelve [] y no crea nada', async () => {
    prismaMock.platformSettings.findUnique.mockResolvedValue(null)
    await expect(getDestinatariosDelAlta()).resolves.toEqual([])
    expect(prismaMock.platformSettings.create).not.toHaveBeenCalled()
    expect(prismaMock.platformSettings.upsert).not.toHaveBeenCalled()
  })

  it('con renglón devuelve la columna tal cual', async () => {
    prismaMock.platformSettings.findUnique.mockResolvedValue({ avisosDelAltaCorreos: ['ops@example.com'] })
    await expect(getDestinatariosDelAlta()).resolves.toEqual(['ops@example.com'])
    expect(prismaMock.platformSettings.findUnique).toHaveBeenCalledWith({
      where: { id: 'default' },
      select: { avisosDelAltaCorreos: true },
    })
  })
})

describe('setDestinatariosDelAlta', () => {
  it('guarda la lista, deja bitácora con antes y después y getDestinatariosDelAlta la devuelve; sin renglón, []', async () => {
    // Sin renglón: el «antes» es [].
    prismaMock.platformSettings.findUnique.mockResolvedValueOnce(null)
    prismaMock.platformSettings.upsert.mockResolvedValue({ ...FILA, avisosDelAltaCorreos: ['ventas@example.com', 'ops@example.com'] })

    const guardados = await setDestinatariosDelAlta(['  Ventas@Example.COM ', 'ops@example.com', 'ventas@example.com'], 'staff_super')

    expect(guardados).toEqual(['ventas@example.com', 'ops@example.com'])
    expect(prismaMock.platformSettings.upsert).toHaveBeenCalledWith({
      where: { id: 'default' },
      create: { id: 'default', avisosDelAltaCorreos: ['ventas@example.com', 'ops@example.com'], updatedById: 'staff_super' },
      update: { avisosDelAltaCorreos: ['ventas@example.com', 'ops@example.com'], updatedById: 'staff_super' },
    })
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith({
      staffId: 'staff_super',
      action: 'PLATFORM_SETTINGS_UPDATED',
      entity: 'PlatformSettings',
      entityId: 'default',
      data: { avisosDelAltaCorreos: { from: [], to: ['ventas@example.com', 'ops@example.com'] } },
    })

    // Lo que quedó guardado es lo que se lee.
    prismaMock.platformSettings.findUnique.mockResolvedValueOnce({ avisosDelAltaCorreos: guardados })
    await expect(getDestinatariosDelAlta()).resolves.toEqual(['ventas@example.com', 'ops@example.com'])
  })

  it('reemplaza la lista anterior: la bitácora trae el antes real', async () => {
    prismaMock.platformSettings.findUnique.mockResolvedValueOnce({ avisosDelAltaCorreos: ['viejo@example.com'] })
    prismaMock.platformSettings.upsert.mockResolvedValue({ ...FILA, avisosDelAltaCorreos: [] })

    await expect(setDestinatariosDelAlta([], 'staff_super')).resolves.toEqual([])

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ data: { avisosDelAltaCorreos: { from: ['viejo@example.com'], to: [] } } }),
    )
  })

  it('la misma lista (ya normalizada) se guarda sin un asiento nuevo en la bitácora', async () => {
    prismaMock.platformSettings.findUnique.mockResolvedValueOnce({ avisosDelAltaCorreos: ['ops@example.com'] })
    prismaMock.platformSettings.upsert.mockResolvedValue({ ...FILA, avisosDelAltaCorreos: ['ops@example.com'] })

    await expect(setDestinatariosDelAlta([' OPS@example.com'], 'staff_super')).resolves.toEqual(['ops@example.com'])
    expect(logAction).not.toHaveBeenCalled()
  })

  it('10 distintos (con repetidos de más) caben; 11 distintos → 400 PLAN_OFFER_INVALID y no se escribe nada', async () => {
    prismaMock.platformSettings.findUnique.mockResolvedValue(null)
    prismaMock.platformSettings.upsert.mockResolvedValue(FILA)
    const diez = Array.from({ length: 10 }, (_, i) => `aviso${i}@example.com`)

    await expect(setDestinatariosDelAlta([...diez, 'AVISO0@example.com'], 'staff_super')).resolves.toHaveLength(10)
    prismaMock.platformSettings.upsert.mockClear()

    await expect(setDestinatariosDelAlta([...diez, 'once@example.com'], 'staff_super')).rejects.toMatchObject({
      statusCode: 400,
      code: 'PLAN_OFFER_INVALID',
      details: { issues: [{ path: 'correos', message: expect.stringContaining('10') }] },
    })
    expect(prismaMock.platformSettings.upsert).not.toHaveBeenCalled()
  })

  it.each([['no-es-correo'], ['   '], ['ana@'], ['ana@example']])(
    'un correo inválido (%p) → 400 PLAN_OFFER_INVALID con su posición, en español, y no se escribe nada',
    async invalido => {
      prismaMock.platformSettings.findUnique.mockResolvedValue(null)

      const error = await setDestinatariosDelAlta(['ops@example.com', invalido], 'staff_super').catch(e => e)

      expect(error).toMatchObject({ statusCode: 400, code: 'PLAN_OFFER_INVALID' })
      expect(error.message).toMatch(/destinatarios/)
      expect(error.details.issues).toEqual([{ path: 'correos.1', message: 'No es un correo válido.' }])
      expect(prismaMock.platformSettings.upsert).not.toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalled()
    },
  )
})

describe('updatePlatformSettings (la API vieja) no cambia', () => {
  it('no escribe avisosDelAltaCorreos aunque se lo manden', async () => {
    prismaMock.platformSettings.findUnique.mockResolvedValue({ ...FILA, avisosDelAltaCorreos: ['ops@example.com'] })
    prismaMock.platformSettings.upsert.mockResolvedValue({ ...FILA, vatRateBps: 800 })

    await updatePlatformSettings({ vatRateBps: 800 }, 'staff_super')

    const llamada = prismaMock.platformSettings.upsert.mock.calls[0][0]
    expect(llamada.update).toEqual({ vatRateBps: 800, updatedById: 'staff_super' })
    expect(llamada.create).toEqual({ id: 'default', vatRateBps: 800, updatedById: 'staff_super' })
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ data: { changes: { vatRateBps: { from: 1600, to: 800 } } } }))
  })
})
