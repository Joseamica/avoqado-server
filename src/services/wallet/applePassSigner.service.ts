import { PKPass } from 'passkit-generator'
import { solidPng } from './solidPng'
import { stampStripPng } from './stampStripPng'
import { avoqadoLogoPng, avoqadoLogo2xPng } from './avoqadoLogo'
import { env } from '../../config/env'
import { BadRequestError } from '../../errors/AppError'

/**
 * El ÚNICO punto del sistema que toca el certificado de Apple.
 *
 * 🔴 Separado del constructor a propósito. El contenido del pase —donde de verdad
 * se cometen los errores caros— se prueba sin secretos en `applePassBuilder`; aquí
 * sólo vive la criptografía. Mezclarlos significaría que nadie puede correr las
 * pruebas del pase sin tener un certificado de Apple a la mano, ni en CI.
 *
 * Las cinco piezas y por qué son cinco:
 *   APPLE_PASS_TYPE_ID          identifica el tipo de pase; debe coincidir EXACTO
 *                               con el del certificado o el iPhone lo rechaza
 *   APPLE_TEAM_ID               el equipo de desarrollador
 *   APPLE_PASS_CERT_PEM_BASE64  el certificado, sin llave
 *   APPLE_PASS_KEY_PEM_BASE64   la llave privada, sin certificado
 *   APPLE_WWDR_PEM_BASE64       el intermedio de Apple (G4) que encadena la firma
 *
 * 🔴 Certificado y llave son archivos DISTINTOS. `passkit-generator` no come un
 * `.p12`: hay que separarlo con openssl (ver el Plan A, Tarea 0). Pasar el mismo
 * buffer como `signerCert` y `signerKey` —error fácil— falla con un mensaje de
 * OpenSSL que no dice cuál de las dos estaba mal.
 */

export function walletSigningAvailable(): boolean {
  return Boolean(
    env.APPLE_PASS_CERT_PEM_BASE64 &&
      env.APPLE_PASS_KEY_PEM_BASE64 &&
      env.APPLE_WWDR_PEM_BASE64 &&
      env.APPLE_PASS_TYPE_ID &&
      env.APPLE_TEAM_ID,
  )
}

/**
 * 🔴 `brandColor` NO es cosmético: sin `icon.png` Apple RECHAZA el pase.
 *
 * Y lo rechaza en silencio — el archivo se firma bien, la cadena de certificados
 * valida, y el iPhone lo abre como una vista previa de archivo genérica ("Pass ·
 * 4 KB") en vez de ofrecer agregarlo a Wallet. No hay mensaje de error. Costó una
 * prueba en un iPhone real descubrirlo (25-ago).
 *
 * El icono se genera con el color del negocio, no con uno de Avoqado, para que la
 * marca blanca llegue hasta la notificación de la pantalla de bloqueo.
 */
export interface SignPassOptions {
  brandColor?: string | null
  /** Sellos ganados y requeridos. Si se omite, el pase va sin banda. */
  stamps?: { earned: number; required: number }
}

export async function signPass(passJson: Record<string, unknown>, options: SignPassOptions = {}): Promise<Buffer> {
  const { brandColor, stamps } = options
  if (!walletSigningAvailable()) {
    // El mensaje nombra las variables a propósito: quien lea este error en
    // producción necesita saber QUÉ poner, no que "algo falló al firmar".
    throw new BadRequestError(
      'El certificado de Apple no está configurado en este servidor. Faltan una o más de: ' +
        'APPLE_PASS_CERT_PEM_BASE64, APPLE_PASS_KEY_PEM_BASE64, APPLE_WWDR_PEM_BASE64, ' +
        'APPLE_PASS_TYPE_ID, APPLE_TEAM_ID.',
    )
  }

  const pass = new PKPass(
    {
      'pass.json': Buffer.from(JSON.stringify(passJson)),
      // 🔴 OBLIGATORIOS. `icon.png` es el que decide si Wallet acepta el pase;
      // `icon@2x.png` es el que usan las pantallas Retina, o sea todas.
      'icon.png': solidPng(29, 29, brandColor),
      'icon@2x.png': solidPng(58, 58, brandColor),
      // La banda con los sellos dibujados. Es lo que convierte un rectángulo de
      // color con texto en algo que se reconoce como cartilla de un vistazo.
      // Tamaños que Apple espera para storeCard: 375×123 y su @2x.
      // El logo de arriba a la izquierda. Hoy siempre el de Avoqado: `Venue.logo`
      // guarda JPG y Apple sólo acepta PNG en los pases, así que usar el del
      // negocio exige convertirlo en runtime. Pendiente documentado.
      'logo.png': avoqadoLogoPng(),
      'logo@2x.png': avoqadoLogo2xPng(),
      ...(stamps
        ? {
            'strip.png': stampStripPng({ width: 375, height: 123, ...stamps, bgHex: brandColor }),
            'strip@2x.png': stampStripPng({ width: 750, height: 246, ...stamps, bgHex: brandColor }),
          }
        : {}),
    },
    {
      wwdr: Buffer.from(env.APPLE_WWDR_PEM_BASE64 as string, 'base64'),
      signerCert: Buffer.from(env.APPLE_PASS_CERT_PEM_BASE64 as string, 'base64'),
      signerKey: Buffer.from(env.APPLE_PASS_KEY_PEM_BASE64 as string, 'base64'),
      signerKeyPassphrase: env.APPLE_PASS_KEY_PASSWORD,
    },
  )

  return pass.getAsBuffer()
}
