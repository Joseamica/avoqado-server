/** Entrar al POS con Google: el orden de las revisiones es el contrato (hz:6bfcd3a1:D1). */
import logger from '@/config/logger'
import prisma from '../../../../src/utils/prismaClient'
import { ligarCuentaConGoogle } from '@/services/auth/google/ligarCuentaConGoogle'
import { leerPaseDeAndroid, leerPaseDeEscritorio } from '@/services/auth/google/paseDeGoogleDelPos'
import { emitirSesionDelPos } from '../../../../src/services/mobile/auth.mobile.service'
import { entrarAlPosConGoogle } from '../../../../src/services/mobile/googleLogin.mobile.service'

jest.mock('@/services/auth/google/ligarCuentaConGoogle')
jest.mock('@/services/auth/google/paseDeGoogleDelPos')
jest.mock('../../../../src/services/mobile/auth.mobile.service', () => ({
  ...jest.requireActual('../../../../src/services/mobile/auth.mobile.service'),
  emitirSesionDelPos: jest.fn(),
}))

const prismaMock = prisma as any
const ligar = ligarCuentaConGoogle as jest.Mock
const emitir = emitirSesionDelPos as jest.Mock
const android = leerPaseDeAndroid as jest.Mock
const escritorio = leerPaseDeEscritorio as jest.Mock

const OK_VENUE = { venue: { id: 'v1', status: 'ACTIVE', kycStatus: 'APPROVED', organizationId: 'org_1', organization: {} } }
const google = (o: Record<string, unknown> = {}) => ({
  sub: 'sub-A',
  email: 'Ana@Gmail.com',
  emailVerified: true,
  hd: null,
  picture: 'p.png',
  ...o,
})
const cuenta = (o: Record<string, unknown> = {}) => ({
  id: 's1',
  email: 'ana@gmail.com',
  active: true,
  googleId: null,
  emailVerified: true,
  password: 'hash',
  photoUrl: null,
  lockedUntil: null,
  venues: [OK_VENUE],
  ...o,
})
const pase = { idToken: 't' }

beforeEach(() => {
  jest.clearAllMocks()
  android.mockResolvedValue(google())
  prismaMock.staff.findUnique = jest.fn().mockResolvedValue(cuenta())
  ligar.mockResolvedValue({ aplicada: true, contrasenaAnulada: false })
  emitir.mockResolvedValue({ ok: true })
})

