/**
 * Planes editables B1, Task 8: el job que hace converger el nombre del producto de Stripe de cada plan con la oferta vigente.
 *
 * Se prueba con el `scheduleJob` REAL: el `CronJob` que registra el job se toma con `Reflect.get(job, 'cron')` y se dispara con
 * `fireOnTick()` (pasa por `runInJobContext`, como en producción). Un tick cuyo renombrador rechaza nunca deja escapar la promesa:
 * en `server.ts` un `unhandledRejection` arranca el apagado.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import type { CronJob } from 'cron'

jest.mock('@/services/billing/nombreDelPlanEnStripe', () => ({ renombrarProductosDelPlan: jest.fn() }))

import logger from '@/config/logger'
import { PlanOfferRenameJob } from '@/jobs/plan-offer-rename.job'
import { DATABASE_JOB_SCHEDULES } from '@/jobs/jobSchedules'
import type { EstadoDelNombre } from '@/services/billing/nombreDelPlanEnStripe'
import type { PlanPagado } from '@/services/billing/planOffer'

type Resultado = Record<PlanPagado, EstadoDelNombre>
const AL_DIA: Resultado = { PRO: 'AL_DIA', PREMIUM: 'SIN_VERSION' }

const cronDe = (job: PlanOfferRenameJob) => Reflect.get(job, 'cron') as CronJob
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

  it('🔴 un tick cuyo renombrador rechaza no deja escapar la promesa: logger.error y ningún unhandledRejection; el siguiente tick vuelve a correr', async () => {
    const sinManejar = jest.fn()
    process.on('unhandledRejection', sinManejar)
    try {
      const renombrar = jest
        .fn<Promise<Resultado>, []>()
        .mockRejectedValueOnce(new Error('la base no contesta'))
        .mockResolvedValueOnce(AL_DIA)
      const job = nuevo(renombrar)

      void cronDe(job).fireOnTick()
      await microtareas()
      await microtareas()

      expect(sinManejar).not.toHaveBeenCalled()
      expect(logger.error).toHaveBeenCalledWith('Renombre de los planes: la corrida falló', { error: expect.any(Error) })

      void cronDe(job).fireOnTick()
      await microtareas()
      expect(renombrar).toHaveBeenCalledTimes(2)
      expect(sinManejar).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', sinManejar)
    }
  })

  it('start() deja el CronJob activo y stop() lo detiene', () => {
    const job = nuevo(jest.fn<Promise<Resultado>, []>().mockResolvedValue(AL_DIA))
    const cron = cronDe(job)
    expect(cron.cronTime.source).toBe('3 * * * * *')
    expect(DATABASE_JOB_SCHEDULES.planOfferRename).toBe('3 * * * * *')
    expect(cron.isActive).toBe(false)

    job.start()
    expect(cron.isActive).toBe(true)
    job.stop()
    expect(cron.isActive).toBe(false)
  })

  it('el segundo :03 es sólo suyo en la lista de horarios', () => {
    const otros = Object.entries(DATABASE_JOB_SCHEDULES as Record<string, string>)
      .filter(([nombre]: [string, string]) => nombre !== 'planOfferRename')
      .flatMap(([, horario]: [string, string]) => horario.split(' ')[0].split(','))
    expect(otros).not.toContain('3')
  })

  it('runNow renombra y devuelve el estado por plan; dos vueltas encimadas: la segunda devuelve null sin llamar a Stripe', async () => {
    let soltar!: (r: Resultado) => void
    const renombrar = jest.fn<Promise<Resultado>, []>().mockImplementationOnce(() => new Promise<Resultado>(listo => (soltar = listo)))
    const job = nuevo(renombrar)

    const primera = job.runNow()
    await expect(job.runNow()).resolves.toBeNull()
    expect(renombrar).toHaveBeenCalledTimes(1)

    soltar({ PRO: 'RENOMBRADO', PREMIUM: 'SIN_VERSION' })
    await expect(primera).resolves.toEqual({ PRO: 'RENOMBRADO', PREMIUM: 'SIN_VERSION' })

    // La marca se soltó: la siguiente vuelta corre, también después de una que falló.
    renombrar.mockRejectedValueOnce(new Error('falló')).mockResolvedValueOnce(AL_DIA)
    await expect(job.runNow()).rejects.toThrow('falló')
    await expect(job.runNow()).resolves.toEqual(AL_DIA)
    expect(renombrar).toHaveBeenCalledTimes(3)
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
