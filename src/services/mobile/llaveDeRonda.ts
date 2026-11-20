import { createHash, randomUUID } from 'crypto'

/**
 * La llave de renglón (`externalId`) de una RONDA de Mesas: `sync:<llave de la ronda>:<n>`.
 *
 * D7 «Anular producto», decisión 1 = A acotada (founder por delegación, 20-nov-2026;
 * `docs/audit/2026-11-20-anular-producto-enviado/decisiones-para-el-founder.md` del workspace). En el camino de rondas (la ruta con
 * red de Mesas y su cola sin red) el servidor sólo acepta esta forma; cualquier otra (sin llave, vacía, con espacios, propia de un
 * sistema externo o de OTRA ronda) se reemplaza por la que arma con la llave de la ronda y la posición del renglón.
 *
 * Por qué: la llave sirve para dos cosas que comparan entre cuentas: que el reenvío de una ronda no la duplique (ni en una cuenta
 * aparte cuando la mesa ya se cobró) y que lo anulado no vuelva (la lápida). Con etiquetas libres, una ajena con espacios o repetida
 * entre mesas confundía cuentas (Codex r5 #5, r6 #1-#3). Con la llave de la ronda, cada etiqueta nombra a ESA ronda y nada más.
 *
 * Compatibilidad, medida en el código de cada app viva (20-nov): la TPV desde 2.7.1 (`TablesRepository.addItems`), ANDROID/WINDOWS
 * desde 2.19.1 y iOS desde 1.12 (`RondaConLlave`) ya mandan `sync:<id del intent>:<índice>` en línea y en la cola, con el mismo id:
 * pasan intactas. Un sistema externo con sus propias etiquetas pierde la protección contra duplicados (hoy no hay ninguno; medido en
 * producción: 0 llaves `sync:` repetidas o con espacios). Las llaves de Mostrador (UUID) y de combos de otros caminos no pasan por aquí.
 *
 * Módulo puro y sin dependencias del servicio de la TPV: varias pruebas simulan ese módulo entero.
 */
const FORMA_DE_RONDA = /^sync:([^:\s]+):(\d+)$/

/** La llave de la ronda (`K`) si `externalId` tiene la forma `sync:K:<n>`; si no, `null`. */
export function rondaDeLaLlave(externalId: unknown): string | null {
  if (typeof externalId !== 'string') return null
  return FORMA_DE_RONDA.exec(externalId)?.[1] ?? null
}

/**
 * Cada renglón con su llave de ronda. Pasa intacta la que ya es `sync:<llaveDeLaRonda>:<n>` (la primera vez que aparece; aunque `n`
 * no sea su posición). Las demás toman `sync:<llaveDeLaRonda>:<posición>`, o, si esa ya la reclamó otro renglón, la siguiente libre
 * después del final de la ronda. Determinista: el mismo envío da las mismas llaves, así el reenvío deduplica. No muta la entrada.
 */
export function llavesDeLaRonda<T extends { externalId?: unknown }>(
  items: readonly T[],
  rondaPedida: string,
): (Omit<T, 'externalId'> & { externalId: string })[] {
  const llaveDeLaRonda = rondaSegura(rondaPedida)
  const usadas = new Set<string>()
  const aceptadas = items.map(item => {
    const llave = item.externalId
    if (typeof llave !== 'string' || rondaDeLaLlave(llave) !== llaveDeLaRonda || usadas.has(llave)) return null
    usadas.add(llave)
    return llave
  })
  let siguiente = items.length
  return items.map((item, posicion) => {
    let llave = aceptadas[posicion]
    if (!llave) {
      llave = `sync:${llaveDeLaRonda}:${posicion}`
      while (usadas.has(llave)) llave = `sync:${llaveDeLaRonda}:${siguiente++}`
      usadas.add(llave)
    }
    return { ...item, externalId: llave }
  })
}

/**
 * La llave de la ronda que llega por la ruta CON RED (no trae id de intent): la de la primera etiqueta con la forma de Avoqado. Las
 * apps mandan la misma `sync:<id>:<n>` en línea y en la cola, así que la ronda en línea y su reenvío por la cola dan las mismas llaves.
 * Si ninguna la tiene, una nueva: ese envío no se puede reconocer si se repite (es la consecuencia aceptada de la decisión 1).
 */
export function llaveDeRondaEnLinea(items: readonly { externalId?: unknown }[]): string {
  for (const item of items) {
    const ronda = rondaDeLaLlave(item.externalId)
    if (ronda) return ronda
  }
  return randomUUID()
}

/**
 * La llave de la ronda tal como va dentro de la etiqueta. El id de un intent sólo se valida por largo (1-64), y uno con `:` o espacios
 * armaría etiquetas que ya no tienen la forma de ronda: se usa en su lugar un resumen fijo del id (el mismo en cada reenvío). Los UUID
 * de las apps pasan intactos.
 */
export function rondaSegura(ronda: string): string {
  return /^[^:\s]+$/.test(ronda) ? ronda : `h${createHash('sha256').update(ronda).digest('hex').slice(0, 32)}`
}

/** ¿Es una llave de ronda? La lápida y la búsqueda de una ronda ya guardada sólo trabajan con éstas (nunca UUID de Mostrador). */
export function esLlaveDeRonda(externalId: unknown): externalId is string {
  return rondaDeLaLlave(externalId) !== null
}
