/**
 * Planes editables B1, Task 8: el job que hace converger el nombre del producto de Stripe de cada plan con la oferta vigente.
 *
 * Se prueba con el `scheduleJob` REAL: el `CronJob` que registra el job se toma con `Reflect.get(job, 'cron')` y se dispara con
 * `fireOnTick()` (pasa por `runInJobContext`, como en producción). El tick que registró el scheduler no devuelve ninguna promesa: un
 * rechazo que llegara a `cron` sería un `unhandledRejection`, y en `server.ts` eso arranca el apagado.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { CronTime, type CronJob } from 'cron'

jest.mock('@/services/billing/nombreDelPlanEnStripe', () => ({ renombrarProductosDelPlan: jest.fn() }))

import logger from '@/config/logger'
import { PlanOfferRenameJob } from '@/jobs/plan-offer-rename.job'
import { DATABASE_JOB_SCHEDULES } from '@/jobs/jobSchedules'
import type { EstadoDelNombre } from '@/services/billing/nombreDelPlanEnStripe'
import type { PlanPagado } from '@/services/billing/planOffer'

type Resultado = Record<PlanPagado, EstadoDelNombre>
const AL_DIA: Resultado = { PRO: 'AL_DIA', PREMIUM: 'SIN_VERSION' }

const cronDe = (job: PlanOfferRenameJob) => Reflect.get(job, 'cron') as CronJob
/** El callback tal como lo registró `scheduleJob` en el `CronJob` (el envoltorio de `runInJobContext` con el tick adentro). */
function tickDe(job: PlanOfferRenameJob): () => unknown {
  const registrados = Reflect.get(cronDe(job), '_callbacks') as Array<() => unknown> | undefined
  if (!Array.isArray(registrados) || registrados.length !== 1) throw new Error('El CronJob no trae exactamente un callback registrado')
  return registrados[0]
}

/** Los segundos que dispara el primer campo de un horario de 6 campos, expandidos por el propio `cron` (listas, rangos y pasos). */
function segundosDe(horario: string): number[] {
  const campo = horario.trim().split(/\s+/)[0]
  const tiempo = new CronTime(`${campo} * * * * *`, 'UTC')
  const inicio = new Date('2026-11-25T12:00:00.000Z')
  const fin = inicio.getTime() + 60_000
  const segundos: number[] = []
  let cursor = new Date(inicio.getTime() - 1)
  for (;;) {
    const siguiente = tiempo.getNextDateFrom(cursor, 'UTC').toJSDate()
    if (siguiente.getTime() >= fin) return segundos
    segundos.push(siguiente.getUTCSeconds())
    cursor = siguiente
  }
}
const microtareas = () => new Promise<void>(listo => setImmediate(listo))

const jobs: PlanOfferRenameJob[] = []
const nuevo = (renombrar: () => Promise<Resultado>) => {
  const job = new PlanOfferRenameJob({ renombrar })
  jobs.push(job)
  return job
}

afterEach(() => {
  for (const job of jobs.splice(0)) job.stop()
})

