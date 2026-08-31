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

beforeEach(() => {
  jest.clearAllMocks()
  // 🔴 [Auditoría Task 9, hallazgo importante] La reutilización real ahora revoca la familia Y
  // la Session en UNA transacción (ver refreshGrant.service.ts). El mock ejecuta el callback
  // pasándole el MISMO `prisma` simulado — así los asserts contra `prisma.refreshGrant.updateMany`
  // siguen viendo la llamada, igual que en `refreshGrant.service.test.ts`.
  ;(prisma.$transaction as jest.Mock).mockImplementation((fn: any) => fn(prisma))
})

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
  it('pasada la ventana, revoca la familia Y la Session en UNA transaccion, e invalida la cache', async () => {
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
    expect(sessionService.revokeSession).toHaveBeenCalledWith('s1', expect.stringContaining('reuse'), expect.anything())
    expect(sessionCache.invalidateSession).toHaveBeenCalledWith('s1')

    // 🔴 [Auditoría, hallazgo importante] revocarFamilia + revokeSession comparten UNA sola
    // transacción — sin esto, si el proceso muere entre las dos, la familia queda revocada
    // pero la Session sigue viva con su access token hasta 10 minutos. invalidateSession
    // (Redis, best-effort) NUNCA debe formar parte de esa transacción de la base de datos.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
  })
})

describe('NO es retransmision aunque el grant tenga un successorEnc con pinta de vigente', () => {
  it('🔴 [Auditoría, hallazgo importante] si la familia YA fue revocada por un HERMANO, un reintento dentro de su propia ventana se trata como reutilizacion', async () => {
    // revocarFamilia revoca TODOS los grants vivos de la familia de un jalon: este grant no
    // fue el que disparo la reutilizacion, pero su familia SI murio.
    const cifrado = cifrarSucesor('tok-sucesor', AAD)
    ;(prisma.refreshGrant.findUnique as jest.Mock).mockResolvedValue({
      id: 'g1',
      sessionId: 's1',
      familyId: 'f1',
      consumedAt: new Date(Date.now() - 10_000), // dentro de SU propia ventana de 60s
      successorEnc: cifrado,
      successorEncExpiresAt: new Date(Date.now() + 50_000), // sin vencer
      revokedAt: new Date(Date.now() - 5_000), // pero la FAMILIA ya fue revocada por otro grant
      expiresAt: new Date(Date.now() + 86_400_000),
    })

    const r = await rotateGrant('tok-viejo', 'tok-NUEVO-distinto', new Date())

    expect(r).toEqual({ reutilizado: true })
    expect(prisma.refreshGrant.create).not.toHaveBeenCalled() // nunca acuna sucesor sobre una familia muerta
    expect(sessionService.revokeSession).toHaveBeenCalledWith('s1', expect.stringContaining('reuse'), expect.anything())
  })

  it('🔴 [Auditoría, hallazgo de cobertura] successorEnc PRESENTE pero VENCIDO se trata como reutilizacion, no como retransmision', async () => {
    // El caso realista que la suite anterior no cubria: un reintento a los 65s, ANTES de que
    // el job horario (:00, limpiarSucesoresVencidos) purgue el ciphertext. Si alguien
    // simplificara la condicion de rotateGrant() a solo `previo.successorEnc` (ignorando
    // successorEncExpiresAt), este test falla: devolveria { retransmision: true, sucesor:
    // 'tok-sucesor' } en vez de { reutilizado: true } — exactamente el bug que esta tarea
    // existe para prevenir.
    const cifrado = cifrarSucesor('tok-sucesor', AAD)
    ;(prisma.refreshGrant.findUnique as jest.Mock).mockResolvedValue({
      id: 'g1',
      sessionId: 's1',
      familyId: 'f1',
      consumedAt: new Date(Date.now() - 65_000), // consumido hace 65s
      successorEnc: cifrado, // el job de limpieza (:00) todavia no lo borro
      successorEncExpiresAt: new Date(Date.now() - 5_000), // vencio hace 5s
      revokedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    })

    const r = await rotateGrant('tok-viejo', 'tok-NUEVO-distinto', new Date())

    expect(r).toEqual({ reutilizado: true })
    expect(prisma.refreshGrant.create).not.toHaveBeenCalled()
    expect(sessionService.revokeSession).toHaveBeenCalledWith('s1', expect.stringContaining('reuse'), expect.anything())
  })

  it('🔴 [Auditoría, hallazgo menor] si el descifrado falla (llave rotada, ciphertext corrupto), cae a reutilizacion en vez de reventar', async () => {
    ;(prisma.refreshGrant.findUnique as jest.Mock).mockResolvedValue({
      id: 'g1',
      sessionId: 's1',
      familyId: 'f1',
      consumedAt: new Date(Date.now() - 10_000),
      successorEnc: 'v1.formato-invalido', // descifrarSucesor lanza: no tiene las 4 partes esperadas
      successorEncExpiresAt: new Date(Date.now() + 50_000),
      revokedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    })

    await expect(rotateGrant('tok-viejo', 'tok-nuevo', new Date())).resolves.toEqual({ reutilizado: true })
    expect(sessionService.revokeSession).toHaveBeenCalledWith('s1', expect.stringContaining('reuse'), expect.anything())
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
