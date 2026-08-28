/**
 * Parte A (sesiones revocables) — Task 6.
 *
 * Hasta esta tarea, las sesiones VIVEN en la base y el middleware SABE comprobarlas
 * (Tasks 3 y 5), pero nadie las crea: el login móvil seguía emitiendo tokens sin `sid`,
 * así que "cerrar sesión desde otro lado" no tenía nada que revocar.
 *
 * Este archivo prueba que los DOS caminos de login móvil —contraseña y passkey— crean
 * su `Session` (con el `authMethod` correcto) ANTES de generar los tokens, y que el `id`
 * de esa sesión viaja como `sid` en AMBOS tokens.
 *
 * 🔴 El caso que más importa probar explícitamente: `generateAccessToken` recibe `opts`
 * como 6º argumento (el 5º es `rememberMe`) y `generateRefreshToken` como 5º. Pasar `opts`
 * en el lugar de `rememberMe` rompería "recordarme" en silencio — ningún tipo lo cacha
 * porque `rememberMe` y `opts` son ambos opcionales.
 */
import * as sessionService from '@/services/auth/session.service'
import * as jwtService from '../../../../src/jwt.service'
import prisma from '../../../../src/utils/prismaClient'
import bcrypt from 'bcryptjs'
import { verifyAuthenticationResponse, generateAuthenticationOptions } from '@simplewebauthn/server'
import type { AuthenticationResponseJSON } from '@simplewebauthn/server'
import { loginWithEmail, verifyPasskeyAssertion, generatePasskeyChallenge } from '../../../../src/services/mobile/auth.mobile.service'

jest.mock('@/services/auth/session.service')

// El módulo real haría una petición WebAuthn de verdad. Sólo nos importa que
// `verifyPasskeyAssertion` reciba una aserción "válida" — la criptografía de WebAuthn
// ya tiene su propia librería que la prueba; aquí no se re-prueba.
jest.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: jest.fn(),
  generateRegistrationOptions: jest.fn(),
  verifyAuthenticationResponse: jest.fn(),
  verifyRegistrationResponse: jest.fn(),
}))

const prismaMock = prisma as any
const createSessionMock = sessionService.createSession as jest.Mock

const VENUE_ID = 'venue_amaena'

const VENUE = {
  id: VENUE_ID,
  name: 'Amaena',
  slug: 'amaena',
  logo: null,
  type: 'SALON',
  status: 'ACTIVE',
  kycStatus: 'APPROVED',
  organizationId: 'org_1',
  timezone: 'America/Mexico_City',
}

function staffVenue(overrides: Record<string, unknown> = {}) {
  return {
    venueId: VENUE_ID,
    role: 'WAITER',
    permissionSetId: null,
    permissionSet: null,
    venue: VENUE,
    ...overrides,
  }
}

function staffFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'staff_heidi',
    email: 'heidi@amaena.com',
    emailVerified: true,
    firstName: 'Heidi',
    lastName: 'Salmeron',
    password: 'hash',
    active: true,
    photoUrl: null,
    phone: null,
    lockedUntil: null,
    failedLoginAttempts: 0,
    createdAt: new Date(),
    lastLoginAt: null,
    venues: [staffVenue()],
    ...overrides,
  }
}

beforeEach(() => {
  jest.spyOn(bcrypt, 'compare').mockImplementation(() => Promise.resolve(true) as any)
  jest.spyOn(jwtService, 'generateAccessToken').mockReturnValue('access-token')
  jest.spyOn(jwtService, 'generateRefreshToken').mockReturnValue('refresh-token')
  prismaMock.staff.update.mockResolvedValue({})
  prismaMock.venueRolePermission.findMany.mockResolvedValue([])
  prismaMock.venueRoleConfig.findMany.mockResolvedValue([])
  createSessionMock.mockResolvedValue({ id: 'sess-nueva' })
})

