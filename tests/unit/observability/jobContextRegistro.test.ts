/**
 * El envoltorio de los cron registra su tick — sin cambiar cómo viajan los errores.
 *
 * 🔴 La condición que Codex puso primero, y la razón: para saber cuándo TERMINA un tick hay
 * que encadenar un `.finally()` a su promesa, y eso crea una promesa DERIVADA. Si se devuelve
 * la original y la derivada queda suelta, un tick que rechaza produce un `unhandledRejection`
 * EXTRA sobre una promesa que nadie puede manejar — y en este servidor ese evento no es ruido:
 * `server.ts` lo trata como fatal y arranca el apagado. Devolver la derivada conserva el
 * comportamiento **para promesas NUEVAS y no compartidas por tick**, que es la forma de todos
 * los callbacks del repo hoy — no en general: Node cuenta los rechazos POR PROMESA, así que un
 * tick que devuelva una promesa que él mismo ya manejó gana un evento que antes no tenía. La
 * tabla medida y sus dos casos divergentes viven en `contratoDeErroresDeJobs.test.ts`. También
 * cambia el orden observable: `catch → queueMicrotask` pasa a `queueMicrotask → catch`.
 *
 * La segunda condición: `node-cron` queda FUERA. Su corredor SÍ espera el resultado del tick
 * (`runner.js:70`), así que devolver una promesa distinta cambiaría su detección de solapes;
 * `cron@4.3.3` no espera nada (`waitForCompletion` es false por default) y por eso es seguro.
 */
import { scheduleJob, scheduleCron, __conRegistroDeJobParaPruebas } from '@/observability/jobContext'
import { crearRegistroDeJobs, registroDeJobs } from '@/observability/registroDeJobs'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const nuevoRegistro = () => {
  let t = 1000
  return { r: crearRegistroDeJobs({ ahoraMs: () => t }), avanzar: (ms: number) => (t += ms) }
}

describe('el tick queda registrado mientras corre', () => {
  it('un tick SÍNCRONO se da de baja al volver', () => {
    const { r, avanzar } = nuevoRegistro()
    __conRegistroDeJobParaPruebas('sincrono', () => avanzar(300), r)

    expect(r.jobsEnVentana(1000, 1300)).toEqual([{ nombre: 'sincrono', ms: 300, vivo: false }])
  })

  it('un tick ASÍNCRONO sigue vivo hasta que su promesa se resuelve', async () => {
    const { r, avanzar } = nuevoRegistro()
    let soltar: () => void = () => {}
    const promesa = __conRegistroDeJobParaPruebas('asincrono', () => new Promise<void>(res => (soltar = res)), r)

    avanzar(400)
    // Todavía trabajando: es justo lo que el guardia necesita ver.
    expect(r.jobsEnVentana(1000, 1400)).toEqual([{ nombre: 'asincrono', ms: 400, vivo: true }])

    soltar()
    await promesa
    expect(r.jobsEnVentana(1000, 1400)).toEqual([{ nombre: 'asincrono', ms: 400, vivo: false }])
  })

  it('un tick que LANZA en seco se da de baja y el error sigue propagándose', () => {
    const { r, avanzar } = nuevoRegistro()
    expect(() =>
      __conRegistroDeJobParaPruebas(
        'explota',
        () => {
          avanzar(50)
          throw new Error('tronó el barrido')
        },
        r,
      ),
    ).toThrow('tronó el barrido')

    expect(r.jobsEnVentana(1000, 1050)).toEqual([{ nombre: 'explota', ms: 50, vivo: false }])
  })

  it('🔴 un tick que RECHAZA entrega el rechazo al llamador, sin dejar una promesa suelta', async () => {
    const { r } = nuevoRegistro()
    const sueltos: unknown[] = []
    const espia = (motivo: unknown) => sueltos.push(motivo)
    process.on('unhandledRejection', espia)

    try {
      const promesa = __conRegistroDeJobParaPruebas('rechaza', () => Promise.reject(new Error('falló el lote')), r)
      await expect(promesa).rejects.toThrow('falló el lote')
      // Dos vueltas para que Node alcance a emitir el evento si hubiera quedado algo colgando.
      await new Promise(res => setImmediate(res))
      await new Promise(res => setImmediate(res))
      expect(sueltos).toEqual([]) // si se devolviera la promesa ORIGINAL, aquí habría uno
    } finally {
      process.off('unhandledRejection', espia)
    }
  })
})

