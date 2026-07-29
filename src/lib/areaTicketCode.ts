/**
 * Código de vale de área — formato, verificador y parseo.
 *
 * Spec: `avoqado-android/docs/superpowers/specs/2026-07-28-vales-por-area-y-bascula-design.md` §5.1
 *
 * 🔴 ESTE ARCHIVO ES CONTRATO ESPEJADO CON EL CLIENTE. Android acuña el código y el
 * server lo valida: si las dos implementaciones del verificador difieren en un solo
 * dígito, TODOS los vales se rechazan. El espejo en Android es `AreaTicketCode.kt` +
 * `AreaTicketCodeTest.kt`. Cualquier cambio aquí se porta allá en el MISMO trabajo.
 *
 * ── Formato: `9 PP NNNNNN C` — 10 dígitos ────────────────────────────────────────
 *
 * | parte      | qué es                                                              |
 * |------------|---------------------------------------------------------------------|
 * | `9`        | marcador de espacio de nombres propio                               |
 * | `PP`       | partición del dispositivo, 10..99 (la asigna el server)             |
 * | `NNNNNN`   | contador MONÓTONO del dispositivo, 1..999999. NUNCA se reinicia     |
 * | `C`        | verificador mod-10                                                  |
 *
 * **Por qué 10 dígitos:** no colisiona con ningún simbolismo de producto —
 * EAN-8 (8) ≠ 10 ≠ UPC-A (12) ≠ EAN-13 (13). El escáner busca PRODUCTO primero, así
 * que un vale con largo de producto se escondería en silencio detrás de un GTIN.
 *
 * **Por qué el contador nunca se reinicia:** con reinicio diario, el primer vale del
 * dispositivo 47 de hoy tenía el MISMO código que el primero de ayer, y la ruta sólo
 * recibe `:code` — un vale viejo resolvía la cuenta de otro cliente. Sin reinicio
 * desaparecen de golpe `businessDay`, el cálculo de día operativo, el conflicto de
 * autoridad de reloj cliente/server y el rollover de medianoche.
 *
 * ── 🔴 El verificador NO es seguridad ────────────────────────────────────────────
 *
 * Mod-10 es público y se adivina en diez intentos. Sirve contra errores de dedo al
 * re-teclear un código borroso, nada más. Contra canje ajeno protegen: el rate
 * limiting del endpoint de resolución y el hecho de que un vale ya entregado
 * responde "ya entregado" en vez de devolver la cuenta.
 *
 * ── Qué mod-10, exactamente ──────────────────────────────────────────────────────
 *
 * "mod-10" es ambiguo (Luhn también se llama así). Aquí es el **mod-10 de GS1**, el
 * mismo de EAN/UPC, porque este código vive impreso como código de barras junto a
 * GTINs y es el algoritmo que cualquiera en retail espera:
 *
 *   1. Se numeran los 9 dígitos de datos de DERECHA a IZQUIERDA.
 *   2. Peso 3 a la posición 1 (la más a la derecha), 1 a la 2, 3 a la 3… alternando.
 *   3. `C = (10 - (suma mod 10)) mod 10`.
 *
 * Ejemplo trabajado (el que debe reproducir el test de Android):
 *   datos `947000001` → dígitos d1..d9 de derecha a izquierda: 1,0,0,0,0,0,7,4,9
 *   suma = 1·3 + 0·1 + 0·3 + 0·1 + 0·3 + 0·1 + 7·3 + 4·1 + 9·3 = 3+21+4+27 = 55
 *   C = (10 - (55 mod 10)) mod 10 = (10 - 5) mod 10 = 5
 *   código completo → `9470000015`
 */

/** Largo total del código, verificador incluido. */
export const AREA_TICKET_CODE_LENGTH = 10

/** Primer dígito: el espacio de nombres que separa vales de GTINs. */
export const AREA_TICKET_CODE_PREFIX = '9'

/** Rango de particiones asignables. 90 particiones. */
export const MIN_DEVICE_PARTITION = 10
export const MAX_DEVICE_PARTITION = 99

/** Rango del contador por dispositivo (6 dígitos). */
export const MIN_AREA_TICKET_COUNTER = 1
export const MAX_AREA_TICKET_COUNTER = 999_999

