/**
 * Codex ronda 7, P3: `staffLogout` de la TPV verificaba con `verifyToken`, que acepta el REFRESH (misma
 * llave y audiencia), y con él escribía un cierre de sesión. Sólo un token de ACCESO cierra la sesión.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { generateAccessToken, generateRefreshToken } from '@/security'
import { staffLogout } from '@/services/tpv/auth.tpv.service'

const payload = { userId: 'staff-1', orgId: 'org-1', venueId: 'v-1', role: 'OWNER' } as never

beforeEach(() => {
  prismaMock.staffVenue.findFirst.mockReset().mockResolvedValue(null as never)
})

it('🔴 un refresh de la TPV NO sirve para cerrar sesión', async () => {
  await expect(staffLogout(generateRefreshToken(payload))).rejects.toMatchObject({ statusCode: 401 })
  expect(prismaMock.staffVenue.findFirst).not.toHaveBeenCalled()
})

it('el token de acceso sí pasa la verificación (regresión)', async () => {
  await staffLogout(generateAccessToken(payload)).catch(() => undefined)
  expect(prismaMock.staffVenue.findFirst).toHaveBeenCalled()
})
