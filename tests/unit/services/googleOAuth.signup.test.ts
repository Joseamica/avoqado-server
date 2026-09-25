/**
 * Alta de un negocio NUEVO con Google, desde /signup (founder, 24-sep: «en signup debería el
 * usuario poder crear cuenta por Google»).
 *
 * 🔴 Antes: un correo sin cuenta y sin invitación recibía 403 «No invitation found» — Google sólo
 * servía para entrar o para aceptar una invitación. Y el callback mandaba sólo el `code`, así que
 * quien llegara de un anuncio perdía la campaña y pagaba precio de lista.
 *
 * Lo que fijan estas pruebas:
 *  - con el sobre `signup` (que SÓLO manda la pantalla de alta) se crea el negocio por la MISMA
 *    función que el alta por correo, con campaña, UTM y consentimiento;
 *  - SIN el sobre se conserva el 403 de siempre: entrar por «Iniciar sesión» con un correo
 *    desconocido no crea negocios en silencio;
 *  - una invitación pendiente gana, y una cuenta existente sólo inicia sesión.
 */
import { StaffRole } from '@prisma/client'

const GOOGLE_PAYLOAD = {
  sub: 'google-uid-9',
  email: 'Nueva@Cafe.mx',
  name: 'Ana Pérez',
  given_name: 'Ana',
  family_name: 'Pérez',
  picture: 'https://example.test/ana.png',
  email_verified: true,
}

jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    generateAuthUrl: jest.fn().mockReturnValue('https://accounts.google.test/auth'),
    getToken: jest.fn().mockResolvedValue({ tokens: { id_token: 'id-token' } }),
    verifyIdToken: jest.fn().mockResolvedValue({ getPayload: () => GOOGLE_PAYLOAD }),
  })),
}))

const state: { existingStaff: any; invitation: any; staffAfterCreate: any } = {
  existingStaff: null,
  invitation: null,
  staffAfterCreate: null,
}

const txFalso = {
  marca: 'tx',
  // lo mínimo para que la rama de INVITACIÓN llegue al final (crea Staff dentro de su transacción)
  staff: { create: jest.fn().mockResolvedValue({ id: 'staff-invitado' }) },
  staffOrganization: { create: jest.fn().mockResolvedValue({}) },
  staffVenue: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
  invitation: { update: jest.fn().mockResolvedValue({}) },
}
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: {
      findUnique: jest.fn(() => Promise.resolve(state.existingStaff)),
      findUniqueOrThrow: jest.fn(() => Promise.resolve(state.staffAfterCreate)),
      update: jest.fn().mockResolvedValue({}),
    },
    invitation: {
      findFirst: jest.fn(() => Promise.resolve(state.invitation)),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    venue: { findMany: jest.fn(() => Promise.resolve([])) },
    $transaction: jest.fn(async (cb: any) => cb(txFalso)),
  },
}))

const crearNegocioNuevo = jest.fn()
const resolverAtribucionDelAlta = jest.fn()
jest.mock('../../../src/services/onboarding/nuevoNegocio', () => ({ crearNegocioNuevo, resolverAtribucionDelAlta }))