describe('login por contraseña — crea Session y emite sid', () => {
  it('crea una Session PASSWORD y mete su id como sid del token', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(staffFixture())

    const r = await loginWithEmail('heidi@amaena.com', 'la-contraseña')

    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: 'staff_heidi', venueId: VENUE_ID, authMethod: 'PASSWORD' }),
    )
    expect(r.accessToken).toBeDefined()
  })

  it('crea la sesión DESPUÉS de resolver el venue operativo, no la primera de la lista', async () => {
    // Dos venues: uno suspendido primero, uno operativo después. Si la sesión se creara
    // ANTES de que pickOperationalVenueForLogin filtre, se abriría sobre el venue equivocado.
    prismaMock.staff.findUnique.mockResolvedValue(
      staffFixture({
        venues: [
          staffVenue({ venueId: 'suspendido', venue: { ...VENUE, id: 'suspendido', status: 'SUSPENDED' } }),
          staffVenue({ venueId: 'operativo', venue: { ...VENUE, id: 'operativo', status: 'ACTIVE' } }),
        ],
      }),
    )

    await loginWithEmail('heidi@amaena.com', 'la-contraseña')

    expect(sessionService.createSession).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'operativo' }))
  })

  it('pasa el MISMO sid a access y refresh token, sin desplazar rememberMe de su lugar', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(staffFixture())
    createSessionMock.mockResolvedValue({ id: 'sess-remember-me' })

    await loginWithEmail('heidi@amaena.com', 'la-contraseña', true)

    // rememberMe (5º arg de access, 3º de refresh) sigue en `true`; `opts` va DESPUÉS, no en su lugar.
    expect(jwtService.generateAccessToken).toHaveBeenCalledWith('staff_heidi', 'org_1', VENUE_ID, 'WAITER', true, {
      sid: 'sess-remember-me',
    })
    expect(jwtService.generateRefreshToken).toHaveBeenCalledWith('staff_heidi', 'org_1', true, VENUE_ID, { sid: 'sess-remember-me' })
  })
})

describe('login por passkey — crea Session BIOMETRIC y emite sid', () => {
  const CREDENTIAL = {
    id: 'cred-1',
    rawId: 'cred-1',
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: 'clientData',
      authenticatorData: 'authData',
      signature: 'sig',
    },
  } as unknown as AuthenticationResponseJSON

  beforeEach(() => {
    ;(generateAuthenticationOptions as jest.Mock).mockResolvedValue({
      challenge: 'challenge-abc',
      timeout: 300000,
      userVerification: 'preferred',
    })
    ;(verifyAuthenticationResponse as jest.Mock).mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 1 },
    })
    prismaMock.staffPasskey.update.mockResolvedValue({})
  })

  async function conUnaAsercionValida(staff: ReturnType<typeof staffFixture>) {
    prismaMock.staffPasskey.findUnique.mockResolvedValue({
      id: 'pk_1',
      credentialId: 'cred-1',
      publicKey: Buffer.from('llave-publica-de-prueba').toString('base64'),
      counter: 0,
      deviceType: 'platform',
      staff,
    })
    // El challenge vive en un Map privado del módulo — sembrarlo es la única forma de
    // llegar a verifyPasskeyAssertion sin repetir la criptografía real de WebAuthn.
    const { challengeKey } = await generatePasskeyChallenge()
    return verifyPasskeyAssertion(CREDENTIAL, challengeKey)
  }

  it('crea una Session BIOMETRIC y mete su id como sid del token', async () => {
    const r = await conUnaAsercionValida(staffFixture())

    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: 'staff_heidi', venueId: VENUE_ID, authMethod: 'BIOMETRIC' }),
    )
    expect(r.accessToken).toBeDefined()
  })

  it('pasa el sid de la sesión a access y refresh token', async () => {
    createSessionMock.mockResolvedValue({ id: 'sess-passkey' })

    await conUnaAsercionValida(staffFixture())

    expect(jwtService.generateAccessToken).toHaveBeenCalledWith('staff_heidi', 'org_1', VENUE_ID, 'WAITER', undefined, {
      sid: 'sess-passkey',
    })
    expect(jwtService.generateRefreshToken).toHaveBeenCalledWith('staff_heidi', 'org_1', undefined, VENUE_ID, { sid: 'sess-passkey' })
  })
})
