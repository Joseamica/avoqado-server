/**
 * El Gmail del vendedor (fase 2, plan tarea 7): conectar, el estado de «Mi Gmail» y desconectar.
 *
 * Lo que fijan, más allá del camino feliz:
 *  - el navegador que vuelve de Google debe ser el MISMO que empezó: un vendedor que le pasa su liga a otra persona no se
 *    queda con el Gmail de ella (`?error=otra-sesion`, sin canjear el código ni guardar nada);
 *  - Google debe conceder los DOS permisos (mandar y leer) y un `refresh_token`; si no, no se activa nada;
 *  - conectar otra cuenta deja los pendientes de la anterior como «cuenta reemplazada», bajo el candado de la fila;
 *  - desconectar nunca llama a Google y no apaga una conexión que se reconectó en medio (otra `version`);
 *  - una llave mal escrita (base64 en vez de hex) no tumba nada: «Mi Gmail» dice que falta configurar.
 *
 * `googleapis` va simulado: aquí no sale ninguna petición a Google.
 */
const mockGetToken = jest.fn()
const mockVerifyIdToken = jest.fn()
const mockSetCredentials = jest.fn()
const mockOAuth2 = jest.fn()
jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation((...args: unknown[]) => {
        mockOAuth2(...args)
        return {
          getToken: (...a: unknown[]) => mockGetToken(...a),
          verifyIdToken: (...a: unknown[]) => mockVerifyIdToken(...a),
          setCredentials: (...a: unknown[]) => mockSetCredentials(...a),
        }
      }),
    },
    gmail: jest.fn(),
  },
}))

const mockGetCrmAccess = jest.fn()
jest.mock('@/services/crm/access.service', () => ({
  ...jest.requireActual('@/services/crm/access.service'),
  getCrmAccess: (...a: unknown[]) => mockGetCrmAccess(...a),
}))

import jwt from 'jsonwebtoken'
import { prismaMock } from '@tests/__helpers__/setup'
import { createTokenCipher } from '@/lib/token-encryption'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  completarConexion,
  desconectar,
  estadoGmail,
  gmailConfigurado,
  GMAIL_SCOPES,
  urlDeConexion,
} from '@/services/crm/email/gmailOAuth.service'

const STAFF = 'cstaffrafa000000000000001'
const OTRO = 'cstaffotro000000000000001'
const SEND = 'https://www.googleapis.com/auth/gmail.send'
const READ = 'https://www.googleapis.com/auth/gmail.readonly'
const KEY_HEX = 'ab'.repeat(32)
const SUPERADMIN = 'https://superadmin.test'

const ENV = { ...process.env }
function configurar(over: Record<string, string | undefined> = {}) {
  const valores: Record<string, string | undefined> = {
    CRM_GMAIL_CLIENT_ID: 'client-id.apps.googleusercontent.com',
    CRM_GMAIL_CLIENT_SECRET: 'client-secret',
    CRM_GMAIL_REDIRECT_URI: 'https://api.avoqado.test/api/v1/crm/gmail/callback',
    CRM_GMAIL_TOKEN_KEY: KEY_HEX,
    OAUTH_STATE_SECRET: 'state-secret',
    SUPERADMIN_URL: SUPERADMIN,
    ...over,
  }
  for (const [nombre, valor] of Object.entries(valores)) {
    if (valor === undefined) delete process.env[nombre]
    else process.env[nombre] = valor
  }
}

const state = (payload: Record<string, unknown> = {}, opts: jwt.SignOptions = {}) =>
  jwt.sign({ intent: 'crm-gmail', staffId: STAFF, nonce: 'n-1', ...payload }, 'state-secret', {
    algorithm: 'HS256',
    expiresIn: 600,
    ...opts,
  })

const seller = {
  staffId: STAFF,
  isSuperadmin: false,
  ver: 'propios',
  editar: null,
  contactar: true,
  campanas: false,
  exportar: false,
  ventas: false,
  admin: false,
}