describe('qué schedulers quedan cubiertos (cobertura declarada, no supuesta)', () => {
  beforeEach(() => registroDeJobs.limpiar())
  afterEach(() => registroDeJobs.limpiar())

  /**
   * 🔴 Esta prueba se reescribió porque la anterior NO acreditaba nada: sólo comprobaba que el
   * callback se hubiera llamado, así que seguía pasando con el registro quitado de
   * `scheduleJob` — lo cazó la auditoría de Codex. Ahora pasa por el scheduler REAL
   * (`fireOnTick`) y comprueba las tres cosas: alta, permanencia mientras la promesa está
   * pendiente, y cierre.
   */
  it('scheduleJob (cron) da de alta el tick, lo mantiene mientras trabaja y lo cierra', async () => {
    let soltar: () => void = () => {}
    const job = scheduleJob('job-de-prueba', '* * * * *', () => new Promise<void>(res => (soltar = res)))

    await job.fireOnTick()
    const enVuelo = registroDeJobs.jobsEnVentana(0, Number.MAX_SAFE_INTEGER)
    expect(enVuelo.filter(j => j.nombre === 'job-de-prueba' && j.vivo)).toHaveLength(1)

    soltar()
    await new Promise(res => setImmediate(res))
    const tras = registroDeJobs.jobsEnVentana(0, Number.MAX_SAFE_INTEGER)
    expect(tras.filter(j => j.nombre === 'job-de-prueba' && j.vivo)).toHaveLength(0)
    expect(tras.filter(j => j.nombre === 'job-de-prueba')).toHaveLength(1) // conservado, terminado
  })

  it('scheduleCron (node-cron) NO se instrumenta — declarado, no olvidado', () => {
    const fuente = readFileSync(join(__dirname, '../../../src/observability/jobContext.ts'), 'utf8')
    const cuerpoDeScheduleCron = fuente.slice(fuente.indexOf('export function scheduleCron'))
    expect(cuerpoDeScheduleCron).not.toContain('conRegistroDeJob')
    expect(typeof scheduleCron).toBe('function')
  })

  /**
   * 🔴 Lo que el aviso NO puede ver — contrastado contra el CÓDIGO, no contra una lista escrita.
   *
   * La versión anterior de esta prueba construía un objeto con cuatro claves y comprobaba que
   * hubiera cuatro: documentación ejecutable que habría seguido pasando con un hueco nuevo.
   * Lo señaló la auditoría de Codex. Ahora se leen los fuentes y se compara con las exclusiones
   * conocidas: un scheduler directo nuevo, o un tick nuevo que descarte su promesa, rompe aquí.
   */
  describe('los huecos de cobertura se miden sobre el código', () => {
    const raizSrc = join(__dirname, '../../../src')

    const archivosTs = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const ruta = join(dir, e.name)
        if (e.isDirectory()) return archivosTs(ruta)
        return e.isFile() && e.name.endsWith('.ts') ? [ruta] : []
      })

    const relativo = (ruta: string) => ruta.slice(raizSrc.length + 1)

/**
     * 🔴 Se comparan CANTIDADES por archivo, no nombres de archivo.
     *
     * La versión anterior sólo listaba los archivos, así que un registro NUEVO dentro de uno ya
     * excluido crecía en silencio — lo demostró Codex metiendo un tercer `new CronJob` en
     * `server.ts` y otro tick descartado en `blumon-payment-audit`, y las dos comprobaciones
     * seguían verdes. Con el conteo, cualquiera de las dos rompe aquí.
     *
     * Medido el 22-sep: **5 llamadas directas en 4 archivos** (server.ts tiene 2) y **6 ticks
     * que descartan su promesa en 5 archivos** (blumon tiene 2).
     */
    const SCHEDULERS_DIRECTOS_CONOCIDOS: Record<string, number> = {
      'jobs/catalog-publication-outbox-sweeper.job.ts': 1,
      'jobs/catalog-publication-watchdog.job.ts': 1,
      'server.ts': 2,
      'services/reviewSync.service.ts': 1,
    }

    const DESCARTAN_LA_PROMESA_CONOCIDOS: Record<string, number> = {
      'jobs/angelpay-event-worker.job.ts': 1,
      'jobs/blumon-payment-audit.job.ts': 2,
      'jobs/delivery-webhook-reconciliation.job.ts': 1,
      'jobs/loyalty-reconciliation.job.ts': 1,
      'jobs/payment-effects.job.ts': 1,
    }

    const contarPorArchivo = (archivos: string[], patron: RegExp): Record<string, number> => {
      const cuenta: Record<string, number> = {}
      for (const f of archivos) {
        const n = (readFileSync(f, 'utf8').match(patron) ?? []).length
        if (n > 0) cuenta[relativo(f)] = n
      }
      return cuenta
    }

    it('ningún scheduler DIRECTO nuevo se cuela — ni en un archivo ya conocido', () => {
      const encontrados = contarPorArchivo(
        archivosTs(raizSrc).filter(f => !f.endsWith('observability/jobContext.ts')),
        /new CronJob\(|\bcron\.schedule\(/g,
      )
      expect(encontrados).toEqual(SCHEDULERS_DIRECTOS_CONOCIDOS)
    })

    it('ningún tick nuevo descarta su promesa — ni en un archivo ya conocido', () => {
      const encontrados = contarPorArchivo(archivosTs(join(raizSrc, 'jobs')), /=> void this\./g)
      expect(encontrados).toEqual(DESCARTAN_LA_PROMESA_CONOCIDOS)
    })

    it('las ejecuciones que evitan el scheduler quedan nombradas', () => {
      // Un barrido de ARRANQUE o un `runNow()` a mano no pasa por `scheduleJob`, así que no se
      // registra. No se puede enumerar a ciegas, pero sí exigir que el caso citado siga ahí.
      const watchdog = readFileSync(join(raizSrc, 'jobs/terminal-payment-watchdog.job.ts'), 'utf8')
      expect(watchdog).toMatch(/runNow|sweep|barrido/i)
    })
  })
})
