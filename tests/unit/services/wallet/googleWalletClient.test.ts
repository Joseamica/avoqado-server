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
import { googleWalletAvailable, googleWalletCredentials, issuerId } from '@/services/wallet/googleWalletClient'
import { env } from '@/config/env'

const CUENTA = { client_email: 'sa@proyecto.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n' }
const B64 = Buffer.from(JSON.stringify({ ...CUENTA, type: 'service_account', project_id: 'p' })).toString('base64')

describe('googleWalletClient', () => {
  const original = { ...env }
  afterEach(() => Object.assign(env, original))

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
})