/** Un código válido, ya descompuesto. */
export interface ParsedAreaTicketCode {
  /** El código normalizado (10 dígitos, tal cual se persiste). */
  code: string
  partition: number
  counter: number
  checkDigit: number
}

/**
 * Verificador GS1 mod-10 sobre los 9 dígitos de datos.
 *
 * @param dataDigits exactamente 9 caracteres `0-9` (`9` + `PP` + `NNNNNN`).
 * @throws si no son 9 dígitos — un llamador que pase basura tiene un bug, no un dato.
 */
export function areaTicketCheckDigit(dataDigits: string): number {
  if (!/^\d{9}$/.test(dataDigits)) {
    throw new Error(`areaTicketCheckDigit espera 9 dígitos, recibió "${dataDigits}"`)
  }
  let sum = 0
  // De derecha a izquierda: la posición 1 (la más a la derecha) pesa 3, luego alterna.
  for (let i = 0; i < 9; i++) {
    const digit = dataDigits.charCodeAt(8 - i) - 48
    sum += i % 2 === 0 ? digit * 3 : digit
  }
  return (10 - (sum % 10)) % 10
}

/**
 * Acuña el código para una (partición, contador). El cliente hace lo mismo; el server
 * lo usa para VERIFICAR y para sembrar datos de prueba, nunca para inventarle un
 * código a un dispositivo (el contador vive en el dispositivo).
 */
export function buildAreaTicketCode(partition: number, counter: number): string {
  if (!Number.isInteger(partition) || partition < MIN_DEVICE_PARTITION || partition > MAX_DEVICE_PARTITION) {
    throw new Error(`Partición fuera de rango (${MIN_DEVICE_PARTITION}..${MAX_DEVICE_PARTITION}): ${partition}`)
  }
  if (!Number.isInteger(counter) || counter < MIN_AREA_TICKET_COUNTER || counter > MAX_AREA_TICKET_COUNTER) {
    throw new Error(`Contador fuera de rango (${MIN_AREA_TICKET_COUNTER}..${MAX_AREA_TICKET_COUNTER}): ${counter}`)
  }
  const data = `${AREA_TICKET_CODE_PREFIX}${String(partition).padStart(2, '0')}${String(counter).padStart(6, '0')}`
  return `${data}${areaTicketCheckDigit(data)}`
}

/**
 * ¿Este texto escaneado es un vale (y no un producto)?
 *
 * 🔴 **El largo manda.** Un producto cuyo GTIN empieza en `9` y mide 10 dígitos NO
 * existe como GTIN válido, pero un GTIN de 8/12/13 que empiece en `9` sí — por eso la
 * regla es "10 dígitos Y empieza en 9 Y el verificador cuadra", en ese orden. Barata
 * y determinista: se evalúa antes de tocar la base de datos.
 *
 * Es la MISMA regla que aplica el escáner en el cliente. Si divergen, el POS busca
 * producto donde había vale (o al revés) y el error es invisible.
 */
export function looksLikeAreaTicketCode(raw: string | null | undefined): boolean {
  if (!raw) return false
  const code = raw.trim()
  return code.length === AREA_TICKET_CODE_LENGTH && code.startsWith(AREA_TICKET_CODE_PREFIX) && /^\d+$/.test(code)
}

/**
 * Parsea y VALIDA un código. Devuelve `null` cuando no es un vale válido — nunca
 * lanza, porque el llamador siempre tiene que poder responderle algo legible al
 * cajero ("ese código no es un vale") en vez de un 500.
 */
export function parseAreaTicketCode(raw: string | null | undefined): ParsedAreaTicketCode | null {
  if (!looksLikeAreaTicketCode(raw)) return null
  const code = raw!.trim()

  const data = code.slice(0, 9)
  const checkDigit = code.charCodeAt(9) - 48
  if (areaTicketCheckDigit(data) !== checkDigit) return null

  const partition = Number(code.slice(1, 3))
  const counter = Number(code.slice(3, 9))
  if (partition < MIN_DEVICE_PARTITION || partition > MAX_DEVICE_PARTITION) return null
  if (counter < MIN_AREA_TICKET_COUNTER || counter > MAX_AREA_TICKET_COUNTER) return null

  return { code, partition, counter, checkDigit }
}
