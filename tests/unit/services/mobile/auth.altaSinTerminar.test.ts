/**
 * Un negocio a medio alta no entra a las apps del POS (D7, 26-oct-2026).
 *
 * El asistente `/setup` del DASHBOARD crea el negocio en el paso «tipo de negocio», ANTES del plan y la tarjeta,
 * con `Venue.status = ONBOARDING`. El DASHBOARD regresa a ese dueño a `/setup`, pero el login de las apps trataba
 * ONBOARDING como operativo: con descargar Avoqado POS se saltaba el plan. Medido en prod: 18 negocios así.
 *
 * 🔴 ONBOARDING solo NO basta para frenar: el SUPERADMIN también da de alta negocios en ONBOARDING mientras revisa su
 * KYC, y ésos sí entran. Lo que distingue el alta sin terminar es su `OnboardingProgress` con `completedAt = null`.
 */
import { VenueStatus } from '@prisma/client'
import prisma from '../../../../src/utils/prismaClient'
import * as jwtService from '../../../../src/jwt.service'
import bcrypt from 'bcryptjs'
import { readFileSync } from 'fs'
import { join } from 'path'
import { loginWithEmail, pickOperationalVenueForLogin, refreshAccessToken } from '../../../../src/services/mobile/auth.mobile.service'
import { _limpiarCacheDeCambiosDeContrasena } from '../../../../src/utils/passwordChangeGuard'

const prismaMock = prisma as any

/** `progreso`: undefined = la org no tiene alta del asistente (SUPERADMIN); null = sin terminar; Date = terminada. */
const venue = (id: string, status: VenueStatus, progreso?: Date | null, wizardVersion = 2) => ({
  venueId: id,
  role: 'OWNER',
  permissionSetId: null,
  permissionSet: null,
  venue: {
    id,
    name: id,
    slug: id,
    logo: null,
    type: 'RESTAURANT',
    status,
    kycStatus: 'NOT_SUBMITTED',
    organizationId: `org_${id}`,
    timezone: 'America/Mexico_City',
    organization: { onboardingProgress: progreso === undefined ? null : { completedAt: progreso, wizardVersion } },
  },
})

const SIN_TERMINAR = /termina de crear tu cuenta en dashboard\.avoqado\.io/i

function staffWith(venues: ReturnType<typeof venue>[]) {
  return {
    id: 'staff_1',
    email: 'dueno@negocio.com',
    emailVerified: true,
    firstName: 'Rigo',
    lastName: '-',
    password: 'hash',
    active: true,
    photoUrl: null,
    phone: null,
    lockedUntil: null,
    failedLoginAttempts: 0,
    createdAt: new Date(),
    lastLoginAt: null,
    venues,
  }
}

beforeEach(() => {
  jest.restoreAllMocks()
  _limpiarCacheDeCambiosDeContrasena()
  prismaMock.staff.findUnique.mockReset()
  jest.spyOn(bcrypt, 'compare').mockImplementation(() => Promise.resolve(true) as any)
  jest.spyOn(jwtService, 'generateAccessToken').mockReturnValue('access')
  jest.spyOn(jwtService, 'generateRefreshToken').mockReturnValue('refresh')
  prismaMock.staff.update.mockResolvedValue({})
  prismaMock.venueRolePermission.findMany.mockResolvedValue([])
  prismaMock.venueRoleConfig.findMany.mockResolvedValue([])
})

describe('pickOperationalVenueForLogin — alta sin terminar', () => {
  it('🔴 frena el único negocio a medio alta y dice qué hacer', () => {
    let error: any
    try {
      pickOperationalVenueForLogin([venue('prendas', 'ONBOARDING', null)])
    } catch (e) {
      error = e
    }
    expect(error?.message).toMatch(SIN_TERMINAR)
    expect(error?.code).toBe('ALTA_SIN_TERMINAR')
  })

  it('🔴 con otro negocio operativo entra a ése (como con un suspendido)', () => {
    const picked = pickOperationalVenueForLogin([venue('prendas', 'ONBOARDING', null), venue('abierto', 'ACTIVE', new Date())])
    expect(picked.venueId).toBe('abierto')
  })

  // REGRESIÓN — lo que debe seguir entrando.
  it('deja entrar un ONBOARDING del SUPERADMIN (revisión de KYC, sin alta del asistente)', () => {
    expect(pickOperationalVenueForLogin([venue('kyc', 'ONBOARDING')]).venueId).toBe('kyc')
  })

  it('deja entrar un ONBOARDING del SUPERADMIN aunque su dueño haya abierto el asistente VIEJO (progreso v1)', () => {
    // `/onboarding` (v1) llama solo a `/start` y crea un progreso vacío: eso no es un alta del asistente vigente.
    expect(pickOperationalVenueForLogin([venue('kyc', 'ONBOARDING', null, 1)]).venueId).toBe('kyc')
  })

  it('deja entrar un ONBOARDING cuya alta ya terminó', () => {
    expect(pickOperationalVenueForLogin([venue('listo', 'ONBOARDING', new Date())]).venueId).toBe('listo')
  })

  it.each<VenueStatus>(['ACTIVE', 'PENDING_ACTIVATION', 'TRIAL', 'LIVE_DEMO'])(
    'un %s con alta sin terminar en su org sigue entrando: sólo frena ONBOARDING',
    status => {
      expect(pickOperationalVenueForLogin([venue('v', status, null)]).venueId).toBe('v')
    },
  )

  it('una consulta vieja sin `organization` no frena a nadie', () => {
    const sinOrg = venue('viejo', 'ONBOARDING') as any
    delete sinOrg.venue.organization
    expect(pickOperationalVenueForLogin([sinOrg]).venueId).toBe('viejo')
  })
})

