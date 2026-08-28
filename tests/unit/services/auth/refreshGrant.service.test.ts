import { hashToken, issueGrant, rotateGrant } from '@/services/auth/refreshGrant.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    refreshGrant: { create: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
    $transaction: jest.fn(),
  },
}))

const tx = { refreshGrant: { create: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() } }
beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(tx))
})

describe('hashToken', () => {
  it('es SHA-256 en hex y NUNCA devuelve el token', () => {
    const h = hashToken('tok-secreto')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(h).not.toContain('tok-secreto')
  })

  it('es determinista: el mismo token da el mismo hash', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'))
  })
})

describe('rotateGrant', () => {
  it('consume el grant y crea el sucesor en UNA sola transaccion', async () => {
    tx.refreshGrant.findUnique.mockResolvedValue({
      id: 'g1', sessionId: 's1', familyId: 'f1', consumedAt: null, revokedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    tx.refreshGrant.updateMany.mockResolvedValue({ count: 1 })
    tx.refreshGrant.create.mockResolvedValue({ id: 'g2' })

    const r = await rotateGrant('tok-viejo', 'tok-nuevo', new Date(Date.now() + 86_400_000))

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ sucesor: 'tok-nuevo', sessionId: 's1', familyId: 'f1' })
    // el sucesor hereda la familia: es lo que permite revocarla entera despues
    expect(tx.refreshGrant.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ familyId: 'f1', sessionId: 's1' }) }),
    )
  })

  it('el consumo es CONDICIONAL: el where exige consumedAt null', async () => {
    tx.refreshGrant.findUnique.mockResolvedValue({
      id: 'g1', sessionId: 's1', familyId: 'f1', consumedAt: null, revokedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    tx.refreshGrant.updateMany.mockResolvedValue({ count: 1 })
    tx.refreshGrant.create.mockResolvedValue({ id: 'g2' })

    await rotateGrant('tok-viejo', 'tok-nuevo', new Date(Date.now() + 86_400_000))

    expect(tx.refreshGrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tokenHash: hashToken('tok-viejo'), consumedAt: null, revokedAt: null }),
      }),
    )
  })

  it('dos refresh concurrentes: solo UNO consume (el segundo ve count 0)', async () => {
    tx.refreshGrant.findUnique.mockResolvedValue({
      id: 'g1', sessionId: 's1', familyId: 'f1', consumedAt: null, revokedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    tx.refreshGrant.updateMany.mockResolvedValue({ count: 0 })   // otro gano la carrera

    const r = await rotateGrant('tok-viejo', 'tok-nuevo', new Date(Date.now() + 86_400_000))

    expect(r).toEqual({ reutilizado: true })
    expect(tx.refreshGrant.create).not.toHaveBeenCalled()   // no se acuna sucesor
  })

  it('un grant ya consumido se reporta como reutilizado', async () => {
    tx.refreshGrant.findUnique.mockResolvedValue({
      id: 'g1', sessionId: 's1', familyId: 'f1', consumedAt: new Date(), revokedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    await expect(rotateGrant('tok-viejo', 'tok-nuevo', new Date())).resolves.toEqual({ reutilizado: true })
  })

  it('un grant que no existe se reporta como reutilizado, no revienta', async () => {
    tx.refreshGrant.findUnique.mockResolvedValue(null)
    await expect(rotateGrant('inventado', 'tok-nuevo', new Date())).resolves.toEqual({ reutilizado: true })
  })

  it('un grant vencido NO rota', async () => {
    tx.refreshGrant.findUnique.mockResolvedValue({
      id: 'g1', sessionId: 's1', familyId: 'f1', consumedAt: null, revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    })
    await expect(rotateGrant('tok-viejo', 'tok-nuevo', new Date())).resolves.toEqual({ reutilizado: true })
    expect(tx.refreshGrant.create).not.toHaveBeenCalled()
  })
})

describe('issueGrant', () => {
  it('guarda el HASH, jamas el token', async () => {
    ;(prisma.refreshGrant.create as jest.Mock).mockResolvedValue({ id: 'g1' })
    await issueGrant('s1', 'f1', 'tok-secreto', new Date())
    const data = (prisma.refreshGrant.create as jest.Mock).mock.calls[0][0].data
    expect(data.tokenHash).toBe(hashToken('tok-secreto'))
    expect(JSON.stringify(data)).not.toContain('tok-secreto')
  })
})
