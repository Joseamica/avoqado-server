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

/**
 * Mide `fn` varias veces y devuelve el bloqueo MÍNIMO observado.
 *
 * 🔴 Por qué el mínimo y no el promedio ni una sola corrida: cualquier muestreador de event
 * loop mide con el reloj, y un proceso que el sistema operativo DESPROGRAMÓ se ve idéntico
 * a un event loop bloqueado — en los dos casos el tick llega tarde. Ese ruido es
 * UNIDIRECCIONAL: sólo puede AÑADIR retraso, nunca quitarlo. Por eso el mínimo de varios
 * intentos es la estimación limpia, y basta con que UNO de los intentos agarre una ventana
 * sin robo de CPU.
 *
 * Historial, para que nadie repita los intentos fallidos:
 *  1. Umbral absoluto contra el presupuesto (`< 50`): con la suite en paralelo midió 74 ms.
 *  2. Umbral RELATIVO a una referencia medida en la misma corrida (`< referencia/3`):
 *     también rojo (referencia 372.9, trozos 195.8, umbral 124.3). La suposición de que el
 *     robo de CPU golpea a ambas mediciones en proporción es FALSA — es aleatorio por
 *     muestra, y castigó más al caso de trozos que a la referencia.
 *  3. Mínimo de 5 contra `< 50`: TAMBIÉN rojo (119 ms). Aquí salió el dato que faltaba —
 *     medido fuera de Jest y sin carga, cinco corridas seguidas de este mismo trabajo dan
 *     `43.5  77.3  35.4  115.4  72.5` y `124.6  55.7  146.7  87.5  47.8`. O sea que el
 *     ruido NO viene de la suite: la medición en sí oscila entre ~35 y ~147 ms en una
 *     máquina ociosa (coalescencia de timers del SO y pausas de GC). El umbral de 50 ms
 *     nunca fue sostenible — era marginal desde el día uno y sólo pasaba de suerte.
 */
async function bloqueoMinimoDe(intentos: number, fn: () => Promise<unknown>): Promise<number> {
  let minimo = Infinity
  for (let i = 0; i < intentos; i++) {
    const { maxBlockMs } = await measureEventLoopBlock(fn)
    if (maxBlockMs < minimo) minimo = maxBlockMs
  }
  return minimo
}

const INTENTOS = 5

/**
 * Vara de "no lo acusó": la MITAD del trabajo total (300 ms), no el presupuesto de 50 ms.
 *
 * 🔴 Esto NO relaja la regla de producción — `EVENT_LOOP_BUDGET_MS` sigue en 50 ms y tiene
 * su propio test. Es reconocer qué puede probar ESTA medición en una máquina compartida:
 * separar "retuvo el hilo los 300 ms" de "lo soltó cada 10 ms". Con el mínimo de 5, el caso
 * que cede quedó en 35-48 ms medido, y el que bloquea en 300-373. Cualquier vara entre
 * ambos mundos distingue lo que importa; 150 deja margen para el ruido del SO sin volverse
 * vacía: si ceder el hilo dejara de contar, la medición treparía a ~300 y esto truena.
 */
const CEDE_EL_HILO_MAX_MS = 150

describe('measureEventLoopBlock', () => {
  it('detecta un bloqueo síncrono largo', async () => {
    // Cota INFERIOR: aquí el ruido del planificador sólo puede inflar el número, así que
    // una sola corrida basta y no hace falta el mínimo.
    const { maxBlockMs } = await measureEventLoopBlock(async () => {
      burnCpuSync(300)
    })
    expect(maxBlockMs).toBeGreaterThan(200)
  })

  it('NO acusa a un trabajo igual de largo que cede el hilo en trozos', async () => {
    const minimo = await bloqueoMinimoDe(INTENTOS, async () => {
      for (let i = 0; i < 30; i++) {
        burnCpuSync(10) // 300 ms de trabajo TOTAL, igual que el caso de arriba
        await yieldToLoop()
      }
    })
    // Lo que se afirma: el peor bloqueo se parece al TROZO (10 ms), no al TOTAL (300 ms).
    // Si ceder el hilo dejara de contar, los 5 intentos rondarían los 300 ms y el mínimo
    // tampoco pasaría.
    expect(minimo).toBeLessThan(CEDE_EL_HILO_MAX_MS)
  })

  it('no acusa a una espera de I/O, por larga que sea', async () => {
    // Esperar a Postgres NO retiene el hilo. Si esto fallara, la medición estaría
    // midiendo latencia en vez de bloqueo.
    const minimo = await bloqueoMinimoDe(INTENTOS, async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
    })
    expect(minimo).toBeLessThan(CEDE_EL_HILO_MAX_MS)
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
