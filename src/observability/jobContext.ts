import { CronJob } from 'cron'
import cron from 'node-cron'
import { runWithContext } from './executionContext'
import { newCorrelationId } from './correlationId'

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
  return new CronJob(cronTime, () => runInJobContext(jobName, onTick), onComplete, start, timeZone)
}

/**
 * The same idea for the three jobs that use `node-cron` instead of `cron`.
 */
export function scheduleCron(
  jobName: string,
  expression: string,
  onTick: Tick,
  options?: Parameters<typeof cron.schedule>[2],
): ReturnType<typeof cron.schedule> {
  return cron.schedule(expression, () => runInJobContext(jobName, onTick), options)
}
