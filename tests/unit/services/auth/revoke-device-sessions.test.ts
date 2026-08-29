/**
 * «Sacar esta tablet»: cerrar las sesiones abiertas en UN aparato.
 *
 * El caso real: una tablet se pierde o se la lleva alguien que ya no trabaja ahí. Hoy el dueño
 * puede cerrar la sesión de una PERSONA («cerrar sesión en todos mis dispositivos») pero no la de
 * un APARATO — y el aparato es justo lo que se pierde. Peor: cerrar por persona echa a esa persona
 * de su propio teléfono, que no tiene nada que ver.
 */
jest.mock('../../../../src/utils/prismaClient')
jest.mock('@/services/auth/sessionCache')

import prisma from '../../../../src/utils/prismaClient'
import { invalidateSession } from '@/services/auth/sessionCache'
import { revokeSessionsForDevice } from '@/services/auth/session.service'

const mockPrisma = prisma as any

describe('revokeSessionsForDevice', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPrisma.session = {
      findMany: jest.fn().mockResolvedValue([{ id: 'sess_a' }, { id: 'sess_b' }]),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
    }
  })

  it('cierra sólo las sesiones VIVAS de ESE aparato en ESE negocio', async () => {
    await revokeSessionsForDevice({ venueId: 'v1', deviceId: 'tablet-caja', reason: 'device_removed' })

    expect(mockPrisma.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ venueId: 'v1', deviceId: 'tablet-caja', revokedAt: null }),
      }),
    )
  })

  it('🔴 INVALIDA la caché de cada sesión — si no, siguen sirviendo hasta 60 s', async () => {
    // Mismo defecto que se midió en vivo con el cambio de usuario: revocar escribe en la base,
    // pero el middleware pregunta a una caché de 60 s. Sacar una tablet robada y que siga
    // cobrando un minuto es exactamente lo que no puede pasar.
    await revokeSessionsForDevice({ venueId: 'v1', deviceId: 'tablet-caja', reason: 'device_removed' })

    expect(invalidateSession).toHaveBeenCalledWith('sess_a')
    expect(invalidateSession).toHaveBeenCalledWith('sess_b')
  })

  it('🔴 un aparato sin id NO revoca nada — nunca alcanza a las sesiones sin aparato', async () => {
    const n = await revokeSessionsForDevice({ venueId: 'v1', deviceId: '', reason: 'device_removed' })

    expect(n).toBe(0)
    expect(mockPrisma.session.updateMany).not.toHaveBeenCalled()
  })

  it('devuelve cuántas cerró, para poder decírselo al dueño', async () => {
    const n = await revokeSessionsForDevice({ venueId: 'v1', deviceId: 'tablet-caja', reason: 'device_removed' })

    expect(n).toBe(2)
  })

  it('un aparato sin sesiones abiertas no es un error: cierra cero', async () => {
    mockPrisma.session.findMany.mockResolvedValue([])
    mockPrisma.session.updateMany.mockResolvedValue({ count: 0 })

    const n = await revokeSessionsForDevice({ venueId: 'v1', deviceId: 'tablet-fria', reason: 'device_removed' })

    expect(n).toBe(0)
    expect(invalidateSession).not.toHaveBeenCalled()
  })
})