describe('loginWithEmail — de punta a punta', () => {
  it('🔴 no da sesión a quien sólo tiene un negocio a medio alta', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(staffWith([venue('prendas', 'ONBOARDING', null)]))

    await expect(loginWithEmail('dueno@negocio.com', 'la-contraseña')).rejects.toThrow(SIN_TERMINAR)
    expect(jwtService.generateAccessToken).not.toHaveBeenCalled()
  })

  it('pide al alta del asistente lo que la regla necesita leer', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(staffWith([venue('abierto', 'ACTIVE', new Date())]))

    await loginWithEmail('dueno@negocio.com', 'la-contraseña')

    const select = prismaMock.staff.findUnique.mock.calls[0][0].select
    expect(select.venues.include.venue.select.organization).toEqual({
      select: { onboardingProgress: { select: { completedAt: true, wizardVersion: true } } },
    })
  })
})

describe('loginWithEmail — la lista de negocios que ve la app', () => {
  it('🔴 no incluye el negocio a medio alta: la app abre el primero de la lista e ignora selectedVenueId', async () => {
    // Antes: la sesión quedaba en «abierto» pero la app pintaba «prendas» (el primero) y operaba sobre él.
    prismaMock.staff.findUnique.mockResolvedValue(staffWith([venue('prendas', 'ONBOARDING', null), venue('abierto', 'ACTIVE', new Date())]))

    const r: any = await loginWithEmail('dueno@negocio.com', 'la-contraseña')

    expect(r.staff.venues.map((v: any) => v.id)).toEqual(['abierto'])
  })

  it('conserva en la lista los ONBOARDING del SUPERADMIN', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(staffWith([venue('kyc', 'ONBOARDING'), venue('abierto', 'ACTIVE', new Date())]))

    const r: any = await loginWithEmail('dueno@negocio.com', 'la-contraseña')

    expect(r.staff.venues.map((v: any) => v.id)).toEqual(['kyc', 'abierto'])
  })
})

describe('refreshAccessToken — alta sin terminar', () => {
  function primeRefresh(venues: ReturnType<typeof venue>[], venueId?: string) {
    prismaMock.staff.findUnique.mockImplementation((args: any) => {
      if (args?.select?.lastPasswordReset) return Promise.resolve({ lastPasswordReset: null })
      return Promise.resolve({ id: 'staff_1', email: 'dueno@negocio.com', active: true, venues })
    })
    jest
      .spyOn(jwtService, 'verifyRefreshToken')
      .mockReturnValue({ sub: 'staff_1', tokenId: 't1', iat: Math.floor(Date.now() / 1000), venueId } as any)
  }

  it('🔴 no renueva la sesión de un negocio a medio alta', async () => {
    primeRefresh([venue('prendas', 'ONBOARDING', null)], 'prendas')

    await expect(refreshAccessToken('refresh-viejo')).rejects.toThrow(SIN_TERMINAR)
    expect(jwtService.generateAccessToken).not.toHaveBeenCalled()
  })

  it('🔴 ni aunque la app lo pida por su id al cambiar de local', async () => {
    primeRefresh([venue('prendas', 'ONBOARDING', null), venue('abierto', 'ACTIVE', new Date())], 'abierto')

    await expect(refreshAccessToken('refresh', 'prendas')).rejects.toThrow(SIN_TERMINAR)
  })

  it('🔴 una sesión guardada en el negocio a medio alta no se pasa en silencio a otro negocio (Codex r2)', async () => {
    // Renovar sin venueId (lo hacen los refrescos automáticos) con la sesión en «prendas» y «abierto» operativo: antes
    // firmaba tokens de «abierto» mientras la app seguía pintando «prendas».
    primeRefresh([venue('prendas', 'ONBOARDING', null), venue('abierto', 'ACTIVE', new Date())], 'prendas')

    await expect(refreshAccessToken('refresh-viejo')).rejects.toThrow(SIN_TERMINAR)
    expect(jwtService.generateAccessToken).not.toHaveBeenCalled()
  })

  it('una sesión en el negocio operativo sigue renovando aunque el dueño tenga otro a medio alta', async () => {
    primeRefresh([venue('prendas', 'ONBOARDING', null), venue('abierto', 'ACTIVE', new Date())], 'abierto')

    await expect(refreshAccessToken('refresh')).resolves.toMatchObject({ accessToken: 'access' })
    expect((jwtService.generateAccessToken as jest.Mock).mock.calls.at(-1)![2]).toBe('abierto')
  })

  it('renueva un ONBOARDING del SUPERADMIN, como hoy', async () => {
    primeRefresh([venue('kyc', 'ONBOARDING')], 'kyc')

    await expect(refreshAccessToken('refresh')).resolves.toMatchObject({ accessToken: 'access' })
  })
})

describe('las tres consultas de negocios del login leen el alta', () => {
  // El camino de passkey es caro de manejar de punta a punta (aserción WebAuthn): se cuida por estructura. Si una de
  // las tres consultas olvida `organization`, ese camino dejaría pasar el alta sin terminar sin que nada truene.
  it('contraseña, passkey y renovación piden el alta del asistente, y las dos respuestas de login filtran la lista', () => {
    const source = readFileSync(join(__dirname, '../../../../src/services/mobile/auth.mobile.service.ts'), 'utf8')
    expect((source.match(/organization: ALTA_DEL_ASISTENTE,/g) ?? []).length).toBe(3)
    expect((source.match(/venues: staff\.venues\s*\.filter\(sv => !altaSinTerminar\(sv\.venue\)\)\s*\.map/g) ?? []).length).toBe(2)
  })
})
