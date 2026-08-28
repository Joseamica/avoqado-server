// src/services/auth/successorCrypto.ts
/**
 * Cifrado del sucesor del refresh token durante la ventana de retransmisión (60 s).
 *
 * Por qué existe: el servidor rota el refresh, responde, y la respuesta se pierde (red
 * intermitente en el mostrador). El cliente reintenta con un token ya consumido. Sin
 * guardar el sucesor en algún lado, ese reintento legítimo se ve IDÉNTICO a un robo — no
 * hay forma de distinguirlos. Guardarlo cifrado (en vez de en claro) es lo que hace que
 * tenerlo en la misma fila no sea, por sí solo, una filtración.
 *
 * AES-256-GCM (AEAD) — condición 4 de la auditoría:
 *
 * 1. **La llave vive FUERA de Postgres.** `SESSION_SUCCESSOR_ENC_KEY` es una variable de
 *    entorno (`src/config/env.ts`), nunca una columna ni una fila de configuración en la
 *    misma base. Si la base se filtrara, el atacante tendría el ciphertext pero no la
 *    llave — cifrar no serviría de nada si las dos cosas vivieran juntas.
 * 2. **El AAD ata el ciphertext a su fila** (`grantId.familyId.sessionId`): copiar el
 *    valor de `successorEnc` a otra fila (otro grant, otra sesión) hace que GCM rechace
 *    el tag de autenticación al descifrar, en vez de devolver un sucesor que no le
 *    pertenece a esa fila.
 * 3. **Nunca en logs.** Este módulo no llama a `logger.*` — es responsabilidad de quien
 *    lo consume (`refreshGrant.service.ts`) no volcar ni el ciphertext ni el token
 *    descifrado en ningún log.
 * 4. **Borrado físico al vencer** — no es trabajo de este módulo: lo hace
 *    `limpiarSucesoresVencidos()` en `refreshGrant.service.ts`, enganchado a un job.
 *
 * Formato del ciphertext empaquetado: `v1.<iv-b64url>.<tag-b64url>.<ct-b64url>`. El
 * prefijo de versión permite rotar de algoritmo o de llave más adelante sin invalidar en
 * silencio lo que ya hay escrito — un ciphertext viejo sin prefijo reconocido falla alto
 * y claro en vez de descifrarse mal.
 *
 * 🔴 La llave es OPCIONAL a propósito (ver `src/config/env.ts`): si `SESSION_SUCCESSOR_ENC_KEY`
 * no está configurada, `cifrarSucesor`/`descifrarSucesor` lanzan. Es responsabilidad del
 * LLAMADOR comprobar `sucesorCifradoDisponible()` antes de invocarlas, para que la ausencia
 * de la llave jamás rompa el arranque del servidor ni el refresh en sí — sólo desactiva la
 * retransmisión (un entorno sin la llave se comporta como hoy: un reintento se trata como
 * reutilización real).
 *
 * 🔴 [Auditoría Task 9, hallazgo crítico] `sucesorCifradoDisponible()` también valida el
 * FORMATO de la llave (hex de 32 bytes), no sólo su presencia — segunda capa detrás del
 * `.regex` de `env.ts`: si algún día `env` llega mockeado o construido de otra forma con un
 * valor de 64 chars no-hex, una llave mal formada se comporta como "sin llave" (retransmisión
 * desactivada) en vez de que `crypto.createCipheriv` lance sin captura a media rotación.
 */
import crypto from 'crypto'
import { env } from '@/config/env'

const ALGORITMO = 'aes-256-gcm'
const IV_BYTES = 12
const VERSION = 'v1'

export interface SucesorAAD {
  grantId: string
  familyId: string
  sessionId: string
}

function aad(datos: SucesorAAD): Buffer {
  return Buffer.from(`${datos.grantId}.${datos.familyId}.${datos.sessionId}`, 'utf8')
}

const FORMATO_LLAVE = /^[0-9a-f]{64}$/i

function llaveValida(hex: string | undefined): hex is string {
  return typeof hex === 'string' && FORMATO_LLAVE.test(hex)
}

function llave(): Buffer {
  const hex = env.SESSION_SUCCESSOR_ENC_KEY
  if (!llaveValida(hex)) {
    throw new Error('SESSION_SUCCESSOR_ENC_KEY no está configurada o no es hex de 32 bytes — no se puede cifrar/descifrar el sucesor')
  }
  return Buffer.from(hex, 'hex')
}

/** true si hay llave configurada Y con formato válido. El llamador la usa para decidir si guarda sucesor cifrado. */
export function sucesorCifradoDisponible(): boolean {
  return llaveValida(env.SESSION_SUCCESSOR_ENC_KEY)
}

/** Cifra el token sucesor. Lanza si `SESSION_SUCCESSOR_ENC_KEY` no está configurada. */
export function cifrarSucesor(tokenSucesor: string, datosAAD: SucesorAAD): string {
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGORITMO, llave(), iv)
  cipher.setAAD(aad(datosAAD))
  const ciphertext = Buffer.concat([cipher.update(tokenSucesor, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.')
}

/**
 * Descifra el sucesor. Lanza (nunca devuelve basura) si: la llave no está configurada, el
 * formato no es el esperado, el AAD no coincide con la fila (`datosAAD` distinto al usado
 * al cifrar), o el ciphertext/tag fueron manipulados — las tres últimas las detecta GCM al
 * verificar el tag de autenticación en `decipher.final()`.
 */
export function descifrarSucesor(ciphertextEmpaquetado: string, datosAAD: SucesorAAD): string {
  const partes = ciphertextEmpaquetado.split('.')
  if (partes.length !== 4 || partes[0] !== VERSION) {
    throw new Error('Formato de sucesor cifrado inválido')
  }
  const [, ivB64, tagB64, ctB64] = partes
  const iv = Buffer.from(ivB64, 'base64url')
  const tag = Buffer.from(tagB64, 'base64url')
  const ciphertext = Buffer.from(ctB64, 'base64url')

  const decipher = crypto.createDecipheriv(ALGORITMO, llave(), iv)
  decipher.setAAD(aad(datosAAD))
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}
