/**
 * Alta con código, Tarea 5: canjear el boleto de 5 min por la sesión.
 */
const mockUpdateMany = jest.fn()
const mockFindFirst = jest.fn()
const mockLogAction = jest.fn().mockResolvedValue(undefined)
const mockMotivoDeConcesion = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { staff: { findFirst: mockFindFirst, updateMany: mockUpdateMany, findUnique: jest.fn(), update: jest.fn() } },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: (...a: unknown[]) => mockLogAction(...a) }))
jest.mock('@/services/staffOrganization.service', () => ({ getPrimaryOrganizationId: jest.fn().mockResolvedValue('org-1') }))
jest.mock('@/services/launchCampaigns/launchCampaignClaim.service', () => ({ claimLaunchCampaign: jest.fn() }))
jest.mock('@/services/launchCampaigns/launchCampaign.service', () => ({ findClaimableByCodeOrSlug: jest.fn() }))
jest.mock('@/services/onboarding/nuevoNegocio', () => ({ crearNegocioNuevo: jest.fn(), resolverAtribucionDelAlta: jest.fn() }))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: {} }))
jest.mock('@/utils/passwordChangeGuard', () => ({
  motivoDeConcesionInvalidada: (...a: unknown[]) => mockMotivoDeConcesion(...a),
}))
jest.mock('@/jwt.service', () => ({
  generateAccessToken: jest.fn().mockReturnValue('access-tok'),
  generateRefreshToken: jest.fn().mockReturnValue('refresh-tok'),
}))

import * as jwtService from '@/jwt.service'
import { GoneError } from '@/errors/AppError'
import { firmarBoletoDeAlta, huellaDeContrasena } from '@/services/onboarding/boletoDeAlta'
import prisma from '@/utils/prismaClient'
import { canjearBoletoDeAlta, tokensDeDuenoSinSucursal } from '@/services/onboarding/signup.service'

async function codigoDelError(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(GoneError)
    expect((e as GoneError).statusCode).toBe(410)
    return (e as GoneError).code
  }
  throw new Error('no lanzó')
}

beforeAll(() => {
  process.env.ACCESS_TOKEN_SECRET = 'secreto-de-prueba-del-boleto'
})
beforeEach(() => {
  jest.clearAllMocks()
  mockFindFirst.mockResolvedValue({ id: 'staff-1' }) // esProspectoDeLanding
  mockMotivoDeConcesion.mockResolvedValue(null)
  mockUpdateMany.mockResolvedValue({ count: 1 })
})

describe('tokensDeDuenoSinSucursal', () => {
  it('emite los tokens de OWNER sin sucursal («pending») con la organización primaria', async () => {
    await expect(tokensDeDuenoSinSucursal('staff-1')).resolves.toEqual({ accessToken: 'access-tok', refreshToken: 'refresh-tok' })
    expect(jwtService.generateAccessToken).toHaveBeenCalledWith('staff-1', 'org-1', 'pending', 'OWNER')
    expect(jwtService.generateRefreshToken).toHaveBeenCalledWith('staff-1', 'org-1')
  })
})

