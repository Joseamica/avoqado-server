import { rotateGrant } from '@/services/auth/refreshGrant.service'
import { cifrarSucesor, descifrarSucesor } from '@/services/auth/successorCrypto'
import * as sessionService from '@/services/auth/session.service'
import * as sessionCache from '@/services/auth/sessionCache'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    refreshGrant: { findUnique: jest.fn(), updateMany: jest.fn(), create: jest.fn(), deleteMany: jest.fn() },
    session: { updateMany: jest.fn() },
    $transaction: jest.fn(),
  },
}))
jest.mock('@/services/auth/session.service')
jest.mock('@/services/auth/sessionCache')

const AAD = { grantId: 'g1', familyId: 'f1', sessionId: 's1' }

describe('cifrado del sucesor', () => {
  it('el ciphertext NO contiene el token en claro', () => {
    const c = cifrarSucesor('tok-sucesor', AAD)
    expect(c).not.toContain('tok-sucesor')
    expect(descifrarSucesor(c, AAD)).toBe('tok-sucesor')
  })

  it('descifrar con OTRO grantId falla: el AAD ata el ciphertext a su fila', () => {
    const c = cifrarSucesor('tok-sucesor', AAD)
    expect(() => descifrarSucesor(c, { ...AAD, grantId: 'otro' })).toThrow()
  })

  it('un ciphertext manipulado no se descifra en silencio', () => {
    const c = cifrarSucesor('tok-sucesor', AAD)
    const roto = c.slice(0, -4) + 'AAAA'
    expect(() => descifrarSucesor(roto, AAD)).toThrow()
  })
})

describe('retransmision dentro de la ventana', () => {
  it('reintentar con el grant ya consumido devuelve EL MISMO sucesor', async () => {
    const cifrado = cifrarSucesor('tok-sucesor', AAD)
    ;(prisma.refreshGrant.findUnique as jest.Mock).mockResolvedValue({
      id: 'g1',
      sessionId: 's1',
      familyId: 'f1',
      consumedAt: new Date(Date.now() - 10_000), // consumido hace 10 s
      successorEnc: cifrado,
      successorEncExpiresAt: new Date(Date.now() + 50_000),
      revokedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    })

    const r = await rotateGrant('tok-viejo', 'tok-NUEVO-distinto', new Date(Date.now() + 86_400_000))

    expect(r).toEqual({ sucesor: 'tok-sucesor', sessionId: 's1', familyId: 'f1', retransmision: true })
  })

  it('🔴 NUNCA acuña un sucesor distinto al retransmitir', async () => {
    const cifrado = cifrarSucesor('tok-sucesor', AAD)
    ;(prisma.refreshGrant.findUnique as jest.Mock).mockResolvedValue({
      id: 'g1',
      sessionId: 's1',
      familyId: 'f1',
      consumedAt: new Date(Date.now() - 10_000),
      successorEnc: cifrado,
      successorEncExpiresAt: new Date(Date.now() + 50_000),
      revokedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    })

    await rotateGrant('tok-viejo', 'tok-NUEVO-distinto', new Date())

    expect(prisma.refreshGrant.create).not.toHaveBeenCalled()
    expect(sessionService.revokeSession).not.toHaveBeenCalled() // no es robo
  })
})

describe('reutilizacion real', () => {
  it('pasada la ventana, revoca la familia Y la Session, e invalida la cache', async () => {
    ;(prisma.refreshGrant.findUnique as jest.Mock).mockResolvedValue({
      id: 'g1',
      sessionId: 's1',
      familyId: 'f1',
      consumedAt: new Date(Date.now() - 120_000), // 2 min: fuera de ventana
      successorEnc: null,
      successorEncExpiresAt: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    })

    const r = await rotateGrant('tok-viejo', 'tok-nuevo', new Date())

    expect(r).toEqual({ reutilizado: true })
    expect(prisma.refreshGrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ familyId: 'f1' }) }),
    )
    expect(sessionService.revokeSession).toHaveBeenCalledWith('s1', expect.stringContaining('reuse'))
    expect(sessionCache.invalidateSession).toHaveBeenCalledWith('s1')
  })
})

describe('borrado fisico del ciphertext vencido', () => {
  it('limpiarSucesoresVencidos borra el ciphertext, no solo marca la fecha', async () => {
    const { limpiarSucesoresVencidos } = await import('@/services/auth/refreshGrant.service')
    ;(prisma.refreshGrant.updateMany as jest.Mock).mockResolvedValue({ count: 3 })
    await limpiarSucesoresVencidos()
    expect(prisma.refreshGrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ successorEncExpiresAt: expect.objectContaining({ lt: expect.any(Date) }) }),
        data: { successorEnc: null, successorEncExpiresAt: null },
      }),
    )
  })
})
