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
  it('detecta un bloqueo síncrono largo', async () => {
    const { maxBlockMs } = await measureEventLoopBlock(async () => {
      burnCpuSync(300)
    })
    expect(maxBlockMs).toBeGreaterThan(200)
  })

  it('NO acusa a un trabajo igual de largo que cede el hilo en trozos', async () => {
    const { maxBlockMs } = await measureEventLoopBlock(async () => {
      for (let i = 0; i < 30; i++) {
        burnCpuSync(10) // 300 ms de trabajo TOTAL, igual que el caso de arriba
        await yieldToLoop()
      }
    })
    expect(maxBlockMs).toBeLessThan(EVENT_LOOP_BUDGET_MS)
  })

  it('no acusa a una espera de I/O, por larga que sea', async () => {
    // Esperar a Postgres NO retiene el hilo. Si esto fallara, la medición estaría
    // midiendo latencia en vez de bloqueo.
    const { maxBlockMs } = await measureEventLoopBlock(async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
    })
    expect(maxBlockMs).toBeLessThan(EVENT_LOOP_BUDGET_MS)
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
