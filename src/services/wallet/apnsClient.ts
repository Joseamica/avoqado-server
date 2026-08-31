import { connect, constants } from 'http2'
import { env } from '../../config/env'
import logger from '../../config/logger'

/**
 * El canal por el que se despierta el iPhone de un cliente.
 *
 * 🔴 Tres cosas que cuesta descubrir si se hacen mal, porque ninguna da error:
 *
 * 1. **El tema es el PASS TYPE ID, no el bundle de una app.** Con el bundle, Apple
 *    acepta la conexión y descarta el aviso: cero errores, cero actualizaciones.
 * 2. **El cuerpo va VACÍO** (`{"aps":{}}`). No es una notificación que el cliente vea:
 *    es un golpecito en el hombro para que Wallet venga a preguntar qué cambió. El
 *    saldo NUNCA viaja aquí.
 * 3. **Se usa el MISMO certificado que firma los pases.** No hace falta pedirle nada
 *    nuevo a Apple, que es la duda que frena este trabajo la primera vez.
 */

const HOST_PROD = 'https://api.push.apple.com'
const HOST_SANDBOX = 'https://api.sandbox.push.apple.com'

export interface PushResult {
  ok: boolean
  /** Apple dice que este aparato ya no tiene la tarjeta: hay que olvidarlo. */
  gone?: boolean
  status?: number
}

export function apnsAvailable(): boolean {
  return Boolean(env.APPLE_PASS_CERT_PEM_BASE64 && env.APPLE_PASS_KEY_PEM_BASE64 && env.APPLE_PASS_TYPE_ID)
}

/**
 * Manda el sobre vacío a UN aparato.
 *
 * Nunca lanza: devuelve el resultado. Quien llama decide qué hacer, y lo que no puede
 * pasar es que un fallo de red tumbe el cobro desde el que se llamó.
 */
export async function sendSilentPush(deviceToken: string): Promise<PushResult> {
  if (!apnsAvailable()) return { ok: false }

  const host = env.NODE_ENV === 'production' ? HOST_PROD : HOST_SANDBOX

  return new Promise<PushResult>(resolve => {
    let resuelto = false
    const terminar = (r: PushResult) => {
      if (resuelto) return
      resuelto = true
      resolve(r)
    }

    let client: ReturnType<typeof connect> | null = null
    try {
      client = connect(host, {
        cert: Buffer.from(env.APPLE_PASS_CERT_PEM_BASE64 as string, 'base64'),
        key: Buffer.from(env.APPLE_PASS_KEY_PEM_BASE64 as string, 'base64'),
        passphrase: env.APPLE_PASS_KEY_PASSWORD,
      })

      client.on('error', error => {
        logger.warn('No se pudo abrir el canal con Apple', { error: (error as Error).message })
        terminar({ ok: false })
      })

      const req = client.request({
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
        // 🔴 El tema es el identificador del PASE. Con el bundle de una app, Apple
        // acepta y descarta en silencio.
        'apns-topic': env.APPLE_PASS_TYPE_ID as string,
        'apns-push-type': 'background',
        // 5 es lo que Apple pide para un aviso silencioso; con 10 lo rechaza.
        'apns-priority': '5',
      })

      let status = 0
      req.on('response', headers => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0)
        // APNS devuelve un JSON con la razón cuando rechaza el push. En un
        // ClientHttp2Stream, `end` no llega mientras el readable quede pausado;
        // drenarlo evita dejar esta promesa viva para siempre en respuestas 4xx.
        req.resume()
      })
      req.on('error', error => {
        logger.warn('Falló el aviso a un aparato', { error: (error as Error).message })
        terminar({ ok: false })
      })
      req.on('end', () => {
        client?.close()
        // 410 = el aparato ya no tiene esta tarjeta. Es la señal para olvidarlo.
        terminar({ ok: status === 200, gone: status === 410, status })
      })

      // El cuerpo vacío ES el mensaje.
      req.end(JSON.stringify({ aps: {} }))
    } catch (error) {
      logger.warn('Falló el envío del aviso', { error: error instanceof Error ? error.message : String(error) })
      client?.close()
      terminar({ ok: false })
    }
  })
}
