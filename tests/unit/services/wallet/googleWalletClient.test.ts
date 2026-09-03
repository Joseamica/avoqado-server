/**
 * La puerta de la credencial de Google Wallet.
 *
 * 🔴 Existe separada del resto por la misma razón que `applePassSigner`: es el ÚNICO
 * archivo que lee secretos, así que todo lo demás del dominio se puede probar sin
 * tener una cuenta de servicio a la mano.
 *
 * 🔴 Y la regla que evita el peor fallo: sin credencial NO revienta. Un negocio que ni
 * siquiera usa tarjetas digitales no puede quedarse sin cobrar porque falte una
 * variable de entorno.
 */
import { googleWalletAvailable, googleWalletCredentials, issuerId, walletBaseUrl } from '@/services/wallet/googleWalletClient'
import { env } from '@/config/env'

const CUENTA = { client_email: 'sa@proyecto.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n' }
const B64 = Buffer.from(JSON.stringify({ ...CUENTA, type: 'service_account', project_id: 'p' })).toString('base64')

describe('googleWalletClient', () => {
  const original = { ...env }
  afterEach(() => Object.assign(env, original))
  // 🔴 Fija el BASE_URL para que las pruebas de "disponible: true" NO dependan de lo
  // que traiga el .env de esta máquina — antes lo hacían, y eso pasaba aquí y fallaba
  // en un servidor sin ese .env (el Alienware lo destapó: `env.BASE_URL as string`
  // reventaba en silencio dentro de un try/catch que se lo tragaba). Las pruebas que
  // SÍ quieren probar el caso sin BASE_URL lo pisan explícitamente.
  beforeEach(() => Object.assign(env, { BASE_URL: 'https://api.avoqado.io' }))

  it('sin issuer NI credencial, no está disponible y no lanza', () => {
    Object.assign(env, { GOOGLE_WALLET_ISSUER_ID: undefined, GOOGLE_WALLET_SERVICE_ACCOUNT_BASE64: undefined, FIREBASE_SERVICE_ACCOUNT_BASE64: undefined })
    expect(googleWalletAvailable()).toBe(false)
    expect(googleWalletCredentials()).toBeNull()
  })

  it('🔴 cae a la cuenta de servicio de Firebase, que es la registrada en la consola', () => {
    Object.assign(env, { GOOGLE_WALLET_ISSUER_ID: '338', GOOGLE_WALLET_SERVICE_ACCOUNT_BASE64: undefined, FIREBASE_SERVICE_ACCOUNT_BASE64: B64 })
    expect(googleWalletAvailable()).toBe(true)
    expect(googleWalletCredentials()).toEqual(CUENTA)
  })

  it('la variable propia MANDA sobre la de Firebase', () => {
    const otra = { client_email: 'otra@x.iam.gserviceaccount.com', private_key: 'k' }
    Object.assign(env, {
      GOOGLE_WALLET_ISSUER_ID: '338',
      GOOGLE_WALLET_SERVICE_ACCOUNT_BASE64: Buffer.from(JSON.stringify(otra)).toString('base64'),
      FIREBASE_SERVICE_ACCOUNT_BASE64: B64,
    })
    expect(googleWalletCredentials()).toEqual(otra)
  })

  it('una credencial ilegible no lanza: se reporta como no disponible', () => {
    Object.assign(env, { GOOGLE_WALLET_ISSUER_ID: '338', GOOGLE_WALLET_SERVICE_ACCOUNT_BASE64: 'no-es-base64-valido{{{', FIREBASE_SERVICE_ACCOUNT_BASE64: undefined })
    expect(() => googleWalletCredentials()).not.toThrow()
    expect(googleWalletCredentials()).toBeNull()
    expect(googleWalletAvailable()).toBe(false)
  })

  it('🔴 un JSON válido pero SIN private_key no es una credencial usable', () => {
    const incompleto = Buffer.from(JSON.stringify({ client_email: 'sa@x.iam.gserviceaccount.com', type: 'service_account' })).toString('base64')
    Object.assign(env, { GOOGLE_WALLET_ISSUER_ID: '338', GOOGLE_WALLET_SERVICE_ACCOUNT_BASE64: incompleto, FIREBASE_SERVICE_ACCOUNT_BASE64: undefined })
    expect(googleWalletCredentials()).toBeNull()
    expect(googleWalletAvailable()).toBe(false)
  })

  it('un JSON válido sin client_email tampoco', () => {
    const incompleto = Buffer.from(JSON.stringify({ private_key: 'k' })).toString('base64')
    Object.assign(env, { GOOGLE_WALLET_ISSUER_ID: '338', GOOGLE_WALLET_SERVICE_ACCOUNT_BASE64: incompleto, FIREBASE_SERVICE_ACCOUNT_BASE64: undefined })
    expect(googleWalletCredentials()).toBeNull()
  })

  it('con issuer pero sin credencial, tampoco está disponible', () => {
    Object.assign(env, { GOOGLE_WALLET_ISSUER_ID: '338', GOOGLE_WALLET_SERVICE_ACCOUNT_BASE64: undefined, FIREBASE_SERVICE_ACCOUNT_BASE64: undefined })
    expect(googleWalletAvailable()).toBe(false)
  })

  it('issuerId devuelve el configurado', () => {
    Object.assign(env, { GOOGLE_WALLET_ISSUER_ID: '3388000000023181777' })
    expect(issuerId()).toBe('3388000000023181777')
  })

  it('🔴 sin BASE_URL, walletBaseUrl() es null — el caso que reventó en un server recién desplegado', () => {
    // Un servidor sin BASE_URL configurado (BASE_URL es .optional() en env.ts) no puede
    // ofrecer la tarjeta de Google: Google la descarga desde SUS servidores, no desde el
    // navegador del cliente, así que no hay "URL del cliente" de respaldo.
    Object.assign(env, { BASE_URL: undefined })
    expect(walletBaseUrl()).toBeNull()
  })

  it('un BASE_URL apuntando a localhost tampoco sirve', () => {
    Object.assign(env, { BASE_URL: 'http://localhost:3000' })
    expect(walletBaseUrl()).toBeNull()
    Object.assign(env, { BASE_URL: 'http://127.0.0.1:3000' })
    expect(walletBaseUrl()).toBeNull()
  })

  it('un BASE_URL público válido se devuelve tal cual', () => {
    Object.assign(env, { BASE_URL: 'https://api.avoqado.io' })
    expect(walletBaseUrl()).toBe('https://api.avoqado.io')
  })

  it('🔴 googleWalletAvailable() exige BASE_URL aunque credencial e issuer estén completos', () => {
    // Antes de este fix, con issuer+credencial pero SIN BASE_URL, googleWalletAvailable()
    // devolvía true y notifyGooglePass/issueGooglePass llegaban hasta el `.replace` sobre
    // `undefined` — el TypeError que el Alienware (sin .env) destapó.
    Object.assign(env, {
      GOOGLE_WALLET_ISSUER_ID: '338',
      GOOGLE_WALLET_SERVICE_ACCOUNT_BASE64: B64,
      FIREBASE_SERVICE_ACCOUNT_BASE64: undefined,
      BASE_URL: undefined,
    })
    expect(googleWalletCredentials()).not.toBeNull() // la credencial sí está completa
    expect(googleWalletAvailable()).toBe(false) // pero sin BASE_URL, no está "disponible"
  })
})
