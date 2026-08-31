/**
 * Task 12 — el refresco móvil TAMBIÉN marca `pos: true`.
 *
 * El acortamiento a 600s de `generateAccessToken` (`tests/unit/lib/access-ttl-pos.test.ts`)
 * sólo protege mientras el access token del LOGIN sigue vivo. Este endpoint
 * (`refreshAccessToken` en auth.mobile.service.ts) sólo lo llaman avoqado-android/
 * avoqado-ios — nunca el dashboard ni la TPV, que refrescan por su propio carril — así
 * que cada access que sale de aquí es tan POS como el que salió del login.
 *
 * 🔴 Sin volver a marcar `pos: true` en cada refresco, el PRIMER ciclo (~10 min después de
 * entrar) devolvería un access de 24h, y el acortamiento sólo protegería los primeros 10
 * minutos de la sesión completa — justo lo que la Task 12 existe para evitar (el brief
 * declara ~144 refrescos/día, número que sólo tiene sentido si CADA access sigue durando
 * 10 min, no sólo el primero).
 *
 * `pos` no viaja en el refresh token (Task 2 lo dejó fuera a propósito, sin consumidor
 * entonces): se re-marca aquí porque este endpoint completo es sólo del POS, sin
 * necesidad de tocar `generateRefreshToken` ni su payload.
 */
import prisma from '@/utils/prismaClient'
import * as jwtService from '@/jwt.service'
import * as grants from '@/services/auth/refreshGrant.service'
import { refreshAccessToken } from '@/services/mobile/auth.mobile.service'

jest.mock('@/services/auth/refreshGrant.service')

const prismaMock = prisma as any

const STAFF_ID = 'staff_1'
const SESSION_ID = 'sess_1'

const STAFF = {
  id: STAFF_ID,
  email: 'cajero@local.com',
  active: true,
  venues: [
    {
      venueId: 'venue_1',
      role: 'CASHIER',
      venue: { id: 'venue_1', status: 'ACTIVE', organizationId: 'org_1', timezone: 'America/Mexico_City' },
    },
  ],
}

function primeSesion() {
  prismaMock.session.findUnique.mockResolvedValue({
    id: SESSION_ID,
    authMethod: 'PASSWORD',
    venueId: 'venue_1',
    revokedAt: null,
  })
}

/** Un refresh token vigente con `sid`. */
function verificaComoTokenConSid() {
  jest.spyOn(jwtService, 'verifyRefreshToken').mockReturnValue({
    sub: STAFF_ID,
    tokenId: 't1',
    sid: SESSION_ID,
    venueId: 'venue_1',
  } as any)
}

/** Un refresh token LEGACY, emitido antes de que existiera `sid`. */
function verificaComoTokenLegacy() {
  jest.spyOn(jwtService, 'verifyRefreshToken').mockReturnValue({
    sub: STAFF_ID,
    tokenId: 't1',
    venueId: 'venue_1',
  } as any)
}

/** El `opts` (6º arg) con el que se llamó a generateAccessToken la última vez. */
function optsDelAccessEmitido(): any {
  const call = (jwtService.generateAccessToken as jest.Mock).mock.calls.at(-1)!
  return call[5]
}
/** El `opts` (5º arg) con el que se llamó a generateRefreshToken la última vez. */
function optsDelRefreshEmitido(): any {
  const call = (jwtService.generateRefreshToken as jest.Mock).mock.calls.at(-1)!
  return call[4]
}

beforeEach(() => {
  jest.restoreAllMocks()
  prismaMock.staff.findUnique.mockReset()
  prismaMock.session.findUnique.mockReset()
  prismaMock.staff.findUnique.mockResolvedValue(STAFF)
  jest.spyOn(jwtService, 'generateAccessToken').mockReturnValue('access-nuevo')
  jest.spyOn(jwtService, 'generateRefreshToken').mockReturnValue('refresh-nuevo')
  ;(grants.rotateGrant as jest.Mock).mockResolvedValue({ sucesor: 'refresh-sucesor', sessionId: SESSION_ID, familyId: 'fam_1' })
})

describe('refreshAccessToken — el POS sigue siendo POS después de refrescar', () => {
  it('🔴 re-marca pos:true en el access nuevo — si no, el primer refresco vuelve a un token de 24h', async () => {
    primeSesion()
    verificaComoTokenConSid()

    await refreshAccessToken('refresh-viejo')

    expect(optsDelAccessEmitido()).toMatchObject({ pos: true, sid: SESSION_ID })
  })

  it('marca pos:true incluso en un token LEGACY (sin sid) — el endpoint entero es sólo del POS', async () => {
    verificaComoTokenLegacy()

    await refreshAccessToken('refresh-legacy')

    expect(optsDelAccessEmitido()).toEqual({ pos: true })
  })

  it('NO mete pos en el refresh token — sólo el access se acorta', async () => {
    primeSesion()
    verificaComoTokenConSid()

    await refreshAccessToken('refresh-viejo')

    expect(optsDelRefreshEmitido()).toEqual({ sid: SESSION_ID })
  })
})
