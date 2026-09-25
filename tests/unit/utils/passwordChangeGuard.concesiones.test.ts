/**
 * `motivoDeConcesionInvalidada` — lo que se guarda y se canjea después (códigos y refresh del MCP,
 * enlaces de cambio de correo, pase del selector de organización) muere con el corte de sesión, SIN
 * el margen de 5 s de los tokens de acceso y fallando CERRADO (Codex N1/H4, S4).
 */
import prisma from '@/utils/prismaClient'
import { _limpiarCacheDeCambiosDeContrasena, motivoDeConcesionInvalidada, motivoDeSesionInvalidada } from '@/utils/passwordChangeGuard'

const prismaMock = prisma as any
const CORTE = new Date('2026-09-25T12:00:00.000Z')

beforeEach(() => {
  _limpiarCacheDeCambiosDeContrasena()
  prismaMock.staff.findUnique.mockReset()
  prismaMock.staff.findUnique.mockResolvedValue({ lastPasswordReset: CORTE, sessionsRevokedAt: null })
})

it('🔴 lo emitido 3 s ANTES del corte muere (el margen de 5 s de los accesos lo dejaba vivir)', async () => {
  const hace3s = new Date(CORTE.getTime() - 3000)
  expect(await motivoDeConcesionInvalidada('s1', hace3s)).toBe('PASSWORD_CHANGED')
  // Contraste: el mismo instante como `iat` de un token de ACCESO sí sobrevive, a propósito.
  expect(await motivoDeSesionInvalidada('s1', Math.floor(hace3s.getTime() / 1000))).toBeNull()
})

it('lo emitido en el mismo instante del corte también muere; lo posterior vive', async () => {
  expect(await motivoDeConcesionInvalidada('s1', CORTE)).toBe('PASSWORD_CHANGED')
  expect(await motivoDeConcesionInvalidada('s1', new Date(CORTE.getTime() + 1))).toBeNull()
})

it('acepta el `iat` de un JWT en segundos', async () => {
  expect(await motivoDeConcesionInvalidada('s1', CORTE.getTime() / 1000 - 2)).toBe('PASSWORD_CHANGED')
  expect(await motivoDeConcesionInvalidada('s1', CORTE.getTime() / 1000 + 2)).toBeNull()
})

it('sin corte registrado, la concesión vive', async () => {
  prismaMock.staff.findUnique.mockResolvedValue({ lastPasswordReset: null, sessionsRevokedAt: null })
  expect(await motivoDeConcesionInvalidada('s1', new Date('2020-01-01'))).toBeNull()
})

it('🔴 falla CERRADO: sin fecha, sin persona o con la base caída, no se honra', async () => {
  expect(await motivoDeConcesionInvalidada('s1', undefined)).not.toBeNull()
  expect(await motivoDeConcesionInvalidada(undefined, CORTE)).not.toBeNull()
  prismaMock.staff.findUnique.mockRejectedValue(new Error('db down'))
  expect(await motivoDeConcesionInvalidada('s2', new Date())).not.toBeNull()
})
