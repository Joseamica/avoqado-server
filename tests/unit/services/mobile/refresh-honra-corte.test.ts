/**
 * El refresco MÓVIL tiene que preguntarle al mismo guard que ya usan el
 * middleware HTTP y el refresco de la PAX (`auth.tpv.service.ts:255`).
 *
 * Aquí se mockea `passwordChangeGuard` COMPLETO (a diferencia de
 * `auth.refreshSecurity.test.ts`, que ejercita la implementación real vía
 * Prisma) porque lo que este archivo verifica es el CONTRATO: que
 * `refreshAccessToken` consulte el corte con el `staffId` y el `iat` DEL
 * TOKEN — no con la fecha actual — y que, si el guard dice que hay corte,
 * rechace con el MISMO mensaje que usa la PAX (`mensajeDeCorte`), sin
 * importar cómo decida el guard internamente.
 */
import prisma from '@/utils/prismaClient'
import * as jwtService from '@/jwt.service'
import { refreshAccessToken } from '@/services/mobile/auth.mobile.service'
import * as guard from '@/utils/passwordChangeGuard'

jest.mock('@/utils/passwordChangeGuard')

const prismaMock = prisma as any

const STAFF_ID = 'st1'
const tokenValido = 'refresh-token-valido'

/** El staff + su único venue operativo — lo que `refreshAccessToken` necesita para emitir. */
function primeStaffConVenueOperativo() {
  prismaMock.staff.findUnique.mockResolvedValue({
    id: STAFF_ID,
    email: 'gerente@local.com',
    active: true,
    venues: [
      {
        venueId: 'v1',
        role: 'MANAGER',
        venue: { id: 'v1', status: 'ACTIVE', organizationId: 'org_1', timezone: 'America/Mexico_City' },
      },
    ],
  })
}

describe('refresco movil y el corte de sesion', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.staff.findUnique.mockReset()
    primeStaffConVenueOperativo()
    jest.spyOn(jwtService, 'verifyRefreshToken').mockReturnValue({
      sub: STAFF_ID,
      tokenId: 't1',
      iat: 1_700_000_000,
      venueId: 'v1',
    } as any)
    jest.spyOn(jwtService, 'generateAccessToken').mockReturnValue('new-access')
    jest.spyOn(jwtService, 'generateRefreshToken').mockReturnValue('new-refresh')
  })

  it('rechaza un refresh emitido ANTES del corte', async () => {
    ;(guard.motivoDeSesionInvalidada as jest.Mock).mockResolvedValue('PASSWORD_CHANGED')
    ;(guard.mensajeDeCorte as jest.Mock).mockReturnValue('Tu contraseña cambió. Inicia sesión de nuevo.')

    await expect(refreshAccessToken(tokenValido)).rejects.toThrow(/contraseña cambió/)
  })

  it('deja pasar un refresh emitido DESPUES del corte', async () => {
    ;(guard.motivoDeSesionInvalidada as jest.Mock).mockResolvedValue(null)

    await expect(refreshAccessToken(tokenValido)).resolves.toHaveProperty('accessToken')
  })

  it('consulta el corte con el staffId y el iat DEL TOKEN, no con la fecha actual', async () => {
    ;(guard.motivoDeSesionInvalidada as jest.Mock).mockResolvedValue(null)

    await refreshAccessToken(tokenValido)

    expect(guard.motivoDeSesionInvalidada).toHaveBeenCalledWith(STAFF_ID, 1_700_000_000)
  })
})
