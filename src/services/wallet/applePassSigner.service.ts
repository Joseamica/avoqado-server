import { Worker } from 'node:worker_threads'
import { resolve } from 'node:path'
import { solidPng } from './solidPng'
import { stampStripPng } from './stampStripPng'
import { avoqadoLogoPng, avoqadoLogo2xPng } from './avoqadoLogo'
import { fetchDecodedPng, fetchPng } from './remotePng'
import { WalletStampShape } from '@prisma/client'
import { env } from '../../config/env'
import AppError, { BadRequestError } from '../../errors/AppError'
import { APPLE_PASS_TASK, type CertificadosDelPase } from '../../workers/applePass.worker'

/** Un pase pesa decenas de KB; si el hilo aparte no contesta en este tiempo, algo está roto. */
export const FIRMA_TIMEOUT_MS = 20_000
/** Hilos de firma a la vez (cada uno ~30-50 MB). Las rutas son públicas: una ráfaga espera su turno, no agota la memoria. */
export const FIRMAS_A_LA_VEZ = 2
/** Cuántos pueden esperar turno. Más allá se contesta «ocupado» al momento (Apple reintenta solo). */
export const FIRMAS_EN_ESPERA_MAX = 20
/** Cuánto puede esperar un pedido su turno antes de rendirse. */
export const ESPERA_DE_FIRMA_MS = 20_000

let firmasVivas = 0
const enEspera: Array<() => void> = []

function firmaOcupada(): AppError {
  return new AppError(
    'Estamos generando muchas tarjetas en este momento. Intenta de nuevo en unos segundos.',
    503,
    true,
    'WALLET_FIRMA_OCUPADA',
  )
}

/**
 * Aparta un turno de firma y devuelve cómo soltarlo (una sola vez). Se toma ANTES de bajar imágenes o preparar
 * nada (Codex D5 r1 P1): quien espera no retiene buffers. La fila tiene tope y plazo.
 * 🔴 Al soltar, el turno pasa DIRECTO al siguiente de la fila sin descontarse (r2 P1): si se descontara y luego
 * se despertara al siguiente, un recién llegado podría colarse en medio y quedarían tres hilos.
 */
async function tomarTurnoDeFirma(): Promise<() => void> {
  if (firmasVivas < FIRMAS_A_LA_VEZ) firmasVivas++
  else {
    if (enEspera.length >= FIRMAS_EN_ESPERA_MAX) throw firmaOcupada()
    // El turno llega ya contado: quien lo suelta no lo descuenta.
    await new Promise<void>((resolver, rechazar) => {
      const turno = () => {
        clearTimeout(reloj)
        resolver()
      }
      const reloj = setTimeout(() => {
        const i = enEspera.indexOf(turno)
        if (i >= 0) enEspera.splice(i, 1)
        rechazar(firmaOcupada())
      }, ESPERA_DE_FIRMA_MS)
      enEspera.push(turno)
    })
  }
  let suelto = false
  return () => {
    if (suelto) return
    suelto = true
    const siguiente = enEspera.shift()
    if (siguiente) siguiente()
    else firmasVivas--
  }
}

/**
 * Arma y firma el .pkpass en un hilo aparte (D5, 4-nov-2026): passkit-generator firma con node-forge, en
 * JavaScript puro, y en el hilo principal retenía 0.3-0.9 s por credencial en Render (1.4-1.9 s el 2-nov),
 * con todos los cobros esperando.
 * `resultado` contesta al pedido (a más tardar en FIRMA_TIMEOUT_MS); `cerrado` se cumple cuando el hilo ya salió
 * (r2 P2): el turno se suelta con `cerrado`, para que el tope cuente hilos vivos y no respuestas pendientes.
 */
function firmarEnHilo(
  archivos: Record<string, Buffer>,
  certificados: CertificadosDelPase,
): { resultado: Promise<Buffer>; cerrado: Promise<void> } {
  const execArgv = __filename.endsWith('.ts') ? ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register'] : undefined
  const hilo = new Worker(resolve(__dirname, `../../workers/applePass.worker.${__filename.endsWith('.ts') ? 'ts' : 'js'}`), {
    workerData: { task: APPLE_PASS_TASK, archivos, certificados },
    resourceLimits: { maxOldGenerationSizeMb: 256 },
    ...(execArgv ? { execArgv } : {}),
  })
  const cerrado = new Promise<void>(r => hilo.once('exit', () => r()))
  const resultado = new Promise<Buffer>((resolver, rechazar) => {
    let listo = false
    const terminar = (fn: () => void) => {
      if (listo) return
      listo = true
      clearTimeout(reloj)
      fn()
      void Promise.resolve(hilo.terminate()).catch(() => undefined)
    }
    const reloj = setTimeout(
      () => terminar(() => rechazar(new Error(`La firma del pase no terminó en ${FIRMA_TIMEOUT_MS} ms`))),
      FIRMA_TIMEOUT_MS,
    )
    hilo.once('message', (m: { ok?: boolean; bytes?: ArrayBuffer; message?: string }) =>
      terminar(() => (m.ok && m.bytes ? resolver(Buffer.from(m.bytes)) : rechazar(new Error(m.message ?? 'No se pudo firmar el pase')))),
    )
    hilo.once('error', error => terminar(() => rechazar(error)))
    hilo.once('exit', code => terminar(() => rechazar(new Error(`El hilo de la firma salió (${code}) sin pase`))))
  })
  return { resultado, cerrado }
}

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
  /**
   * El diseño que configuro el negocio. Cada pieza es opcional y cae a un respaldo
   * de Avoqado: un negocio a medio configurar emite una credencial que funciona.
   */
  design?: {
    logoUrl?: string | null
    iconUrl?: string | null
    stripColor?: string | null
    stampFilledColor?: string | null
    stampEmptyColor?: string | null
    stampShape?: WalletStampShape | null
    /** El sello propio del negocio. Cuando existe, manda sobre `stampShape`. */
    stampImageUrl?: string | null
  }
}

