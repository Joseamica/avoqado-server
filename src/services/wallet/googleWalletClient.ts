import { google, walletobjects_v1 } from 'googleapis'
import { env } from '../../config/env'
import logger from '../../config/logger'
import { ForbiddenError } from '../../errors/AppError'
import { omitirPorDemo } from '../demo/candadoDemo'

/**
 * La credencial de Google Wallet y el cliente de la API.
 *
 * 🔴 Único archivo del dominio que toca secretos, igual que `applePassSigner` del lado
 * de Apple. Todo lo demás —los builders, el emisor— se prueba sin cuenta de servicio.
 *
 * 🔴 La llave es la MISMA que ya usa Firebase: esa cuenta de servicio está registrada
 * como Developer en la consola de Wallet, así que no hay un secreto nuevo que guardar,
 * rotar ni subir a Render. `GOOGLE_WALLET_SERVICE_ACCOUNT_BASE64` existe sólo para
 * poder separarlas algún día sin tocar código.
 */

export interface GoogleWalletCredentials {
  client_email: string
  private_key: string
}

/** El scope que pide la API de pases. */
export const WALLET_SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer'

/**
 * 🔴 Nunca lanza. Se llama desde caminos que cuelgan de un cobro; un base64 corrupto
 * tiene que degradar a "no disponible", no tumbar la venta.
 */
export function googleWalletCredentials(): GoogleWalletCredentials | null {
  const b64 = env.GOOGLE_WALLET_SERVICE_ACCOUNT_BASE64 || env.FIREBASE_SERVICE_ACCOUNT_BASE64
  if (!b64) return null
  try {
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'))
    if (!json?.client_email || !json?.private_key) return null
    return { client_email: json.client_email, private_key: json.private_key }
  } catch (error) {
    logger.error('Credencial de Google Wallet ilegible', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

/**
 * 🔴 Sin una URL pública, la tarjeta de Google es inservible: Google descarga la franja de sellos
 * desde SUS servidores, así que `localhost` no le sirve. Mismo criterio que `passWebServiceURL()`
 * del lado de Apple: mejor no ofrecer la tarjeta que emitir una que nace sin imagen.
 */
export function walletBaseUrl(): string | null {
  const base = env.BASE_URL
  if (!base || /localhost|127\.0\.0\.1/i.test(base)) return null
  return base
}

export function googleWalletAvailable(): boolean {
  return Boolean(env.GOOGLE_WALLET_ISSUER_ID && googleWalletCredentials() && walletBaseUrl())
}

export function issuerId(): string {
  return env.GOOGLE_WALLET_ISSUER_ID as string
}

let cliente: walletobjects_v1.Walletobjects | null = null

/**
 * El cliente autenticado. Se memoiza: `GoogleAuth` renueva el token solo, y crear uno
 * por llamada agregaría un viaje de red a cada sello.
 *
 * Pide el negocio a propósito: un negocio demo no crea ni actualiza nada en la cuenta de Google Wallet de Avoqado
 * (candado de negocios demo; Codex r4, 2). Obligatorio para que una llamada nueva no se lo salte.
 */
export async function walletClient(venueId: string): Promise<walletobjects_v1.Walletobjects> {
  const motivo = await omitirPorDemo('Google Wallet', null, venueId)
  if (motivo === 'sin confirmar') throw new Error('No se pudo confirmar el negocio: Google Wallet no se tocó')
  if (motivo)
    throw new ForbiddenError(
      'En el negocio de demostración no se crean tarjetas de Google Wallet. En tu cuenta de Avoqado sí funciona.',
      'NEGOCIO_DEMO',
    )
  if (cliente) return cliente
  const creds = googleWalletCredentials()
  if (!creds)
    throw new Error('Falta la credencial de Google Wallet (GOOGLE_WALLET_SERVICE_ACCOUNT_BASE64 o FIREBASE_SERVICE_ACCOUNT_BASE64)')

  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: [WALLET_SCOPE] })
  cliente = google.walletobjects({ version: 'v1', auth })
  return cliente
}

/** Sólo para las pruebas: olvida el cliente memoizado. */
export function resetWalletClientForTests(): void {
  cliente = null
}
