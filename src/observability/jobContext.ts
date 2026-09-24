import { CronJob } from 'cron'
import cron from 'node-cron'
import { runWithContext } from './executionContext'
import { newCorrelationId } from './correlationId'
import { registroDeJobs, type RegistroDeJobs } from './registroDeJobs'

/**
 * Opens an execution context for one cron tick.
 *
 * A fresh correlation id per tick: two runs of the same job are two separate units of work,
 * and sharing an id would group unrelated failures into one thread.
 *
 * Like every context wrapper here, it NEVER catches. Each job keeps its own try/catch,
 * which is where the error is already logged; this only makes sure that catch has a context
 * to read, so its log line finally says which venue it was about.
 *
 * 🔴 Call it so `this` survives. Most jobs are classes that hand the scheduler
 * `this.method.bind(this)`. Passing the method by reference through here drops the binding
 * and the job throws on every tick, silently, forever:
 *
 *   ❌ new CronJob(pattern, () => runInJobContext('my-job', this.tick))
 *   ✅ new CronJob(pattern, () => runInJobContext('my-job', () => this.tick()))
 *
 * `tests/unit/jobs/jobTickContext.test.ts` invokes every registered tick specifically to
 * catch that mistake.
 */
export function runInJobContext<T>(jobName: string, fn: () => T): T {
  return runWithContext({ correlationId: newCorrelationId(), source: 'job', entrypoint: jobName }, fn)
}

/**
 * Anota que este tick está corriendo, para que el guardia del event loop pueda decir QUÉ jobs
 * se SOLAPARON con la retención.
 *
 * 🔴 Solaparse no es tener el hilo: un tick que pasó ese rato esperando a Postgres cuenta igual
 * que uno calculando. Es una pista de dónde mirar, no una acusación.
 *
 * 🔴 Devuelve la promesa DERIVADA del `.finally()`, nunca la original, y esto no es estilo:
 * encadenar crea una segunda promesa, y si se devolviera la original la derivada quedaría
 * suelta. Un tick que rechaza produciría entonces un `unhandledRejection` EXTRA sobre una
 * promesa que nadie puede manejar — y aquí ese evento no es ruido: `server.ts` lo trata como
 * fatal y arranca el apagado.
 *
 * 🔴 **Pero el contrato NO queda idéntico en general, y decirlo sería mentir.** Node cuenta los
 * rechazos sin manejar POR PROMESA: manejar una rama no maneja la otra. Medido en un proceso
 * real (`tests/unit/observability/contratoDeErroresDeJobs.test.ts`):
 *
 * | El tick devuelve… | Sin envoltorio | Con envoltorio |
 * |---|---:|---:|
 * | promesa nueva, el llamador la descarta | 1 | 1 |
 * | promesa nueva, el llamador la maneja | 0 | 0 |
 * | una promesa que él mismo YA manejó | 0 | **1** |
 * | la MISMA promesa en dos ticks | 1 | **2** |
 *
 * La equivalencia se sostiene mientras el tick devuelva una promesa **nueva y no compartida**,
 * que es la forma de todos los callbacks del repo hoy (los que devuelven promesa la crean con
 * funciones `async`). Un tick que devuelva una promesa compartida o ya manejada queda FUERA de
 * esa garantía; los dos casos están fijados por prueba para que deje de ser un comentario.
 * También cambia el orden observable: `catch → queueMicrotask` pasa a `queueMicrotask → catch`.
 *
 * Un `throw` en seco también se da de baja, porque si no el job quedaría «corriendo» para
 * siempre y el aviso culparía a un tick que murió hace horas.
 */
function conRegistroDeJob<T>(jobName: string, fn: () => T, registro: RegistroDeJobs = registroDeJobs): T {
  const id = registro.iniciar(jobName)
  let resultado: T
  try {
    resultado = fn()
  } catch (error) {
    registro.terminar(id)
    throw error
  }
  if (resultado && typeof (resultado as { then?: unknown }).then === 'function') {
    return (resultado as unknown as Promise<unknown>).finally(() => registro.terminar(id)) as unknown as T
  }
  registro.terminar(id)
  return resultado
}

/** Sólo para pruebas: el registro es inyectable para no depender del reloj real. */
export const __conRegistroDeJobParaPruebas = conRegistroDeJob

/** What both schedulers accept as a tick. */
type Tick = () => void | Promise<void>

/**
 * Drop-in replacement for `new CronJob(...)` that opens an execution context per tick.
 *
 * Same argument list, one name in front:
 *
 *   ❌ new CronJob(pattern, this.run.bind(this), null, false, TZ)
 *   ✅ scheduleJob('my-job', pattern, this.run.bind(this), null, false, TZ)
 *
 * 🔴 Why the signature mirrors CronJob instead of being prettier: the callback is passed
 * through **verbatim**. Wrapping jobs by hand meant rewriting each callback, and rewriting
 * `this.run.bind(this)` into an arrow is exactly where the binding gets dropped — producing
 * a job that throws on every tick, silently, forever. Copying the argument untouched makes
 * that mistake impossible instead of merely detectable.
 */
export function scheduleJob(
  jobName: string,
  cronTime: string,
  onTick: Tick,
  onComplete: null | (() => void) = null,
  start = false,
  timeZone = 'America/Mexico_City',
): CronJob {
  return new CronJob(cronTime, () => runInJobContext(jobName, () => conRegistroDeJob(jobName, onTick)), onComplete, start, timeZone)
}

/**
 * The same idea for the three jobs that use `node-cron` instead of `cron`.
 *
 * 🔴 A PROPÓSITO **sin** el registro de jobs en vuelo: el corredor de `node-cron@4.2.1` SÍ
 * espera el resultado del tick (`runner.js:70`), así que devolverle una promesa distinta —la
 * derivada del `.finally()`— cambiaría su detección de solapes. `cron@4.3.3` no espera nada
 * (`waitForCompletion` es false por default) y por eso ahí sí es seguro. La consecuencia se
 * declara en el aviso del guardia como cobertura PARCIAL, no se esconde.
 */
export function scheduleCron(
  jobName: string,
  expression: string,
  onTick: Tick,
  options?: Parameters<typeof cron.schedule>[2],
): ReturnType<typeof cron.schedule> {
  return cron.schedule(expression, () => runInJobContext(jobName, onTick), options)
}