/** Lo que contesta Google cuando la persona marcó las dos casillas. */
function googleConcede(over: Record<string, unknown> = {}, email = 'Rafa.Ventas@Gmail.com') {
  mockGetToken.mockResolvedValue({
    tokens: {
      access_token: 'at-1',
      refresh_token: 'rt-1',
      id_token: 'id-token-1',
      scope: `openid https://www.googleapis.com/auth/userinfo.email ${SEND} ${READ}`,
      ...over,
    },
  })
  mockVerifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: 'g-1', email, email_verified: true }) })
}

const sqlDe = (call: unknown[]) => (call[0] as string[]).join('?')

beforeEach(() => {
  configurar()
  for (const fn of [
    mockGetToken,
    mockVerifyIdToken,
    mockSetCredentials,
    mockOAuth2,
    mockGetCrmAccess,
    prismaMock.$queryRaw,
    prismaMock.crmGmailConnection.upsert,
    prismaMock.crmGmailConnection.findUnique,
    prismaMock.crmGmailConnection.updateMany,
    prismaMock.crmGmailAccountSeen.createMany,
    prismaMock.crmGmailAccountSeen.count,
    prismaMock.crmEmailMessage.updateMany,
  ])
    fn.mockReset()
  mockGetCrmAccess.mockResolvedValue(seller)
  prismaMock.$queryRaw.mockResolvedValue([])
  prismaMock.crmGmailConnection.upsert.mockResolvedValue({})
  prismaMock.crmGmailAccountSeen.createMany.mockResolvedValue({ count: 1 })
  prismaMock.crmEmailMessage.updateMany.mockResolvedValue({ count: 0 })
  googleConcede()
})

afterAll(() => {
  process.env = ENV
})

describe('urlDeConexion: la liga a la pantalla de Google', () => {
  it('pide los cuatro permisos, acceso sin conexión y la pantalla de consentimiento, con un state firmado de 10 min', () => {
    const url = new URL(urlDeConexion(STAFF))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(['openid', 'email', SEND, READ])
    expect(GMAIL_SCOPES).toEqual(['openid', 'email', SEND, READ])
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('client-id.apps.googleusercontent.com')
    expect(url.searchParams.get('redirect_uri')).toBe('https://api.avoqado.test/api/v1/crm/gmail/callback')

    const decoded = jwt.verify(url.searchParams.get('state')!, 'state-secret', { algorithms: ['HS256'] }) as jwt.JwtPayload
    expect(decoded).toMatchObject({ intent: 'crm-gmail', staffId: STAFF, nonce: expect.any(String) })
    expect(decoded.exp! - decoded.iat!).toBe(600)
  })

  it('dos ligas seguidas llevan nonce distinto', () => {
    const nonce = () => (jwt.decode(new URL(urlDeConexion(STAFF)).searchParams.get('state')!) as jwt.JwtPayload).nonce
    expect(nonce()).not.toBe(nonce())
  })
})

