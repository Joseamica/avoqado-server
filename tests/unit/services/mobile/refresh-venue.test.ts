/**
 * Parte A (sesiones revocables) — Task 10.
 *
 * Hasta esta tarea `issueGrant`/`rotateGrant` (Tasks 8 y 9) no tenían NINGÚN llamador: el
 * mecanismo de rotación existía, probado en aislamiento, pero nadie lo enchufaba al
 * refresco real. Este archivo prueba que `refreshAccessToken`:
 *
 * 1. Rota el grant de verdad (`rotateGrant`) y usa su sucesor como refresh nuevo.
 * 2. Rechaza el refresco cuando `rotateGrant` detecta reutilización.
 * 3. Conserva el `sid` en los tokens nuevos, para que sigan apuntando a la MISMA sesión.
 * 4. 🔴 Sólo una sesión `PIN` queda anclada a su sucursal — PASSWORD/BIOMETRIC conservan
 *    el comportamiento de hoy (ruling del barrido: el spec pedía rechazar
 *    `requestedVenueId` SIEMPRE, y eso rompería el cambio de sucursal en producción).
 * 5. Un token LEGACY (sin `sid`) sigue funcionando exactamente como hoy: no tiene sesión
 *    ni grant que rotar.
 * 6. El filtro de venue no operativo (Task 7 / `32e44bd9`) sigue vivo — no se re-implementa,
 *    sólo se comprueba que este cambio no lo rompió.
 */
import prisma from '@/utils/prismaClient'
import * as jwtService from '@/jwt.service'
import * as grants from '@/services/auth/refreshGrant.service'
import { refreshAccessToken } from '@/services/mobile/auth.mobile.service'

jest.mock('@/services/auth/refreshGrant.service')

const prismaMock = prisma as any

const STAFF_ID = 'staff_1'
const SESSION_ID = 'sess_1'

const venue = (id: string, status = 'ACTIVE') => ({
  venueId: id,
  role: 'WAITER',
  venue: { id, status, organizationId: 'org_1', timezone: 'America/Mexico_City' },
})

// El staff trabaja en dos locales: el que ya trae el refresh token, y otro al que el
// cliente puede pedir cambiarse (POS que cambia de sucursal).
const STAFF = {
  id: STAFF_ID,
  email: 'mesero@local.com',
  active: true,
  venues: [venue('venue_actual'), venue('otro_venue')],
}

function primeStaff(overrides: Partial<typeof STAFF> = {}) {
  prismaMock.staff.findUnique.mockResolvedValue({ ...STAFF, ...overrides })
}

/** Sesión viva por default: PASSWORD, sin revocar, anclada a `venue_actual`. */
function primeSesion(overrides: Partial<{ authMethod: string; venueId: string; revokedAt: Date | null }> = {}) {
  prismaMock.session.findUnique.mockResolvedValue({
    id: SESSION_ID,
    authMethod: 'PASSWORD',
    venueId: 'venue_actual',
    revokedAt: null,
    ...overrides,
  })
}

/** Un refresh token vigente con `sid` — el caso que esta tarea enchufa. */
function verificaComoTokenConSid(venueId = 'venue_actual') {
  jest.spyOn(jwtService, 'verifyRefreshToken').mockReturnValue({
    sub: STAFF_ID,
    tokenId: 't1',
    sid: SESSION_ID,
    venueId,
  } as any)
}

/** Un refresh token LEGACY, emitido antes de que existiera `sid`. */
function verificaComoTokenLegacy(venueId = 'venue_actual') {
  jest.spyOn(jwtService, 'verifyRefreshToken').mockReturnValue({
    sub: STAFF_ID,
    tokenId: 't1',
    venueId,
  } as any)
}

/** El venueId que quedó sellado en el access token que se acaba de emitir. */
function venueDelTokenEmitido(): string {
  const call = (jwtService.generateAccessToken as jest.Mock).mock.calls.at(-1)!
  return call[2] as string
}

