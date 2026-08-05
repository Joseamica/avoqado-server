/**
 * Medición de retención del event loop.
 *
 * La prueba de que la medición SIRVE son los dos casos opuestos: una función que bloquea
 * a propósito debe detectarse, y otra que hace el MISMO trabajo total pero cediendo el
 * hilo debe pasar. Si ambas pasaran, o ambas fallaran, la medición no estaría midiendo
 * nada — sólo el tiempo total, que es justo lo que NO nos importa.
 */
import { measureEventLoopBlock, EVENT_LOOP_BUDGET_MS } from '@/utils/eventLoopBudget'

/** Quema CPU de forma síncrona durante al menos `ms` milisegundos. */
function burnCpuSync(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    /* girar a propósito */
  }
}

const yieldToLoop = () => new Promise<void>(resolve => setImmediate(resolve))

describe('measureEventLoopBlock', () => {
  /**
   * Referencia medida en ESTA máquina y bajo ESTA carga: 300 ms de CPU síncrono de corrido.
   *
   * 🔴 Las comparaciones de abajo son RELATIVAS a este número, nunca contra un umbral fijo
   * de reloj de pared. Cualquier muestreador de event loop mide con el reloj, y un proceso
   * que el sistema operativo desprogramó se ve EXACTAMENTE igual que un event loop
   * bloqueado: en ambos casos el tick llega tarde. Con la suite completa en paralelo eso
   * pasa de verdad — el caso "cede el hilo en trozos" midió 74 ms contra un presupuesto de
   * 50 y tumbó el CI, pasando siempre al correrlo solo.
   *
   * La referencia se contamina con la MISMA carga que los casos que compara, así que el
   * contraste sobrevive aunque la máquina esté saturada. Un umbral absoluto no.
   */
  let bloqueoDeReferenciaMs: number

  beforeAll(async () => {
    const { maxBlockMs } = await measureEventLoopBlock(async () => {
      burnCpuSync(300)
    })
    bloqueoDeReferenciaMs = maxBlockMs
  })

  it('detecta un bloqueo síncrono largo', () => {
    // Cota INFERIOR: la carga sólo puede inflar este número, nunca hacerlo fallar.
    expect(bloqueoDeReferenciaMs).toBeGreaterThan(200)
  })

  it('NO acusa a un trabajo igual de largo que cede el hilo en trozos', async () => {
    const { maxBlockMs } = await measureEventLoopBlock(async () => {
      for (let i = 0; i < 30; i++) {
        burnCpuSync(10) // 300 ms de trabajo TOTAL, igual que la referencia
        await yieldToLoop()
      }
    })
    // Lo que se afirma: el peor bloqueo se parece al TROZO (10 ms), no al TOTAL (300 ms).
    // Si ceder el hilo dejara de contar, este número treparía hasta la referencia.
    expect(maxBlockMs).toBeLessThan(bloqueoDeReferenciaMs / 3)
  })

  it('no acusa a una espera de I/O, por larga que sea', async () => {
    // Esperar a Postgres NO retiene el hilo. Si esto fallara, la medición estaría
    // midiendo latencia en vez de bloqueo.
    const { maxBlockMs } = await measureEventLoopBlock(async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
    })
    expect(maxBlockMs).toBeLessThan(bloqueoDeReferenciaMs / 3)
  })

  it('devuelve el resultado de la función sin alterarlo', async () => {
    const { result } = await measureEventLoopBlock(async () => ({ filas: 42 }))
    expect(result).toEqual({ filas: 42 })
  })

  it('limpia el muestreador aunque la función lance', async () => {
    await expect(
      measureEventLoopBlock(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    // Si el interval quedara vivo, Jest se quejaría de un handle abierto al cerrar.
  })

  it('expone el presupuesto acordado de 50 ms', () => {
    expect(EVENT_LOOP_BUDGET_MS).toBe(50)
  })
})