describe('completarConexion: la vuelta de Google', () => {
  it('conecta: cifra el refresh token, deja la conexión ACTIVA con otra versión y redirige a «Mi Gmail»', async () => {
    const { redirect } = await completarConexion('code-1', state(), STAFF)

    expect(redirect).toBe(`${SUPERADMIN}/crm/gmail?conectado=1`)
    expect(mockGetToken).toHaveBeenCalledWith('code-1')
    expect(mockVerifyIdToken).toHaveBeenCalledWith({ idToken: 'id-token-1', audience: 'client-id.apps.googleusercontent.com' })

    // Bajo el candado de la fila: el mismo que toma `mandarCorreo` al reservar.
    expect(sqlDe(prismaMock.$queryRaw.mock.calls[0])).toMatch(/FROM "CrmGmailConnection" WHERE "staffId" = \?.*FOR UPDATE/s)
    expect(prismaMock.$queryRaw.mock.calls[0][1]).toBe(STAFF)

    const upsert = prismaMock.crmGmailConnection.upsert.mock.calls[0][0]
    expect(upsert.where).toEqual({ staffId: STAFF })
    expect(upsert.create).toMatchObject({
      staffId: STAFF,
      googleEmail: 'rafa.ventas@gmail.com',
      status: 'ACTIVA',
      scopes: expect.stringContaining(SEND),
    })
    expect(upsert.update).toMatchObject({
      googleEmail: 'rafa.ventas@gmail.com',
      status: 'ACTIVA',
      revokedAt: null,
      lastError: null,
      version: { increment: 1 },
    })
    // El token sólo existe cifrado, con la llave PROPIA de esta integración.
    const cipher = createTokenCipher('CRM_GMAIL_TOKEN_KEY')
    expect(cipher.decrypt(Buffer.from(upsert.create.refreshTokenCiphertext))).toBe('rt-1')
    expect(cipher.decrypt(Buffer.from(upsert.update.refreshTokenCiphertext))).toBe('rt-1')
    expect(Buffer.from(upsert.create.refreshTokenCiphertext).toString('utf8')).not.toContain('rt-1')

    expect(prismaMock.crmGmailAccountSeen.createMany).toHaveBeenCalledWith({
      data: [{ googleEmail: 'rafa.ventas@gmail.com' }],
      skipDuplicates: true,
    })
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ staffId: STAFF, action: 'CRM_GMAIL_CONNECTED' }))
    // Nada del token en la bitácora.
    expect(JSON.stringify((logAction as jest.Mock).mock.calls)).not.toContain('rt-1')
  })

  it('conectar otra cuenta deja los pendientes de la anterior como «cuenta reemplazada», en la misma transacción', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ googleEmail: 'anterior@gmail.com' }])
    prismaMock.crmEmailMessage.updateMany.mockResolvedValue({ count: 2 })

    await completarConexion('code-1', state(), STAFF)

    expect(prismaMock.crmEmailMessage.updateMany).toHaveBeenCalledWith({
      where: {
        staffId: STAFF,
        direction: 'SALIDA',
        status: { in: ['ENVIANDO', 'DESCONOCIDO'] },
        fromEmail: { not: 'rafa.ventas@gmail.com' },
      },
      data: { status: 'DESCONOCIDO', error: 'cuenta reemplazada' },
    })
    // El candado va primero, luego los pendientes, luego las credenciales nuevas.
    const orden = (fn: jest.Mock) => fn.mock.invocationCallOrder[0]
    expect(orden(prismaMock.$queryRaw)).toBeLessThan(orden(prismaMock.crmEmailMessage.updateMany))
    expect(orden(prismaMock.crmEmailMessage.updateMany)).toBeLessThan(orden(prismaMock.crmGmailConnection.upsert))
  })

  it.each([
    ['vencido', state({}, { expiresIn: -10 })],
    ['de otra intención', state({ intent: 'staff_personal' })],
    ['firmado con otra llave', jwt.sign({ intent: 'crm-gmail', staffId: STAFF, nonce: 'n' }, 'otra-llave', { algorithm: 'HS256' })],
    ['que falta', undefined],
  ])('un state %s redirige con ?error=state y no canjea el código', async (_caso, st) => {
    const { redirect } = await completarConexion('code-1', st, STAFF)
    expect(redirect).toBe(`${SUPERADMIN}/crm/gmail?error=state`)
    expect(mockGetToken).not.toHaveBeenCalled()
    expect(prismaMock.crmGmailConnection.upsert).not.toHaveBeenCalled()
  })

  it.each([
    ['la sesión de otra persona', OTRO],
    ['ninguna sesión', null],
  ])('🔴 con %s redirige con ?error=otra-sesion y no guarda nada', async (_caso, sesion) => {
    const { redirect } = await completarConexion('code-1', state(), sesion)
    expect(redirect).toBe(`${SUPERADMIN}/crm/gmail?error=otra-sesion`)
    // Ni siquiera se canjea el código: el Gmail de esa persona nunca llega a nuestras manos.
    expect(mockGetToken).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.crmGmailConnection.upsert).not.toHaveBeenCalled()
    expect(prismaMock.crmGmailAccountSeen.createMany).not.toHaveBeenCalled()
  })

  it('quien ya no tiene «Mandar correo» vuelve con ?error=sin-llave', async () => {
    mockGetCrmAccess.mockResolvedValue({ ...seller, contactar: false })
    const { redirect } = await completarConexion('code-1', state(), STAFF)
    expect(redirect).toBe(`${SUPERADMIN}/crm/gmail?error=sin-llave`)
    expect(mockGetCrmAccess).toHaveBeenCalledWith(STAFF)
    expect(mockGetToken).not.toHaveBeenCalled()
    expect(prismaMock.crmGmailConnection.upsert).not.toHaveBeenCalled()
  })

  it('si Google sólo concedió gmail.send, ?error=permisos-incompletos y no activa nada', async () => {
    googleConcede({ scope: `openid https://www.googleapis.com/auth/userinfo.email ${SEND}` })
    const { redirect } = await completarConexion('code-1', state(), STAFF)
    expect(redirect).toBe(`${SUPERADMIN}/crm/gmail?error=permisos-incompletos`)
    expect(prismaMock.crmGmailConnection.upsert).not.toHaveBeenCalled()
    expect(prismaMock.crmGmailAccountSeen.createMany).not.toHaveBeenCalled()
  })

  it('sin refresh_token, ?error=sin-refresh y no activa nada', async () => {
    googleConcede({ refresh_token: undefined })
    const { redirect } = await completarConexion('code-1', state(), STAFF)
    expect(redirect).toBe(`${SUPERADMIN}/crm/gmail?error=sin-refresh`)
    expect(prismaMock.crmGmailConnection.upsert).not.toHaveBeenCalled()
  })

  it('un correo de Google sin verificar no se conecta', async () => {
    mockVerifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: 'g-1', email: 'x@gmail.com', email_verified: false }) })
    const { redirect } = await completarConexion('code-1', state(), STAFF)
    expect(redirect).toBe(`${SUPERADMIN}/crm/gmail?error=correo-no-verificado`)
    expect(prismaMock.crmGmailConnection.upsert).not.toHaveBeenCalled()
  })

  it('un fallo de Google al canjear redirige con ?error=google, nunca truena, y no deja el secreto en el log', async () => {
    mockGetToken.mockRejectedValue(Object.assign(new Error('invalid_grant'), { config: { data: 'client_secret=client-secret' } }))
    const { redirect } = await completarConexion('code-1', state(), STAFF)
    expect(redirect).toBe(`${SUPERADMIN}/crm/gmail?error=google`)
    const logger = jest.requireMock('@/config/logger').default
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('client-secret')
  })
})