export async function signPass(passJson: Record<string, unknown>, options: SignPassOptions = {}): Promise<Buffer> {
  if (!walletSigningAvailable()) {
    // El mensaje nombra las variables a propósito: quien lea este error en
    // producción necesita saber QUÉ poner, no que "algo falló al firmar".
    throw new BadRequestError(
      'El certificado de Apple no está configurado en este servidor. Faltan una o más de: ' +
        'APPLE_PASS_CERT_PEM_BASE64, APPLE_PASS_KEY_PEM_BASE64, APPLE_WWDR_PEM_BASE64, ' +
        'APPLE_PASS_TYPE_ID, APPLE_TEAM_ID.',
    )
  }
  const soltar = await tomarTurnoDeFirma()
  let firma: ReturnType<typeof firmarEnHilo>
  try {
    const { archivos, certificados } = await prepararPase(passJson, options)
    firma = firmarEnHilo(archivos, certificados)
  } catch (error) {
    soltar()
    throw error
  }
  // El turno se suelta cuando el hilo YA salió, aunque el pedido haya contestado antes (plazo vencido).
  void firma.cerrado.then(soltar)
  return firma.resultado
}

async function prepararPase(
  passJson: Record<string, unknown>,
  options: SignPassOptions,
): Promise<{ archivos: Record<string, Buffer>; certificados: CertificadosDelPase }> {
  const { brandColor, stamps, design } = options

  // 🔴 En paralelo y con respaldo. Si el logo del negocio no carga, el pase sale con
  // el de Avoqado — feo para su marca, pero se emite. Bloquear la credencial de un
  // cliente porque una imagen dio 404 cambia un problema estetico por uno operativo.
  const [logoPropio, iconoPropio, selloPropio] = await Promise.all([
    fetchPng(design?.logoUrl),
    fetchPng(design?.iconUrl),
    fetchDecodedPng(design?.stampImageUrl),
  ])

  // El icono NUNCA falta: sin el, Apple rechaza el pase EN SILENCIO. Cuando el
  // negocio no subio uno, se genera de color solido con su color de marca.
  const icono = iconoPropio ?? solidPng(29, 29, brandColor)
  const icono2x = iconoPropio ?? solidPng(58, 58, brandColor)

  const bandaBase = {
    bgHex: design?.stripColor ?? null,
    filledHex: design?.stampFilledColor ?? brandColor ?? null,
    emptyHex: design?.stampEmptyColor ?? null,
    shape: design?.stampShape ?? null,
    stampImage: selloPropio,
  }

  return {
    archivos: {
      'pass.json': Buffer.from(JSON.stringify(passJson)),
      // 🔴 OBLIGATORIOS. `icon.png` es el que decide si Wallet acepta el pase;
      // `icon@2x.png` es el que usan las pantallas Retina, o sea todas.
      // El icono chico va del color del negocio: es lo que aparece en la lista de
      // pases y en la notificación, donde no hay nada más que lo identifique.
      'icon.png': icono,
      'icon@2x.png': icono2x,
      // La banda con los sellos dibujados. Es lo que convierte un rectángulo de
      // color con texto en algo que se reconoce como cartilla de un vistazo.
      // Tamaños que Apple espera para storeCard: 375×123 y su @2x.
      // El logo de arriba a la izquierda. Hoy siempre el de Avoqado: `Venue.logo`
      // guarda JPG y Apple sólo acepta PNG en los pases, así que usar el del
      // negocio exige convertirlo en runtime. Pendiente documentado.
      // El logo del NEGOCIO si lo subio; el de Avoqado como respaldo.
      'logo.png': logoPropio ?? avoqadoLogoPng(),
      'logo@2x.png': logoPropio ?? avoqadoLogo2xPng(),
      ...(stamps
        ? {
            // El color del negocio va en los SELLOS, no en el fondo: es donde la
            // mirada cae, y deja la tarjeta legible en vez de saturada.
            'strip.png': stampStripPng({ width: 375, height: 123, ...stamps, ...bandaBase }),
            'strip@2x.png': stampStripPng({ width: 750, height: 246, ...stamps, ...bandaBase }),
          }
        : {}),
    },
    certificados: {
      wwdr: Buffer.from(env.APPLE_WWDR_PEM_BASE64 as string, 'base64'),
      signerCert: Buffer.from(env.APPLE_PASS_CERT_PEM_BASE64 as string, 'base64'),
      signerKey: Buffer.from(env.APPLE_PASS_KEY_PEM_BASE64 as string, 'base64'),
      signerKeyPassphrase: env.APPLE_PASS_KEY_PASSWORD,
    },
  }
}