/** El `sid` con el que se llamó a generateAccessToken/generateRefreshToken la última vez. */
function sidDelAccessEmitido(): string | undefined {
  const call = (jwtService.generateAccessToken as jest.Mock).mock.calls.at(-1)!
  return call[5]?.sid
}
function sidDelRefreshEmitido(): string | undefined {
  const call = (jwtService.generateRefreshToken as jest.Mock).mock.calls.at(-1)!
  return call[4]?.sid
}

beforeEach(() => {
  prismaMock.staff.findUnique.mockReset()
  prismaMock.session.findUnique.mockReset()
  primeStaff()
  primeSesion()
  jest.spyOn(jwtService, 'generateAccessToken').mockReturnValue('access-nuevo')
  jest.spyOn(jwtService, 'generateRefreshToken').mockReturnValue('refresh-nuevo')
  verificaComoTokenConSid()
  ;(grants.rotateGrant as jest.Mock).mockResolvedValue({ sucesor: 'refresh-sucesor', sessionId: SESSION_ID, familyId: 'fam_1' })
})

describe('refresco: rota el grant de verdad', () => {
  it('ROTA el grant: el refresh viejo queda consumido y se emite uno nuevo', async () => {
    const r = await refreshAccessToken('refresh-viejo')

    expect(grants.rotateGrant).toHaveBeenCalledWith('refresh-viejo', 'refresh-nuevo', expect.any(Date))
    expect(r.refreshToken).toBe('refresh-sucesor')
  })

  it('si rotateGrant dice REUTILIZADO, el refresco falla', async () => {
    ;(grants.rotateGrant as jest.Mock).mockResolvedValue({ reutilizado: true })

    await expect(refreshAccessToken('refresh-robado')).rejects.toThrow()
  })

  it('conserva el sid en los tokens nuevos — siguen apuntando a la MISMA sesión', async () => {
    await refreshAccessToken('refresh-viejo')

    expect(sidDelAccessEmitido()).toBe(SESSION_ID)
    expect(sidDelRefreshEmitido()).toBe(SESSION_ID)
  })
})

describe('refresco: sólo una sesión PIN queda anclada a su sucursal', () => {
  it('🔴 una sesión PIN NO puede cambiar de sucursal', async () => {
    primeSesion({ authMethod: 'PIN' })

    await expect(refreshAccessToken('refresh-viejo', 'otro_venue')).rejects.toThrow(/contraseña/i)
    expect(grants.rotateGrant).not.toHaveBeenCalled()
  })

  it('una sesión PASSWORD SÍ puede cambiar de sucursal (comportamiento de hoy)', async () => {
    primeSesion({ authMethod: 'PASSWORD' })

    await expect(refreshAccessToken('refresh-viejo', 'otro_venue')).resolves.toHaveProperty('accessToken')
    expect(venueDelTokenEmitido()).toBe('otro_venue')
  })

  it('una sesión PIN sigue pudiendo refrescar sin pedir cambio de sucursal', async () => {
    primeSesion({ authMethod: 'PIN' })

    await expect(refreshAccessToken('refresh-viejo')).resolves.toHaveProperty('accessToken')
  })
})

describe('refresco: compatibilidad con tokens legacy (sin sid)', () => {
  it('un token LEGACY sin sid se comporta como hoy (puede cambiar de sucursal)', async () => {
    verificaComoTokenLegacy()

    await expect(refreshAccessToken('refresh-legacy', 'otro_venue')).resolves.toHaveProperty('accessToken')
    expect(prismaMock.session.findUnique).not.toHaveBeenCalled()
    expect(grants.rotateGrant).not.toHaveBeenCalled()
    expect(sidDelAccessEmitido()).toBeUndefined()
  })
})

describe('refresco: el filtro de venue no operativo sigue vivo (no se re-implementa aquí)', () => {
  it('sigue rechazando un venue NO operativo', async () => {
    primeStaff({ venues: [venue('venue_actual'), venue('venue_suspendido', 'SUSPENDED')] } as any)

    await expect(refreshAccessToken('refresh-viejo', 'venue_suspendido')).rejects.toThrow(/operativo/i)
    expect(grants.rotateGrant).not.toHaveBeenCalled()
  })
})
