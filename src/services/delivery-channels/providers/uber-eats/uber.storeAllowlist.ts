/**
 * Candado de tiendas escribibles de Uber Eats (spec 2026-08-17, paso 1).
 *
 * POR QUÉ EXISTE: el sandbox de Uber NO aísla producción — con token de sandbox,
 * un PUT /menus modificó el menú EN VIVO de un restaurante real (verificado
 * 2026-08-17). El dominio del entorno no garantiza aislamiento, así que ninguna
 * escritura (accept/deny/cancel/menú/status/pos_data) sale sin que la tienda esté
 * EXPLÍCITAMENTE autorizada por env var. Vacío ⇒ cero escrituras (default-deny).
 * Las lecturas (GET) quedan fuera del candado a propósito.
 *
 * Módulo PURO sin efectos secundarios (regla del repo: importable desde tests sin
 * arrastrar @/config/env). El caller resuelve el env var y pasa el valor crudo.
 */
export type UberEnvironment = 'SANDBOX' | 'PRODUCTION'

export class UberStoreWriteBlockedError extends Error {
  readonly storeId: string
  readonly environment: UberEnvironment
  constructor(storeId: string, environment: UberEnvironment) {
    const envVar = `UBER_WRITABLE_STORE_IDS_${environment}`
    super(
      `Escritura a Uber BLOQUEADA por el candado de tiendas: store "${storeId || '(vacío)'}" no está ` +
        `en ${envVar}. Default-deny: sin lista no hay escrituras. Si es una tienda de PRUEBA legítima, ` +
        `agrégala a ${envVar}; si no lo es, este bloqueo acaba de evitar tocar un comercio real.`,
    )
    this.name = 'UberStoreWriteBlockedError'
    this.storeId = storeId
    this.environment = environment
  }
}

/** CSV → Set normalizado (trim + minúsculas). Vacío/ausente ⇒ Set vacío. */
export function parseWritableStoreIds(raw: string | undefined | null): Set<string> {
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(s => s.length > 0),
  )
}

/** Lanza UberStoreWriteBlockedError salvo que la tienda esté autorizada. */
export function assertStoreWritable(storeId: string, allowlist: Set<string>, environment: UberEnvironment): void {
  const normalized = typeof storeId === 'string' ? storeId.trim().toLowerCase() : ''
  if (!normalized || !allowlist.has(normalized)) {
    throw new UberStoreWriteBlockedError(typeof storeId === 'string' ? storeId : String(storeId), environment)
  }
}
