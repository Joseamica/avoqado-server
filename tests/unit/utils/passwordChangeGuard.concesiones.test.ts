/**
 * `motivoDeConcesionInvalidada` — lo que se guarda y se canjea después (códigos y refresh del MCP,
 * enlaces de cambio de correo, pase del selector de organización) muere con el corte de sesión, SIN
 * el margen de 5 s de los tokens de acceso y fallando CERRADO (Codex N1/H4, S4).
 */
import prisma from '@/utils/prismaClient'
import {
  _limpiarCacheDeCambiosDeContrasena,
  cerrarSesionesNuevasPorCambioDeContrasena,
  emisionDelToken,
  motivoDeConcesionInvalidada,
  motivoDeSesionInvalidada,
} from '@/utils/passwordChangeGuard'

jest.mock('@/services/auth/session.service')
jest.mock('@/services/auth/sessionCache')

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

describe('Codex ronda 7, P1: el corte recién movido se ve AL INSTANTE', () => {
  it('🔴 la concesión lee el corte de la base, no de la caché de 30 s', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({ lastPasswordReset: null, sessionsRevokedAt: null })
    // Se llena la caché con «sin corte» (lo que hace cualquier petición normal).
    expect(await motivoDeSesionInvalidada('s-fresco', Math.floor(Date.now() / 1000))).toBeNull()
    // Recupera su cuenta por correo: el corte se mueve en la base.
    prismaMock.staff.findUnique.mockResolvedValue({ lastPasswordReset: new Date(Date.now() + 1000), sessionsRevokedAt: null })
    // Un refresh del MCP emitido ANTES ya no rota, aunque la caché diga «sin corte».
    expect(await motivoDeConcesionInvalidada('s-fresco', new Date())).toBe('PASSWORD_CHANGED')
  })

  it('🔴 cambiar la contraseña por CUALQUIER camino olvida la caché: las sesiones mueren ya, no en 30 s', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({ lastPasswordReset: null, sessionsRevokedAt: null })
    const iat = Math.floor(Date.now() / 1000) - 60
    expect(await motivoDeSesionInvalidada('s-cache', iat)).toBeNull()
    prismaMock.staff.findUnique.mockResolvedValue({ lastPasswordReset: new Date(), sessionsRevokedAt: null })
    prismaMock.session.findMany.mockResolvedValue([])

    await cerrarSesionesNuevasPorCambioDeContrasena('s-cache')

    expect(await motivoDeSesionInvalidada('s-cache', iat)).toBe('PASSWORD_CHANGED')
  })
})

describe('Codex ronda 7, P2: un enlace emitido en el MISMO segundo que el corte, pero después, sirve', () => {
  it('🔴 con la emisión en milisegundos, lo posterior al corte vive aunque su `iat` redondee al mismo segundo', async () => {
    const corte = new Date('2026-09-25T12:00:00.400Z')
    prismaMock.staff.findUnique.mockResolvedValue({ lastPasswordReset: corte, sessionsRevokedAt: null })
    const token = { iat: Math.floor(corte.getTime() / 1000), emitidoMs: corte.getTime() + 400 } // 12:00:00.800
    expect(await motivoDeConcesionInvalidada('s-ms', emisionDelToken(token))).toBeNull()
  })

  it('lo anterior al corte sigue muriendo, y un enlace viejo sin milisegundos se juzga por su `iat` (estricto)', async () => {
    const corte = new Date('2026-09-25T12:00:00.400Z')
    prismaMock.staff.findUnique.mockResolvedValue({ lastPasswordReset: corte, sessionsRevokedAt: null })
    expect(await motivoDeConcesionInvalidada('s-ms2', emisionDelToken({ emitidoMs: corte.getTime() - 1 }))).toBe('PASSWORD_CHANGED')
    expect(await motivoDeConcesionInvalidada('s-ms3', emisionDelToken({ iat: Math.floor(corte.getTime() / 1000) }))).toBe(
      'PASSWORD_CHANGED',
    )
  })

  it('un `emitidoMs` que no es número se ignora (se cae al `iat`)', () => {
    expect(emisionDelToken({ iat: 100, emitidoMs: 'x' as unknown as number })).toBe(100)
  })
})