describe('PlanOfferRenameJob', () => {
  it('🔴 el tick que registró el scheduler llama al renombrador', async () => {
    const renombrar = jest.fn<Promise<Resultado>, []>().mockResolvedValue(AL_DIA)
    const job = nuevo(renombrar)

    void cronDe(job).fireOnTick()
    await microtareas()

    expect(renombrar).toHaveBeenCalledTimes(1)
  })

  it('🔴 el tick que registró el scheduler no le devuelve una promesa: si el renombrador rechaza, logger.error y el siguiente tick vuelve a correr', async () => {
    const renombrar = jest
      .fn<Promise<Resultado>, []>()
      .mockRejectedValueOnce(new Error('la base no contesta'))
      .mockResolvedValueOnce(AL_DIA)
    const tick = tickDe(nuevo(renombrar))

    // Un tick que devolviera la promesa de la corrida se la entregaría a `cron`, que no la espera: su rechazo escaparía.
    expect(tick()).toBeUndefined()
    await microtareas()
    await microtareas()
    expect(logger.error).toHaveBeenCalledWith('Renombre de los planes: la corrida falló', { error: expect.any(Error) })

    expect(tick()).toBeUndefined()
    await microtareas()
    expect(renombrar).toHaveBeenCalledTimes(2)
  })

  it('start() deja el CronJob activo y stop() lo detiene', () => {
    const job = nuevo(jest.fn<Promise<Resultado>, []>().mockResolvedValue(AL_DIA))
    const cron = cronDe(job)
    expect(cron.cronTime.source).toBe('12 * * * * *')
    expect(DATABASE_JOB_SCHEDULES.planOfferRename).toBe('12 * * * * *')
    expect(cron.isActive).toBe(false)

    job.start()
    expect(cron.isActive).toBe(true)
    job.stop()
    expect(cron.isActive).toBe(false)
  })

  // `job-schedule-hardening` sólo revisa sus siete jobs y el de displayModeRequestExpiry contra los demás: el :12 se revisa aquí.
  it('el segundo :12 es sólo suyo en la lista de horarios (con listas, rangos y pasos en el campo de los segundos)', () => {
    // El expansor entiende cada forma.
    expect(segundosDe('*/20 * * * * *')).toEqual([0, 20, 40])
    expect(segundosDe('1-59/10 * * * * *')).toEqual([1, 11, 21, 31, 41, 51])
    expect(segundosDe('0-5 * * * * *')).toEqual([0, 1, 2, 3, 4, 5])
    expect(segundosDe('5,35 */10 * * * *')).toEqual([5, 35])
    expect(segundosDe(DATABASE_JOB_SCHEDULES.planOfferRename)).toEqual([12])

    const conElTres = Object.entries(DATABASE_JOB_SCHEDULES as Record<string, string>)
      .filter(([nombre]: [string, string]) => nombre !== 'planOfferRename')
      .filter(([, horario]: [string, string]) => segundosDe(horario).includes(12))
      .map(([nombre]: [string, string]) => nombre)
    expect(conElTres).toEqual([])
  })

  it('runNow renombra y devuelve el estado por plan; una vuelta encimada devuelve null sin llamar a Stripe y deja pedida exactamente UNA vuelta más al terminar', async () => {
    let soltar!: (r: Resultado) => void
    const renombrar = jest
      .fn<Promise<Resultado>, []>()
      .mockImplementationOnce(() => new Promise<Resultado>(listo => (soltar = listo)))
      .mockResolvedValue(AL_DIA)
    const job = nuevo(renombrar)

    const primera = job.runNow()
    await expect(job.runNow()).resolves.toBeNull()
    expect(renombrar).toHaveBeenCalledTimes(1)

    soltar({ PRO: 'RENOMBRADO', PREMIUM: 'SIN_VERSION' })
    await expect(primera).resolves.toEqual({ PRO: 'RENOMBRADO', PREMIUM: 'SIN_VERSION' })
    // La vuelta pedida arrancó al terminar la primera (pudo leer la vigente antes de que se publicara otra), y sólo una.
    await microtareas()
    expect(renombrar).toHaveBeenCalledTimes(2)
    await microtareas()
    expect(renombrar).toHaveBeenCalledTimes(2)
  })

  it('dos llamadas encimadas siguen dejando UNA sola vuelta más; sin llamadas encimadas no hay vuelta extra', async () => {
    let soltar!: (r: Resultado) => void
    const renombrar = jest
      .fn<Promise<Resultado>, []>()
      .mockImplementationOnce(() => new Promise<Resultado>(listo => (soltar = listo)))
      .mockResolvedValue(AL_DIA)
    const job = nuevo(renombrar)

    const primera = job.runNow()
    await expect(job.runNow()).resolves.toBeNull()
    await expect(job.runNow()).resolves.toBeNull()
    soltar(AL_DIA)
    await primera
    await microtareas()
    await microtareas()
    expect(renombrar).toHaveBeenCalledTimes(2)

    // Una vuelta sola, sin nadie encimado, no pide otra.
    await expect(job.runNow()).resolves.toEqual(AL_DIA)
    await microtareas()
    expect(renombrar).toHaveBeenCalledTimes(3)
  })

  it('la marca se suelta también después de una vuelta que falló; una vuelta extra que falla queda en logger.error', async () => {
    let fallar!: (e: Error) => void
    const renombrar = jest
      .fn<Promise<Resultado>, []>()
      .mockRejectedValueOnce(new Error('falló'))
      .mockImplementationOnce(() => new Promise<Resultado>((_listo, rechazar) => (fallar = rechazar)))
      .mockRejectedValueOnce(new Error('la vuelta extra falló'))
      .mockResolvedValue(AL_DIA)
    const job = nuevo(renombrar)

    await expect(job.runNow()).rejects.toThrow('falló')

    // La segunda vuelta corre (la marca se soltó); mientras, alguien pide otra.
    const segunda = job.runNow()
    await expect(job.runNow()).resolves.toBeNull()
    expect(renombrar).toHaveBeenCalledTimes(2)
    fallar(new Error('la segunda falló'))
    await expect(segunda).rejects.toThrow('la segunda falló')

    // La vuelta pedida corre aunque la segunda haya fallado, y su rechazo queda en el log (no escapa).
    await microtareas()
    await microtareas()
    expect(renombrar).toHaveBeenCalledTimes(3)
    expect(logger.error).toHaveBeenCalledWith('Renombre de los planes: la corrida falló', { error: expect.any(Error) })
    await expect(job.runNow()).resolves.toEqual(AL_DIA)
    expect(renombrar).toHaveBeenCalledTimes(4)
  })

  it('🔴 arranca y se detiene con el SERVIDOR', () => {
    const archivo = path.join(__dirname, '../../../src/server.ts')
    const fuente = ts.createSourceFile(archivo, fs.readFileSync(archivo, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

    /** El cuerpo de `const <nombre> = async (...) => { ... }` del nivel superior. */
    const cuerpoDe = (nombre: string): ts.Node => {
      for (const sentencia of fuente.statements) {
        if (!ts.isVariableStatement(sentencia)) continue
        for (const d of sentencia.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === nombre && d.initializer && ts.isArrowFunction(d.initializer))
            return d.initializer.body
        }
      }
      throw new Error(`No encontré ${nombre} en src/server.ts`)
    }
    /** ¿La sentencia es exactamente `<objeto>.<metodo>()`? (los comentarios no son sentencias). */
    const esLlamada = (s: ts.Statement, objeto: string, metodo: string) =>
      ts.isExpressionStatement(s) &&
      ts.isCallExpression(s.expression) &&
      s.expression.arguments.length === 0 &&
      ts.isPropertyAccessExpression(s.expression.expression) &&
      ts.isIdentifier(s.expression.expression.expression) &&
      s.expression.expression.expression.text === objeto &&
      s.expression.expression.name.text === metodo
    /** Los bloques dentro de `raiz` que contienen la sentencia `<objeto>.<metodo>()`. */
    const bloquesCon = (raiz: ts.Node, objeto: string, metodo: string): ts.Block[] => {
      const encontrados: ts.Block[] = []
      const visitar = (nodo: ts.Node) => {
        if (ts.isBlock(nodo) && nodo.statements.some((s: ts.Statement) => esLlamada(s, objeto, metodo))) encontrados.push(nodo)
        ts.forEachChild(nodo, visitar)
      }
      visitar(raiz)
      return encontrados
    }

    for (const [funcion, metodo] of [
      ['startApplication', 'start'],
      ['gracefulShutdown', 'stop'],
    ] as const) {
      const cuerpo = cuerpoDe(funcion)
      const delVecino = bloquesCon(cuerpo, 'altasAMedioPagoJob', metodo)
      expect(delVecino).toHaveLength(1)
      const delJob = bloquesCon(cuerpo, 'planOfferRenameJob', metodo)
      expect(delJob).toHaveLength(1)
      // El MISMO bloque: corre bajo las mismas condiciones que un job que ya arranca y se detiene.
      expect(delJob[0]).toBe(delVecino[0])
    }
    expect(fs.readFileSync(archivo, 'utf8')).toContain("import { planOfferRenameJob } from './jobs/plan-offer-rename.job'")
  })
})
