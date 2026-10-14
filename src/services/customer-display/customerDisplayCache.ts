// src/services/customer-display/customerDisplayCache.ts
// Sólo TIPOS: este módulo no carga nada en tiempo de ejecución. Así quien cambia una terminal de negocio (el gancho y
// sus escritores, también un script) la invalida sin importar el servicio del diseño ni lo que éste arrastra.
import type { FichaEfectiva } from './customerDisplayDesign.effective'

/**
 * Caché de la ficha, 60 s, POR TERMINAL Y VENUE (spec §5.3). Sirve al poll de la tablet, NO al dashboard.
 *
 * 🔴 Tres reglas, cada una con su prueba:
 * - la llave lleva el venue: una ficha armada antes de un traslado no se entrega después de él, aunque esta
 *   instancia no se haya enterado del traslado;
 * - tope de entradas y purga de vencidas: la memoria del proceso no crece con el número de terminales;
 * - un cálculo sólo se guarda si su terminal NO se invalidó mientras corría. La generación vive SÓLO mientras hay
 *   cálculos en vuelo de esa terminal (no por reloj: un cálculo lento puede durar lo que sea), y se borra cuando el
 *   último termina. Invalidar una terminal sin caché ni cálculos en vuelo no crea nada (Codex r8, N7).
 *
 * Lo que esta caché NO hace todavía, a propósito: «un solo cálculo por llave» y «máximo 32 cálculos en vuelo»
 * (spec §5.7.4) son del poll de la tablet, que llega en F0-B.
 */
export const TTL_MS = 60_000
export const CACHE_MAX_ENTRIES = 2_000
export const cache = new Map<string, { hasta: number; valor: { ficha: FichaEfectiva; assetRejected: string[] } }>()
export const enVuelo = new Map<string, { generacion: number; calculos: number }>() // por terminal, sólo con cálculos activos

/**
 * Congela a fondo lo que se guarda en la caché. Cada acierto devuelve el MISMO objeto (y quien lo calculó recibe justo
 * el que se guardó), así que una mutación de cualquier llamador envenenaría la ficha de esa terminal para todos durante
 * 60 s. Congelado, la mutación truena en el acto (los módulos corren en modo estricto) en vez de corromper en silencio.
 * Se prefiere a clonar en cada lectura porque se paga UNA vez al guardar y no en cada acierto del poll, que es el camino
 * caliente. Es seguro: `buildEffectiveDesign` arma objetos nuevos en cada cálculo, no comparte constantes del módulo.
 */
export function congelar<T>(valor: T): T {
  if (valor !== null && typeof valor === 'object' && !Object.isFrozen(valor)) {
    Object.freeze(valor)
    for (const hijo of Object.values(valor)) congelar(hijo)
  }
  return valor
}

export function purgar(ahora: number): void {
  for (const [llave, entrada] of cache) if (entrada.hasta <= ahora) cache.delete(llave)
  // Si aun así sobra, se van las más viejas (el Map conserva el orden de inserción).
  while (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string)
}

export function invalidateCustomerDisplayCache(terminalId: string): void {
  for (const llave of [...cache.keys()]) if (llave.startsWith(`${terminalId}:`)) cache.delete(llave)
  const vuelo = enVuelo.get(terminalId)
  if (vuelo) vuelo.generacion += 1 // los cálculos en vuelo de ESTA terminal ya no se guardarán
}

/** Sólo para las pruebas del tope. */
export function cacheSizeForTests(): { entradas: number; enVuelo: number } {
  return { entradas: cache.size, enVuelo: enVuelo.size }
}