describe('estadoGmail: lo que muestra «Mi Gmail»', () => {
  it('conectado: la cuenta, su estado y cuántas cuentas distintas van del tope de 100', async () => {
    prismaMock.crmGmailConnection.findUnique.mockResolvedValue({ googleEmail: 'rafa@gmail.com', status: 'ACTIVA' })
    prismaMock.crmGmailAccountSeen.count.mockResolvedValue(2)
    await expect(estadoGmail(STAFF)).resolves.toEqual({
      configurado: true,
      conectado: true,
      googleEmail: 'rafa@gmail.com',
      status: 'ACTIVA',
      cuentasUsadas: 2,
      tope: 100,
    })
    // El tope es de la app (todas las personas): se cuenta la tabla completa, no las de este vendedor.
    expect(prismaMock.crmGmailAccountSeen.count).toHaveBeenCalledWith()
  })

  it('revocada: no está conectado, pero dice cuál era', async () => {
    prismaMock.crmGmailConnection.findUnique.mockResolvedValue({ googleEmail: 'rafa@gmail.com', status: 'REVOCADA' })
    prismaMock.crmGmailAccountSeen.count.mockResolvedValue(1)
    await expect(estadoGmail(STAFF)).resolves.toMatchObject({ conectado: false, status: 'REVOCADA', googleEmail: 'rafa@gmail.com' })
  })

  it('conectar la misma cuenta tres veces y otra una vez sólo pide guardar cada cuenta, sin duplicar (la base deduplica)', async () => {
    for (const email of ['a@gmail.com', 'A@gmail.com', 'a@gmail.com', 'b@gmail.com']) {
      googleConcede({}, email)
      await completarConexion('code', state(), STAFF)
    }
    const guardadas = prismaMock.crmGmailAccountSeen.createMany.mock.calls.map((c: any[]) => c[0])
    expect(guardadas.every((c: any) => c.skipDuplicates === true)).toBe(true)
    expect(new Set(guardadas.map((c: any) => c.data[0].googleEmail))).toEqual(new Set(['a@gmail.com', 'b@gmail.com']))
  })
})