describe('entrarAlPosConGoogle', () => {
  it('hecha con Google (googleId = sub) entra con sesión GOOGLE', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(cuenta({ googleId: 'sub-A' }))
    await expect(entrarAlPosConGoogle(pase, true, 'dev')).resolves.toEqual({ ok: true })
    expect(prismaMock.staff.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { email: 'ana@gmail.com' } }))
    expect(emitir).toHaveBeenCalledWith(expect.anything(), 'google', true, 'dev')
  })

  it('con contraseña, sin googleId y gmail: se liga y entra', async () => {
    await entrarAlPosConGoogle(pase, undefined, undefined)
    expect(ligar).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }), { sub: 'sub-A', picture: 'p.png' }, 'org_1', {
      siempreEscribir: true,
    })
    expect(emitir).toHaveBeenCalled()
  })

  it('buzón reasignado (googleId ≠ sub) ⇒ MISMATCH y no escribe', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(cuenta({ googleId: 'sub-B' }))
    await expect(entrarAlPosConGoogle(pase, false, 'd')).rejects.toMatchObject({ code: 'GOOGLE_ACCOUNT_MISMATCH', statusCode: 401 })
    expect(ligar).not.toHaveBeenCalled()
    expect(emitir).not.toHaveBeenCalled()
  })

  it('sin googleId, correo de otro proveedor y sin hd ⇒ NOT_LINKED', async () => {
    android.mockResolvedValue(google({ email: 'persona@empresa.mx' }))
    await expect(entrarAlPosConGoogle(pase, false, 'd')).rejects.toMatchObject({ code: 'GOOGLE_ACCOUNT_NOT_LINKED', statusCode: 401 })
    expect(ligar).not.toHaveBeenCalled()
  })

  it('correo x@gmail.com.evil.mx sin googleId y sin hd ⇒ NOT_LINKED', async () => {
    android.mockResolvedValue(google({ email: 'x@gmail.com.evil.mx' }))
    await expect(entrarAlPosConGoogle(pase, false, 'd')).rejects.toMatchObject({ code: 'GOOGLE_ACCOUNT_NOT_LINKED' })
    expect(ligar).not.toHaveBeenCalled()
  })

  it('MISMATCH registra el rechazo sin correo ni sub', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation((() => logger) as any)
    prismaMock.staff.findUnique.mockResolvedValue(cuenta({ googleId: 'sub-B' }))
    await expect(entrarAlPosConGoogle(pase, false, 'd')).rejects.toMatchObject({ code: 'GOOGLE_ACCOUNT_MISMATCH' })
    expect(warn).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify(warn.mock.calls[0])
    expect(logged).toContain('sub-distinto')
    expect(logged).toContain('s1')
    for (const secreto of ['sub-A', 'sub-B', 'gmail.com']) expect(logged).not.toContain(secreto)
    warn.mockRestore()
  })

  it('con dos sucursales, liga con la organización de la que abre (la operativa)', async () => {
    const cerrada = { venue: { ...OK_VENUE.venue, id: 'v0', status: 'CLOSED', organizationId: 'org_0' } }
    const abierta = { venue: { ...OK_VENUE.venue, id: 'v2', organizationId: 'org_2' } }
    prismaMock.staff.findUnique.mockResolvedValue(cuenta({ venues: [cerrada, abierta] }))
    await entrarAlPosConGoogle(pase, false, 'd')
    expect(ligar).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'org_2', { siempreEscribir: true })
  })

  it('sin googleId con hd ⇒ se liga', async () => {
    android.mockResolvedValue(google({ email: 'ana@empresa.mx', hd: 'empresa.mx' }))
    await entrarAlPosConGoogle(pase, false, 'd')
    expect(ligar).toHaveBeenCalled()
  })

  it('sin verificar con contraseña: entra, anula y registra', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(cuenta({ emailVerified: false }))
    ligar.mockResolvedValue({ aplicada: true, contrasenaAnulada: true })
    await entrarAlPosConGoogle(pase, false, 'd')
    expect(ligar).toHaveBeenCalledWith(expect.objectContaining({ emailVerified: false, password: 'hash' }), expect.anything(), 'org_1', {
      siempreEscribir: true,
    })
    expect(emitir).toHaveBeenCalled()
  })

  it('sin verificar y sin sucursal operativa ⇒ NO_VENUE_ACCESS y no se liga', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(cuenta({ emailVerified: false, venues: [] }))
    await expect(entrarAlPosConGoogle(pase, false, 'd')).rejects.toMatchObject({ code: 'NO_VENUE_ACCESS' })
    expect(ligar).not.toHaveBeenCalled()
  })

  it('sin cuenta ⇒ 404 con texto exacto', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(null)
    await expect(entrarAlPosConGoogle(pase, false, 'd')).rejects.toMatchObject({
      statusCode: 404,
      code: 'GOOGLE_ACCOUNT_NOT_FOUND',
      message:
        'No encontramos una cuenta de Avoqado con ese correo. Si te invitaron, acepta la invitación desde tu correo; si eres el dueño, crea tu cuenta en dashboard.avoqado.io.',
    })
  })

  it('inactiva ⇒ 401 y no liga', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(cuenta({ active: false }))
    await expect(entrarAlPosConGoogle(pase, false, 'd')).rejects.toMatchObject({ statusCode: 401, message: 'Tu cuenta está desactivada' })
    expect(ligar).not.toHaveBeenCalled()
  })

  it('correo no verificado en Google ⇒ GOOGLE_EMAIL_NOT_VERIFIED sin tocar la base', async () => {
    android.mockResolvedValue(google({ emailVerified: false }))
    await expect(entrarAlPosConGoogle(pase, false, 'd')).rejects.toMatchObject({ code: 'GOOGLE_EMAIL_NOT_VERIFIED', statusCode: 401 })
    expect(prismaMock.staff.findUnique).not.toHaveBeenCalled()
  })

  it('cuenta bloqueada por contraseñas entra y el bloqueo sigue', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(cuenta({ googleId: 'sub-A', lockedUntil: new Date(Date.now() + 3600_000) }))
    await entrarAlPosConGoogle(pase, false, 'd')
    expect(emitir).toHaveBeenCalled()
    expect(prismaMock.staff.update).not.toHaveBeenCalled()
  })

  it('aplicada false ⇒ 409 GOOGLE_ACCOUNT_CHANGED', async () => {
    ligar.mockResolvedValue({ aplicada: false, contrasenaAnulada: false })
    await expect(entrarAlPosConGoogle(pase, false, 'd')).rejects.toMatchObject({
      statusCode: 409,
      code: 'GOOGLE_ACCOUNT_CHANGED',
      message: 'Vuelve a intentarlo.',
    })
    expect(emitir).not.toHaveBeenCalled()
  })

  it('pase de escritorio usa leerPaseDeEscritorio', async () => {
    const p = { code: 'c', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:5000/cb' }
    escritorio.mockResolvedValue(google())
    await entrarAlPosConGoogle(p, false, 'd')
    expect(escritorio).toHaveBeenCalledWith(p)
    expect(android).not.toHaveBeenCalled()
  })

  it('cuenta ya ligada y verificada también pasa por el candado (siempreEscribir)', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(cuenta({ googleId: 'sub-A' }))
    await entrarAlPosConGoogle(pase, false, 'd')
    expect(ligar).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1', email: 'ana@gmail.com', active: true }),
      { sub: 'sub-A', picture: 'p.png' },
      'org_1',
      { siempreEscribir: true },
    )
  })

  it('correo cambiado entre la lectura y la escritura (count 0) ⇒ 409 y sin sesión, con la regla real', async () => {
    ligar.mockImplementation(jest.requireActual('@/services/auth/google/ligarCuentaConGoogle').ligarCuentaConGoogle)
    prismaMock.staff.updateMany = jest.fn().mockResolvedValue({ count: 0 })
    prismaMock.staff.findUnique.mockResolvedValue(cuenta({ googleId: 'sub-A' }))
    await expect(entrarAlPosConGoogle(pase, false, 'd')).rejects.toMatchObject({ statusCode: 409, code: 'GOOGLE_ACCOUNT_CHANGED' })
    expect(prismaMock.staff.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 's1', email: 'ana@gmail.com', active: true }) }),
    )
    expect(emitir).not.toHaveBeenCalled()
  })
})
