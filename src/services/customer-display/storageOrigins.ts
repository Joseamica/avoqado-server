// src/services/customer-display/storageOrigins.ts
import * as admin from 'firebase-admin'
import { getFirebaseApp } from '@/config/firebase'

/**
 * Las URLs de storage que este servidor reconoce como SUYAS.
 *
 * 🔴 Cuatro reglas, cada una con su prueba:
 * - el host: la autoridad CRUDA tiene que ser EXACTAMENTE uno de los dos hosts que genera nuestro código (sin usuario,
 *   sin puerto, sin `%`, en minúsculas). Se compara con `===`, nunca con `includes` (`storage.googleapis.com.evil.test`),
 *   y sobre el texto crudo porque el bucket y la ruta también salen de ahí: el parser corta la autoridad en la barra
 *   invertida, y `https://storage.googleapis.com\otro-bucket/{bucket}/x` pide un objeto de `otro-bucket`;
 * - el bucket es el EXACTO con el que Firebase escribe, recibido por parámetro (ver `configuredStorageBucket`);
 * - la RUTA se revisa sobre el texto crudo, segmento por segmento, porque `new URL()` resuelve `..` y `%2e%2e` antes
 *   de que uno pueda mirarlos;
 * - y por lo mismo se rechaza el texto que el parser altera antes de resolver (tabuladores, saltos de línea,
 *   espacios en los extremos): si el texto crudo y la URL parseada no son la misma ruta, revisar el crudo no sirve.
 */
export interface StorageRef {
  bucket: string
  path: string
  token?: string
}

const ADMIN_HOST = 'storage.googleapis.com'
const BROWSER_HOST = 'firebasestorage.googleapis.com'

/** El bucket con el que escribe `uploadFileToStorage`. Sin Firebase inicializado, no hay bucket que reconocer. */
export function configuredStorageBucket(): string | null {
  const app = getFirebaseApp()
  if (!app) return null
  try {
    // La misma cadena que `uploadFileToStorage` (`getStorageBucket()` = `admin.storage(app)`) → `.bucket().name`.
    return admin.storage(app).bucket().name || null
  } catch {
    return null
  }
}

/**
 * La autoridad y la ruta tal como llegaron en el texto (sin normalizar), o null si el texto trae fragmento o no tiene la
 * forma esperada. La autoridad se captura ancha a propósito: quien decide si es nuestra es la comparación EXACTA.
 */
function rawPartsOf(raw: string): { authority: string; path: string } | null {
  const m = raw.match(/^https:\/\/([^/?#]*)(\/[^?#]*)?(\?[^#]*)?$/)
  return m ? { authority: m[1], path: m[2] ?? '' } : null
}

/**
 * ¿Trae algo que `new URL()` BORRA o recorta en silencio? Tabuladores y saltos de línea en cualquier parte, y
 * espacios en los extremos. Con ellos el texto crudo deja de ser la URL que de verdad se pide: `.\t.` no parece un
 * recorrido, pero el parser le quita el tabulador y lo resuelve como `..`. Nuestras URLs nunca los traen, así que se
 * rechaza cualquier carácter de control (no sólo los tres que hoy se borran) y cualquier espacio en los extremos.
 */
function hasCharsTheParserStrips(raw: string): boolean {
  if (raw !== raw.trim()) return true
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/** Cada segmento, DECODIFICADO, tiene que ser un nombre normal: ni vacío, ni `.`, ni `..`, ni con separadores dentro. */
function segmentsAreSafe(segments: string[]): boolean {
  if (segments.length === 0) return false
  for (const segment of segments) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return false
    }
    if (decoded === '' || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) return false
  }
  return true
}

export function recognizeStorageUrl(raw: string | null | undefined, bucket: string | null): StorageRef | null {
  if (!raw || !bucket) return null
  if (hasCharsTheParserStrips(raw)) return null
  const parts = rawPartsOf(raw)
  if (parts === null) return null
  // 🔴 Exactamente el host que escribe nuestro código. Un `\`, un `@`, un `:443`, un `%2e` o una mayúscula hacen que
  // la autoridad cruda y la que ve el parser dejen de coincidir, y con ellas el bucket y la ruta.
  if (parts.authority !== ADMIN_HOST && parts.authority !== BROWSER_HOST) return null
  const rawPath = parts.path

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '' || url.hash !== '') return null

  if (url.hostname === ADMIN_HOST) {
    if (url.search) return null
    // Sobre el texto CRUDO: /{bucket}/{segmentos…}
    const [vacio, first, ...rest] = rawPath.split('/')
    if (vacio !== '' || first !== bucket || !segmentsAreSafe(rest)) return null
    return { bucket, path: rest.map(s => decodeURIComponent(s)).join('/') }
  }

  if (url.hostname === BROWSER_HOST) {
    // Sobre el texto CRUDO: /v0/b/{bucket}/o/{objeto codificado, UN solo segmento}
    const match = rawPath.match(/^\/v0\/b\/([^/]+)\/o\/([^/]+)$/)
    if (!match) return null
    const [, urlBucket, encoded] = match
    if (urlBucket !== bucket) return null

    // Sólo `alt` y `token`, y cada una UNA vez: `get()` devuelve el primer valor, y con claves repetidas lo que
    // revisamos aquí y lo que lee otro cliente pueden ser distintos.
    const allowed = new Set(['alt', 'token'])
    for (const key of url.searchParams.keys()) {
      if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return null
    }
    if (url.searchParams.get('alt') !== 'media') return null

    let path: string
    try {
      path = decodeURIComponent(encoded)
    } catch {
      return null
    }
    // El nombre del objeto decodificado se revisa con la misma regla, ahora partido por sus `/` reales.
    if (!segmentsAreSafe(path.split('/'))) return null

    const token = url.searchParams.get('token')
    return token ? { bucket, path, token } : { bucket, path }
  }

  return null
}