jest.mock('../../../src/services/access/seatCap.service', () => ({ assertCanAddSeatsBulk: jest.fn() }))
jest.mock('@/services/auth/session.service', () => ({ createSession: jest.fn().mockResolvedValue({ id: 'sess' }) }))
jest.mock('@/services/auth/refreshGrant.service', () => ({ issueGrant: jest.fn().mockResolvedValue(undefined) }))
const logAction = jest.fn()
jest.mock('../../../src/services/dashboard/activity-log.service', () => ({ logAction }))
const generateAccessToken = jest.fn().mockReturnValue('access-token')
jest.mock('../../../src/jwt.service', () => ({
  generateAccessToken: (...a: unknown[]) => generateAccessToken(...a),
  generateRefreshToken: jest.fn().mockReturnValue('refresh-token'),
}))
jest.mock('../../../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
jest.mock('../../../src/services/staffOrganization.service', () => ({ getPrimaryOrganizationId: jest.fn().mockResolvedValue('org-new') }))

import { loginWithGoogle } from '../../../src/services/dashboard/googleOAuth.service'

const SOBRE = { legalVersion: 'v1-2026-09-17', launchCampaignCode: 'pos-22-mx', utm: { utm_source: 'google', gclid: 'abc' } }
const ATRIBUCION = { campanaId: 'lc-1', utm: SOBRE.utm, legalVersion: SOBRE.legalVersion }

/** El dueño recién creado, como lo relee el servicio: sin sucursales y con el alta sin terminar. */
function duenoNuevo() {
  return {
    id: 'staff-new',
    email: 'nueva@cafe.mx',
    firstName: 'Ana',
    lastName: 'Pérez',
    photoUrl: GOOGLE_PAYLOAD.picture,
    active: true,
    organizations: [{ organizationId: 'org-new', organization: { id: 'org-new', email: 'nueva@cafe.mx', onboardingCompletedAt: null } }],
    venues: [],
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  state.existingStaff = null
  state.invitation = null
  state.staffAfterCreate = duenoNuevo()
  resolverAtribucionDelAlta.mockResolvedValue(ATRIBUCION)
  crearNegocioNuevo.mockResolvedValue({ organization: { id: 'org-new' }, staff: { id: 'staff-new' } })
})

describe('loginWithGoogle — alta de negocio nuevo', () => {
  it('🔴 con el sobre de alta, crea el negocio con la campaña, los UTM y el consentimiento del anuncio', async () => {
    const r = await loginWithGoogle('code-1', true, SOBRE)

    expect(resolverAtribucionDelAlta).toHaveBeenCalledWith(SOBRE)
    expect(crearNegocioNuevo).toHaveBeenCalledWith(
      txFalso,
      expect.objectContaining({
        email: 'nueva@cafe.mx',
        hashedPassword: null,
        firstName: 'Ana',
        lastName: 'Pérez',
        emailVerified: true, // Google ya lo verificó: no se manda código por correo
        googleId: GOOGLE_PAYLOAD.sub,
        photoUrl: GOOGLE_PAYLOAD.picture,
        wizardVersion: 2,
        acquisitionSource: 'dashboard_signup_google',
        atribucion: ATRIBUCION,
      }),
    )
    expect(r.isNewUser).toBe(true)
    expect(r.businessCreated).toBe(true)
    // entra directo al asistente, como el dueño del alta por correo tras verificar su código
    expect(generateAccessToken).toHaveBeenCalledWith('staff-new', 'org-new', 'pending', StaffRole.OWNER)
    expect(r.staff).toMatchObject({ role: StaffRole.OWNER, venues: [] })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ACCOUNT_SIGNUP',
        entity: 'Staff',
        entityId: 'staff-new',
        // en su COLUMNA, no sólo dentro de data: así la encuentra la bitácora filtrada por organización
        organizationId: 'org-new',
        data: expect.objectContaining({ method: 'google' }),
      }),
    )
  })

  it('🔴 SIN el sobre se conserva el 403: «Iniciar sesión» con un correo desconocido no crea negocios', async () => {
    await expect(loginWithGoogle('code-1', true)).rejects.toMatchObject({ statusCode: 403 })
    expect(crearNegocioNuevo).not.toHaveBeenCalled()
  })

  it('🔴 una invitación pendiente GANA sobre el alta: no se crea un negocio aparte', async () => {
    state.invitation = {
      id: 'inv-1',
      email: 'nueva@cafe.mx',
      role: StaffRole.WAITER,
      organizationId: 'org-1',
      venueId: 'venue-1',
      requirePin: true, // así no toca las tablas de sucursales del mock
      permissions: null,
      venue: { id: 'venue-1', organizationId: 'org-1' },
    }
    state.staffAfterCreate = {
      ...duenoNuevo(),
      id: 'staff-invitado',
      organizations: [],
      venues: [
        { venueId: 'venue-1', role: StaffRole.WAITER, venue: { id: 'venue-1', name: 'Café', slug: 'cafe', organizationId: 'org-1' } },
      ],
    }
    const r = await loginWithGoogle('code-1', true, SOBRE)
    expect(crearNegocioNuevo).not.toHaveBeenCalled()
    // 🔴 la cuenta nace (isNewUser) pero NO es un negocio: la pantalla no debe contarla como alta
    expect(r.isNewUser).toBe(true)
    expect(r.businessCreated).toBe(false)
  })

  it('una cuenta que YA existe sólo inicia sesión, aunque venga del alta', async () => {
    state.existingStaff = { ...duenoNuevo(), googleId: GOOGLE_PAYLOAD.sub, emailVerified: true }
    const r = await loginWithGoogle('code-1', true, SOBRE)
    expect(crearNegocioNuevo).not.toHaveBeenCalled()
    expect(r.isNewUser).toBe(false)
    expect(r.businessCreated).toBe(false)
  })
})
