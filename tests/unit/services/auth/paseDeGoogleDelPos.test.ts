/** El pase de Google del POS: audiencia propia, nonce de un solo uso y escritorio (hz:6bfcd3a1:D1). */
const verifyIdToken = jest.fn()
const getToken = jest.fn()
const ctor = jest.fn()
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation((...a: any[]) => {
    ctor(...a)
    return { verifyIdToken: (...x: any[]) => verifyIdToken(...x), getToken: (...x: any[]) => getToken(...x) }
  }),
}))

import {
  configDeGoogleParaElPos,
  leerPaseDeAndroid,
  leerPaseDeEscritorio,
  vaciarNoncesSoloPruebas,
} from '../../../../src/services/auth/google/paseDeGoogleDelPos'

const AUD = 'pos-android-aud.apps.test'
const payload = (nonce?: string) => ({
  getPayload: () => ({ sub: 'g-1', email: 'a@b.test', email_verified: true, hd: 'b.test', picture: 'https://p.test/x.png', nonce }),
})

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-11-26T12:00:00Z'))
  vaciarNoncesSoloPruebas()
  verifyIdToken.mockReset()
  getToken.mockReset()
  ctor.mockReset()
  process.env.GOOGLE_POS_ANDROID_AUDIENCE = AUD
  process.env.GOOGLE_POS_DESKTOP_CLIENT_ID = 'desk-id'
  process.env.GOOGLE_POS_DESKTOP_CLIENT_SECRET = 'desk-secret'
})
afterEach(() => jest.useRealTimers())

const invalido = { code: 'GOOGLE_TOKEN_INVALID', statusCode: 401 }

describe('leerPaseDeAndroid', () => {
  it('token con audiencia del POS y nonce emitido => usuario con hd', async () => {
    const nonce = configDeGoogleParaElPos().nonce!
    verifyIdToken.mockResolvedValue(payload(nonce))
    await expect(leerPaseDeAndroid('tok')).resolves.toEqual({
      sub: 'g-1',
      email: 'a@b.test',
      emailVerified: true,
      hd: 'b.test',
      picture: 'https://p.test/x.png',
    })
    expect(verifyIdToken).toHaveBeenCalledWith({ idToken: 'tok', audience: AUD })
  })
  it('el mismo nonce dos veces => la segunda GOOGLE_TOKEN_INVALID', async () => {
    const nonce = configDeGoogleParaElPos().nonce!
    verifyIdToken.mockResolvedValue(payload(nonce))
    await leerPaseDeAndroid('tok')
    await expect(leerPaseDeAndroid('tok')).rejects.toMatchObject(invalido)
  })
  it('nonce que nunca se emitio (o ausente) => GOOGLE_TOKEN_INVALID', async () => {
    verifyIdToken.mockResolvedValue(payload('ajeno'))
    await expect(leerPaseDeAndroid('tok')).rejects.toMatchObject(invalido)
    verifyIdToken.mockResolvedValue(payload(undefined))
    await expect(leerPaseDeAndroid('tok')).rejects.toMatchObject(invalido)
  })
  it('nonce vencido (+11 min) => GOOGLE_TOKEN_INVALID', async () => {
    const nonce = configDeGoogleParaElPos().nonce!
    jest.setSystemTime(Date.now() + 11 * 60_000)
    verifyIdToken.mockResolvedValue(payload(nonce))
    await expect(leerPaseDeAndroid('tok')).rejects.toMatchObject(invalido)
  })
  it('verifyIdToken truena (aud del panel) => GOOGLE_TOKEN_INVALID, con audience del POS', async () => {
    const nonce = configDeGoogleParaElPos().nonce!
    verifyIdToken.mockRejectedValue(new Error('Wrong recipient'))
    await expect(leerPaseDeAndroid('tok')).rejects.toMatchObject(invalido)
    expect(verifyIdToken).toHaveBeenCalledWith({ idToken: 'tok', audience: AUD })
    // el nonce no se gasto: Google fallo antes
    verifyIdToken.mockResolvedValue(payload(nonce))
    await expect(leerPaseDeAndroid('tok')).resolves.toBeDefined()
  })
  it('sin audiencia => 503', async () => {
    delete process.env.GOOGLE_POS_ANDROID_AUDIENCE
    await expect(leerPaseDeAndroid('tok')).rejects.toMatchObject({ code: 'GOOGLE_ANDROID_NOT_CONFIGURED', statusCode: 503 })
  })
})

describe('leerPaseDeEscritorio', () => {
  const p = { code: 'c', codeVerifier: 'v'.repeat(50), redirectUri: 'http://127.0.0.1:5123/cb' }
  it('canjea con codeVerifier y redirect_uri exactos y revisa con el id de escritorio', async () => {
    getToken.mockResolvedValue({ tokens: { id_token: 'idt' } })
    verifyIdToken.mockResolvedValue(payload())
    const u = await leerPaseDeEscritorio(p)
    expect(ctor).toHaveBeenCalledWith('desk-id', 'desk-secret')
    expect(getToken).toHaveBeenCalledWith({ code: 'c', codeVerifier: p.codeVerifier, redirect_uri: p.redirectUri })
    expect(verifyIdToken).toHaveBeenCalledWith({ idToken: 'idt', audience: 'desk-id' })
    expect(u.sub).toBe('g-1')
  })
  it('sin id_token => GOOGLE_TOKEN_INVALID', async () => {
    getToken.mockResolvedValue({ tokens: {} })
    await expect(leerPaseDeEscritorio(p)).rejects.toMatchObject(invalido)
  })
  it('getToken falla => GOOGLE_TOKEN_INVALID', async () => {
    getToken.mockRejectedValue(new Error('invalid_grant'))
    await expect(leerPaseDeEscritorio(p)).rejects.toMatchObject(invalido)
  })
  it('sin secreto => 503', async () => {
    delete process.env.GOOGLE_POS_DESKTOP_CLIENT_SECRET
    await expect(leerPaseDeEscritorio(p)).rejects.toMatchObject({ code: 'GOOGLE_DESKTOP_NOT_CONFIGURED', statusCode: 503 })
  })
})

describe('configDeGoogleParaElPos', () => {
  it('sin secreto: windows=false, y el secreto nunca sale', () => {
    delete process.env.GOOGLE_POS_DESKTOP_CLIENT_SECRET
    const c = configDeGoogleParaElPos()
    expect(c.windows).toBe(false)
    expect(JSON.stringify(c)).not.toContain('desk-secret')
  })
  it('con todo: nonce nuevo cada vez, ids de escritorio y audiencia', () => {
    const a = configDeGoogleParaElPos(),
      b = configDeGoogleParaElPos()
    expect(a).toMatchObject({ android: true, windows: true, androidAudience: AUD, desktopClientId: 'desk-id' })
    expect(a.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a.nonce).not.toBe(b.nonce)
  })
  it('nonce sólo con android', () => {
    delete process.env.GOOGLE_POS_ANDROID_AUDIENCE
    const c = configDeGoogleParaElPos()
    expect(c).toMatchObject({ android: false, nonce: null, androidAudience: null })
  })
  it('tope de 10,000: descarta el mas viejo', async () => {
    const primero = configDeGoogleParaElPos().nonce!
    for (let i = 0; i < 10_000; i++) configDeGoogleParaElPos()
    verifyIdToken.mockResolvedValue(payload(primero))
    await expect(leerPaseDeAndroid('tok')).rejects.toMatchObject(invalido)
  })
})
