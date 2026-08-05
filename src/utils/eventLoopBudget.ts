/**
 * Presupuesto de retención del event loop.
 *
 * Node corre en un solo hilo: mientras un handler hace CPU síncrono, NADIE más se atiende.
 * El 2026-08-04 la pantalla de Ventas de PlayTelecom retuvo el hilo ~9 s por endpoint y
 * `/dashboard/auth/status` —un endpoint trivial— tardó 33.7 s. Medido en Better Stack: en
 * los minutos con reportes corriendo, la mediana de ese endpoint pasó de 1,655 ms a
 * 2,936 ms y el p95 de 2,854 ms a 8,087 ms.
 *
 * 🔴 Esto NO mide cuánto TARDA una operación. Tardar puede estar perfectamente bien:
 * esperar a Postgres no retiene el hilo, y un reporte lento pero cortés no molesta a nadie.
 * Lo que mide es cuánto tiempo SEGUIDO el hilo estuvo secuestrado sin poder atender a
 * nadie más. Esa es la métrica que importa en una plataforma de pagos.
 */

/**
 * Máximo que un handler puede retener el hilo.
 *
 * Lo exige CI. En producción el umbral de alerta arranca más flojo (200 ms, ver
 * `eventLoopGuard.middleware.ts`) a propósito: en CI un falso positivo cuesta rehacer un
 * test, pero en producción cuesta que la gente aprenda a ignorar las alertas.
 */
export const EVENT_LOOP_BUDGET_MS = 50

const DEFAULT_SAMPLE_INTERVAL_MS = 5

/**
 * Corre `fn` mientras muestrea el retraso del event loop.
 *
 * Cómo funciona: se programa un intervalo cada `sampleIntervalMs`. Si el hilo está libre,
 * cada tick llega puntual. Si algo lo está reteniendo, el tick llega TARDE, y ese retraso
 * es exactamente cuánto duró el bloqueo. Se resta el intervalo nominal para quedarse sólo
 * con el exceso.
 */
export async function measureEventLoopBlock<T>(
  fn: () => Promise<T>,
  sampleIntervalMs: number = DEFAULT_SAMPLE_INTERVAL_MS,
): Promise<{ result: T; maxBlockMs: number }> {
  let maxBlockMs = 0
  let lastTick = process.hrtime.bigint()

  const sampler = setInterval(() => {
    const now = process.hrtime.bigint()
    const elapsedMs = Number(now - lastTick) / 1e6
    const blockedMs = elapsedMs - sampleIntervalMs
    if (blockedMs > maxBlockMs) maxBlockMs = blockedMs
    lastTick = now
  }, sampleIntervalMs)

  // No mantener vivo el proceso sólo por el muestreador.
  if (typeof sampler.unref === 'function') sampler.unref()

  /**
   * Mide el hueco entre el último tick y AHORA.
   *
   * Hace falta además del muestreador porque un bloqueo síncrono de corrido impide que el
   * intervalo se dispare siquiera — el hilo está secuestrado, así que el temporizador
   * tampoco corre. Sin esta lectura final, el peor caso (el que de verdad importa) se
   * reportaba como 0. Se descubrió con el test "detecta un bloqueo síncrono largo".
   */
  const recordGapSinceLastTick = () => {
    const blockedMs = Number(process.hrtime.bigint() - lastTick) / 1e6 - sampleIntervalMs
    if (blockedMs > maxBlockMs) maxBlockMs = blockedMs
  }

  try {
    const result = await fn()
    recordGapSinceLastTick()
    return { result, maxBlockMs }
  } finally {
    clearInterval(sampler)
  }
}
