/**
 * La `Session` tiene que saber en QUÉ APARATO nació.
 *
 * `Session.deviceId` existe en el modelo desde la Parte A, con su índice `[deviceId, revokedAt]`
 * — y NADIE lo llenaba: medido el 2026-08-29, 0 de 11 sesiones lo tenían. Es el patrón que ya
 * documenta la memoria del repo de Android: una llave que existe en el schema, que los tests
 * confirman con payloads que el servidor no puede emitir, y que en producción va siempre vacía.
 *
 * 🔑 Sin este dato, «sacar esta tablet» desde el dashboard no tiene de dónde agarrarse: se puede
 * cerrar la sesión de una PERSONA, pero no la de un APARATO. Y el aparato es justo lo que se
 * pierde o se roba.
 *
 * El dato ya viajaba: cada petición autenticada del POS manda `X-Device-Id`, que el registro de
 * aparatos usa desde julio. Lo único que faltaba era guardarlo también aquí.
 */
import { AuthMethod } from '@prisma/client'

jest.mock('../../../../src/utils/prismaClient')

import prisma from '../../../../src/utils/prismaClient'
import { createSession } from '@/services/auth/session.service'

const mockPrisma = prisma as any

describe('Session.deviceId', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPrisma.session = { create: jest.fn().mockResolvedValue({ id: 'sess_1' }) }
  })

  it('🔑 el aparato se guarda cuando se conoce — es lo que permite sacar UNA tablet', async () => {
    await createSession({ staffId: 's1', venueId: 'v1', authMethod: AuthMethod.PASSWORD, deviceId: 'tablet-caja' })

    expect(mockPrisma.session.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deviceId: 'tablet-caja' }) }),
    )
  })

  it('🔴 sin aparato conocido se guarda null, NUNCA una cadena vacía', async () => {
    // Una cadena vacía haría que `revocar por deviceId=''` alcanzara a todas las sesiones sin
    // aparato del venue — es decir, sacaría a gente de aparatos que nadie tocó.
    await createSession({ staffId: 's1', venueId: 'v1', authMethod: AuthMethod.PASSWORD })

    expect(mockPrisma.session.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ deviceId: null }) }))
  })

  it('🔴 una cadena vacía explícita también se normaliza a null', async () => {
    await createSession({ staffId: 's1', venueId: 'v1', authMethod: AuthMethod.PASSWORD, deviceId: '' })

    expect(mockPrisma.session.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ deviceId: null }) }))
  })
})