describe('desconectar', () => {
  it('no llama a Google, borra el token cifrado y deja REVOCADA sólo la versión que leyó', async () => {
    prismaMock.crmGmailConnection.findUnique.mockResolvedValue({ version: 3, status: 'ACTIVA' })
    prismaMock.crmGmailConnection.updateMany.mockResolvedValue({ count: 1 })
    const fetchSpy = jest.spyOn(global, 'fetch')

    await expect(desconectar(STAFF)).resolves.toEqual({ desconectado: true })

    expect(prismaMock.crmGmailConnection.updateMany).toHaveBeenCalledWith({
      where: { staffId: STAFF, version: 3 },
      data: { status: 'REVOCADA', revokedAt: expect.any(Date), refreshTokenCiphertext: new Uint8Array(0) },
    })
    expect(mockOAuth2).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ staffId: STAFF, action: 'CRM_GMAIL_DISCONNECTED' }))
    fetchSpy.mockRestore()
  })

  it('🔴 no apaga una conexión que se reconectó en medio (otra versión)', async () => {
    prismaMock.crmGmailConnection.findUnique.mockResolvedValue({ version: 3, status: 'ACTIVA' })
    // Entre la lectura y la escritura otra pestaña reconectó: la fila ya va en la versión 4.
    prismaMock.crmGmailConnection.updateMany.mockResolvedValue({ count: 0 })

    await expect(desconectar(STAFF)).resolves.toEqual({ desconectado: false })
    expect(prismaMock.crmGmailConnection.updateMany.mock.calls[0][0].where).toEqual({ staffId: STAFF, version: 3 })
    expect(logAction).not.toHaveBeenCalled()
  })

  it('sin conexión no hace nada', async () => {
    prismaMock.crmGmailConnection.findUnique.mockResolvedValue(null)
    await expect(desconectar(STAFF)).resolves.toEqual({ desconectado: false })
    expect(prismaMock.crmGmailConnection.updateMany).not.toHaveBeenCalled()
  })
})

describe('la llave y la configuración (Ruling 3: una variable mal escrita nunca tumba la API)', () => {
  it('con la llave de 64 caracteres hex cifra y descifra', async () => {
    expect(gmailConfigurado()).toBe(true)
    await completarConexion('code-1', state(), STAFF)
    const blob = prismaMock.crmGmailConnection.upsert.mock.calls[0][0].create.refreshTokenCiphertext
    expect(createTokenCipher('CRM_GMAIL_TOKEN_KEY').decrypt(Buffer.from(blob))).toBe('rt-1')
  })

  it.each([
    ['la llave en base64 (44 caracteres)', { CRM_GMAIL_TOKEN_KEY: Buffer.from(KEY_HEX, 'hex').toString('base64') }],
    ['la llave de 64 caracteres que no son hex', { CRM_GMAIL_TOKEN_KEY: 'z'.repeat(64) }],
    ['una dirección de vuelta que no es URL', { CRM_GMAIL_REDIRECT_URI: 'api.avoqado.io/callback' }],
    ['sin client id', { CRM_GMAIL_CLIENT_ID: undefined }],
    ['sin client secret', { CRM_GMAIL_CLIENT_SECRET: undefined }],
  ])('con %s: «no configurado», conectar responde el error claro y la vuelta no truena', async (_caso, over) => {
    configurar(over)
    expect(gmailConfigurado()).toBe(false)
    prismaMock.crmGmailConnection.findUnique.mockResolvedValue(null)
    prismaMock.crmGmailAccountSeen.count.mockResolvedValue(0)
    await expect(estadoGmail(STAFF)).resolves.toMatchObject({ configurado: false, conectado: false })
    expect(() => urlDeConexion(STAFF)).toThrow(expect.objectContaining({ statusCode: 503, message: 'Falta configurar la app de Google' }))
    await expect(completarConexion('code-1', state(), STAFF)).resolves.toEqual({ redirect: `${SUPERADMIN}/crm/gmail?error=no-configurado` })
    expect(prismaMock.crmGmailConnection.upsert).not.toHaveBeenCalled()
  })
})
