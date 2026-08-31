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
    await expect(revokeSession('s1', 'logout')).resolves.toBe(0)
    expect(prisma.session.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 's1', revokedAt: null } }))
  })

  it('🔴 el número que devuelve es un RECLAMO: 1 = «yo la cerré», 0 = «alguien llegó primero»', async () => {
    // No es una estadística. El `where` lleva `revokedAt: null`, así que el UPDATE es un
    // compare-and-swap y exactamente una petición se lleva la fila. De eso depende que dos
    // relevos simultáneos de un aparato (`switchUserByPin`) no acaben en DOS sesiones válidas
    // nacidas de un solo cambio de manos — que era el P1 #1 de la auditoría del 2026-08-30.
    ;(prisma.session.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    await expect(revokeSession('s1', 'switch_user')).resolves.toBe(1)
    ;(prisma.session.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
    await expect(revokeSession('s1', 'switch_user')).resolves.toBe(0)
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