describe('canjearBoletoDeAlta', () => {
  it('boleto válido: exige prospecto con contraseña, una escritura condicionada, bitácora y tokens', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-24T12:00:00.000Z'))
    const boleto = firmarBoletoDeAlta('staff-1', 'ana@example.com')
    jest.setSystemTime(new Date('2026-10-24T12:01:00.000Z'))
    const emitido = new Date('2026-10-24T12:00:00.000Z')
    await expect(canjearBoletoDeAlta(boleto)).resolves.toEqual({ accessToken: 'access-tok', refreshToken: 'refresh-tok' })

    // esProspectoDeLanding SIN la condición de password null
    expect(mockFindFirst.mock.calls[0][0].where).not.toHaveProperty('password')
    expect(mockMotivoDeConcesion).toHaveBeenCalledWith('staff-1', expect.any(Date))

    expect(mockUpdateMany).toHaveBeenCalledTimes(1)
    const arg = mockUpdateMany.mock.calls[0][0]
    expect(arg.where).toMatchObject({
      id: 'staff-1',
      email: 'ana@example.com',
      active: true,
      emailVerified: true,
      password: { not: null },
    })
    expect(arg.where.AND).toEqual([
      { OR: [{ lastLoginAt: null }, { lastLoginAt: { lt: emitido } }] },
      { OR: [{ lastPasswordReset: null }, { lastPasswordReset: { lt: emitido } }] },
      { OR: [{ sessionsRevokedAt: null }, { sessionsRevokedAt: { lt: emitido } }] },
    ])
    expect(arg.data.lastLoginAt).toEqual(new Date('2026-10-24T12:01:00.000Z'))
    jest.useRealTimers()
    expect(mockLogAction).toHaveBeenCalledWith(expect.objectContaining({ staffId: 'staff-1', action: 'LANDING_DIRECT_ENTRY' }))
  })

  it('segundo canje (0 filas): BOLETO_USADO, sin bitácora ni tokens', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 })
    expect(await codigoDelError(canjearBoletoDeAlta(firmarBoletoDeAlta('staff-1', 'ana@example.com')))).toBe('BOLETO_USADO')
    expect(mockLogAction).not.toHaveBeenCalled()
    expect(jwtService.generateAccessToken).not.toHaveBeenCalled()
  })

  it('un restablecimiento que cae DESPUÉS de la escritura y ANTES de firmar: BOLETO_USADO y no se devuelven tokens', async () => {
    mockMotivoDeConcesion.mockResolvedValueOnce(null).mockResolvedValueOnce('PASSWORD_CHANGED')
    expect(await codigoDelError(canjearBoletoDeAlta(firmarBoletoDeAlta('staff-1', 'ana@example.com')))).toBe('BOLETO_USADO')
    expect(mockMotivoDeConcesion).toHaveBeenCalledTimes(2)
  })

  it('cuenta desactivada / ya no es prospecto: BOLETO_USADO sin escribir', async () => {
    mockFindFirst.mockResolvedValue(null)
    expect(await codigoDelError(canjearBoletoDeAlta(firmarBoletoDeAlta('staff-1', 'ana@example.com')))).toBe('BOLETO_USADO')
    expect(mockUpdateMany).not.toHaveBeenCalled()
  })

  it('contraseña restablecida o «cerrar todas mis sesiones» después del boleto: BOLETO_USADO sin escribir', async () => {
    mockMotivoDeConcesion.mockResolvedValue('PASSWORD_CHANGED')
    expect(await codigoDelError(canjearBoletoDeAlta(firmarBoletoDeAlta('staff-1', 'ana@example.com')))).toBe('BOLETO_USADO')
    expect(mockUpdateMany).not.toHaveBeenCalled()
  })

  it('boleto alterado o basura: BOLETO_USADO sin tocar la base', async () => {
    expect(await codigoDelError(canjearBoletoDeAlta('esto.no.es.un.boleto'))).toBe('BOLETO_USADO')
    expect(mockFindFirst).not.toHaveBeenCalled()
  })

  it('boleto vencido: BOLETO_USADO', async () => {
    jest.useFakeTimers().setSystemTime(Date.now())
    const boleto = firmarBoletoDeAlta('staff-1', 'ana@example.com')
    jest.setSystemTime(Date.now() + 6 * 60 * 1000)
    try {
      expect(await codigoDelError(canjearBoletoDeAlta(boleto))).toBe('BOLETO_USADO')
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('🔴 Codex r3/r4 (D10): el boleto de «Crear contraseña y entrar» sólo vale con la cuenta EXACTAMENTE como la dejó ese cambio', () => {
  const CAMBIO = new Date('2026-10-28T16:00:00.000Z').getTime()
  const HASH = '$2b$10$hashDeLaRecuperacion'
  const autorizacion = { cambioMs: CAMBIO, huella: huellaDeContrasena(HASH) }

  beforeEach(() => {
    ;(prisma.staff.findUnique as jest.Mock).mockReset().mockResolvedValue({ password: HASH })
  })

  it('el canje exige ESE cambio, ESA contraseña y ninguna revocación en ese momento o después', async () => {
    const boleto = firmarBoletoDeAlta('staff-1', 'dueno@tacos.mx', autorizacion)

    await expect(canjearBoletoDeAlta(boleto)).resolves.toEqual({ accessToken: 'access-tok', refreshToken: 'refresh-tok' })

    const where = mockUpdateMany.mock.calls[0][0].where
    expect(where.AND).toEqual(
      expect.arrayContaining([
        { lastPasswordReset: new Date(CAMBIO) },
        { password: HASH },
        // 🔴 Estricto: una revocación en el MISMO milisegundo también lo invalida (Codex r4).
        { OR: [{ sessionsRevokedAt: null }, { sessionsRevokedAt: { lt: new Date(CAMBIO) } }] },
      ]),
    )
  })

  it('🔴 otra contraseña (aunque la hora del cambio coincida al milisegundo) → BOLETO_USADO', async () => {
    const boleto = firmarBoletoDeAlta('staff-1', 'dueno@tacos.mx', autorizacion)
    ;(prisma.staff.findUnique as jest.Mock).mockResolvedValue({ password: '$2b$10$otraContrasenaDeSoporte' })

    expect(await codigoDelError(canjearBoletoDeAlta(boleto))).toBe('BOLETO_USADO')
    expect(mockUpdateMany).not.toHaveBeenCalled()
  })

  it('🔴 un cambio guardado DESPUÉS de firmar lo invalida en la revisión final', async () => {
    const boleto = firmarBoletoDeAlta('staff-1', 'dueno@tacos.mx', autorizacion)
    // 1.ª lectura: es prospecto; 2.ª (revisión final, ya con los tokens firmados): la cuenta ya no está como la dejó el cambio.
    mockFindFirst.mockResolvedValueOnce({ id: 'staff-1' }).mockResolvedValueOnce(null)

    expect(await codigoDelError(canjearBoletoDeAlta(boleto))).toBe('BOLETO_USADO')
  })

  it('el boleto del alta con código (sin cambio de contraseña) sigue como antes', async () => {
    const boleto = firmarBoletoDeAlta('staff-1', 'dueno@tacos.mx')
    await canjearBoletoDeAlta(boleto)
    const where = mockUpdateMany.mock.calls[0][0].where
    expect(JSON.stringify(where)).not.toContain('"password":"')
    expect(prisma.staff.findUnique).not.toHaveBeenCalled()
    expect(mockFindFirst).toHaveBeenCalledTimes(1)
  })

  it('la huella no es la contraseña ni el hash', () => {
    expect(huellaDeContrasena(HASH)).not.toContain(HASH)
    expect(huellaDeContrasena(HASH)).toMatch(/^[0-9a-f]{64}$/)
  })
})
