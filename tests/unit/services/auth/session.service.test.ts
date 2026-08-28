import { createSession, revokeSession, revokeAllSessionsForStaff, isSessionAlive } from '@/services/auth/session.service'
// Ruling 2 (task-3-brief.md): revokeSessionsForDevice NO va en esta tarea — sin consumidor en el Plan A.
import prisma from '@/utils/prismaClient'
import { AuthMethod } from '@prisma/client'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { session: { create: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() } },
}))

describe('session.service', () => {
  beforeEach(() => jest.clearAllMocks())

  it('crea la sesión con su método de autenticación', async () => {
    ;(prisma.session.create as jest.Mock).mockResolvedValue({ id: 's1' })
    await createSession({ staffId: 'st1', venueId: 'v1', authMethod: AuthMethod.PASSWORD })
    expect(prisma.session.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ staffId: 'st1', venueId: 'v1', authMethod: 'PASSWORD' }) }),
    )
  })

  it('revocar es idempotente: sólo toca sesiones vivas', async () => {
    ;(prisma.session.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
    await expect(revokeSession('s1', 'logout')).resolves.toBeUndefined()
    expect(prisma.session.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 's1', revokedAt: null } }))
  })

  it('revocar todas las de una persona devuelve cuántas cerró', async () => {
    ;(prisma.session.updateMany as jest.Mock).mockResolvedValue({ count: 3 })
    await expect(revokeAllSessionsForStaff('st1', 'password_changed')).resolves.toBe(3)
  })

  it('una sesión revocada NO está viva', async () => {
    ;(prisma.session.findUnique as jest.Mock).mockResolvedValue({ id: 's1', revokedAt: new Date() })
    await expect(isSessionAlive('s1')).resolves.toBe(false)
  })

  it('una sesión inexistente NO está viva', async () => {
    ;(prisma.session.findUnique as jest.Mock).mockResolvedValue(null)
    await expect(isSessionAlive('nope')).resolves.toBe(false)
  })
})
