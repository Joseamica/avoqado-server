/**
 * 🔴 Toma de cuentas (auditoría de seguridad 2026-10-01): al entrar con Google por primera vez se buscaba al Consumer existente
 * POR EL CORREO del token y se le enlazaba la cuenta nueva, aunque Google no garantizara ese correo (`email_verified` falso, o un
 * correo de otro dominio sin `hd`, donde Google no es autoridad sobre quién lo posee hoy). Sólo un correo confiable puede
 * enlazar o quedar como el correo del Consumer. Apple declara verificado el correo que entrega.
 */
const mockVerifyIdToken = jest.fn()
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: (...a: unknown[]) => mockVerifyIdToken(...a) })),
}))
jest.mock('@/jwt.service', () => ({ __esModule: true, generateConsumerToken: jest.fn(() => 'consumer.jwt') }))

import { prismaMock } from '@tests/__helpers__/setup'
import { loginWithOAuth } from '@/services/consumer/auth.consumer.service'

// El mock compartido no trae este modelo; se agrega aquí para no tocar el helper que usan todas las suites.
prismaMock.consumerAuthAccount = { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() }

const VICTIMA = { id: 'consumer-victima', email: 'ana@empresa.com', active: true, firstName: 'Ana', lastName: null, avatarUrl: null }
const NUEVO = {
  id: 'consumer-nuevo',
  email: null,
  phone: null,
  active: true,
  firstName: null,
  lastName: null,
  avatarUrl: null,
  locale: 'es',
}

function tokenGoogle(payload: Record<string, unknown>) {
  mockVerifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: 'google-sub-1', ...payload }) })
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  prismaMock.consumerAuthAccount.findUnique.mockResolvedValue(null)
  prismaMock.consumer.findUnique.mockResolvedValue(VICTIMA as any)
  prismaMock.consumer.create.mockResolvedValue(NUEVO as any)
  prismaMock.consumer.update.mockImplementation(async ({ where }: any) => ({ ...NUEVO, id: where.id }) as any)
  prismaMock.consumerAuthAccount.create.mockResolvedValue({} as any)
})

describe('loginWithOAuth — sólo un correo confiable enlaza una cuenta existente', () => {
  it.each([
    ['correo NO verificado', { email: 'ana@empresa.com', email_verified: false }],
    ['correo verificado de otro dominio sin hd', { email: 'ana@empresa.com', email_verified: true }],
  ])('🔴 Google con %s: NO reutiliza al Consumer de ese correo ni se lo guarda', async (_caso, payload) => {
    tokenGoogle(payload)

    await loginWithOAuth({ provider: 'GOOGLE', idToken: 't' })

    expect(prismaMock.consumer.findUnique).not.toHaveBeenCalledWith({ where: { email: 'ana@empresa.com' } })
    expect(prismaMock.consumer.create).toHaveBeenCalledWith({ data: expect.objectContaining({ email: null }) })
    expect(prismaMock.consumerAuthAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ consumerId: 'consumer-nuevo' }),
    })
  })

  it.each([
    ['@gmail.com verificado', { email: 'ana@gmail.com', email_verified: true }],
    ['de un dominio con hd', { email: 'ana@empresa.com', email_verified: true, hd: 'empresa.com' }],
  ])('Google con correo confiable (%s): sí enlaza al Consumer de ese correo', async (_caso, payload) => {
    tokenGoogle(payload)

    await loginWithOAuth({ provider: 'GOOGLE', idToken: 't' })

    expect(prismaMock.consumer.findUnique).toHaveBeenCalledWith({ where: { email: (payload as { email: string }).email } })
    expect(prismaMock.consumer.create).not.toHaveBeenCalled()
    expect(prismaMock.consumerAuthAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ consumerId: 'consumer-victima' }),
    })
  })

  it('🔴 cuenta ya existente: un correo no confiable no se le pone al Consumer que no tenía', async () => {
    tokenGoogle({ email: 'ana@empresa.com', email_verified: false })
    prismaMock.consumerAuthAccount.findUnique.mockResolvedValue({
      id: 'acc-1',
      consumerId: 'consumer-1',
      email: null,
      consumer: { id: 'consumer-1', email: null, firstName: 'X', lastName: null, active: true },
    } as any)

    await loginWithOAuth({ provider: 'GOOGLE', idToken: 't' })

    const datos = prismaMock.consumer.update.mock.calls.map(([arg]: any[]) => arg.data)
    expect(datos.some((d: any) => 'email' in d)).toBe(false)
  })
})
