import fs from 'node:fs'
import v8 from 'node:v8'
import { isMainThread, Worker, workerData } from 'node:worker_threads'

/**
 * Caja negra del proceso: lo necesario para saber por qué murió el servidor la próxima vez que se
 * reinicie sin avisar. El 27 y el 28-sep-2026 el contenedor de producción murió de golpe dos veces —sin
 * error, sin SIGTERM, sin evento de Render— y no quedó nada que dijera por qué.
 *
 * Todo sale por stdout como JSON, con escrituras SÍNCRONAS (`fs.writeSync`): una línea que se queda en un
 * búfer no sirve si el proceso muere un instante después.
 *
 * - `[caja-negra] arranque`: una vez; si quedó activo el parche de Prisma y los límites del contenedor.
 * - `[caja-negra] latido`: cada 10 s, desde un HILO APARTE — memoria del proceso y del contenedor, CPU
 *   usada y frenada por la cuota, espera de CPU/memoria del contenedor y de la máquina, OOM de la máquina,
 *   y cuánto lleva sin responder el hilo principal. Va en otro hilo porque antes de las dos muertes el
 *   hilo principal estaba congelado (18.6 s y 77 s): un temporizador suyo no habría escrito nada.
 * - `[caja-negra] señal` / `salida`: qué señal llegó, y quién llamó a `process.exit` con qué código.
 *
 * Cómo leerla tras una muerte: si hay `salida`, el proceso terminó por su cuenta (mira `llamador`). Si los
 * latidos se cortan SIN `salida`, lo mataron desde fuera: `cgMemMb` cerca de `cgMaxMb` → su propio límite
 * de memoria; `maquinaOomKillsTotal` del último latido = N y del `arranque` siguiente = N+1 → el asesino de
 * memoria de la MÁQUINA (con `memory.oom.group = 1` mata al contenedor entero); todo normal → Render.
 * `throttleMs` alto con `hiloSinResponderS` alto → el hilo congelado por la cuota de 1 CPU del plan.
 *
 * 🔴 Este archivo sólo importa módulos de Node: el hilo de latidos lo carga tal cual, y cualquier
 * `import` de la app (logger, env, prisma) se ejecutaría también allá.
 */

/** La marca que deja `scripts/parchar-prisma-runtime.cjs` (una prueba fija que sean la misma). */
export const MARCA_PARCHE_PRISMA = '__avqCamposPorModelo'

const MB = 1024 * 1024
const INTERVALO_LATIDO_MS = 10_000

export type Leer = (ruta: string) => string | null

type Campos = Record<string, number | string | string[] | boolean | undefined>

/** Contadores acumulados del kernel: el latido reporta cuánto crecieron EN el intervalo. */
interface Contadores {
  cpuUs?: number
  throttleVeces?: number
  throttleUs?: number
  cgCpuEsperaUs?: number
  cgMemEsperaUs?: number
  maquinaCpuEsperaUs?: number
  maquinaMemEsperaUs?: number
  maquinaOomKills?: number
}

const leerArchivo: Leer = ruta => {
  try {
    return fs.readFileSync(ruta, 'utf8')
  } catch {
    return null
  }
}

const entero = (texto: string): number | undefined => (/^\d+$/.test(texto.trim()) ? Number(texto.trim()) : undefined)

/** `clave valor` por renglón: cpu.stat, memory.stat, memory.events, /proc/vmstat. */
const clave = (texto: string, nombre: string): number | undefined => {
  const m = new RegExp(`^${nombre} (\\d+)$`, 'm').exec(texto)
  return m ? Number(m[1]) : undefined
}

/** Presión (PSI): microsegundos acumulados en que alguna (`some`) o toda (`full`) tarea esperó. */
const psi = (texto: string, tipo: 'some' | 'full'): number | undefined => {
  const m = new RegExp(`^${tipo} .*total=(\\d+)`, 'm').exec(texto)
  return m ? Number(m[1]) : undefined
}

const mb = (bytes: number | undefined) => (bytes === undefined ? undefined : Math.round(bytes / MB))
const ms = (us: number | undefined) => (us === undefined ? undefined : Math.round(us / 1000))
/** Lo que creció un contador; nada si falta un lado o si bajó (se reinició). */
const delta = (actual: number | undefined, antes: number | undefined) =>
  actual !== undefined && antes !== undefined && actual >= antes ? actual - antes : undefined

const sinIndefinidos = (campos: Campos): Campos => Object.fromEntries(Object.entries(campos).filter(([, valor]) => valor !== undefined))

/** Una muestra de /sys y /proc. Nunca lanza: un archivo ausente o ilegible sólo omite su dato. */
export function muestrear(leer: Leer, previo: Contadores | null): { campos: Campos; contadores: Contadores } {
  const texto = (ruta: string) => {
    try {
      return leer(ruta) ?? ''
    } catch {
      return ''
    }
  }
  const cpuStat = texto('/sys/fs/cgroup/cpu.stat')
  const eventos = texto('/sys/fs/cgroup/memory.events')
  const disponibleKb = /^MemAvailable:\s+(\d+) kB$/m.exec(texto('/proc/meminfo'))?.[1]

  const contadores: Contadores = {
    cpuUs: clave(cpuStat, 'usage_usec'),
    throttleVeces: clave(cpuStat, 'nr_throttled'),
    throttleUs: clave(cpuStat, 'throttled_usec'),
    cgCpuEsperaUs: psi(texto('/sys/fs/cgroup/cpu.pressure'), 'some'),
    cgMemEsperaUs: psi(texto('/sys/fs/cgroup/memory.pressure'), 'some'),
    maquinaCpuEsperaUs: psi(texto('/proc/pressure/cpu'), 'some'),
    maquinaMemEsperaUs: psi(texto('/proc/pressure/memory'), 'full'),
    maquinaOomKills: clave(texto('/proc/vmstat'), 'oom_kill'),
  }

  const campos: Campos = {
    cgMemMb: mb(entero(texto('/sys/fs/cgroup/memory.current'))),
    cgAnonMb: mb(clave(texto('/sys/fs/cgroup/memory.stat'), 'anon')),
    cgMaxMb: mb(entero(texto('/sys/fs/cgroup/memory.max'))),
    cgEventosMax: clave(eventos, 'max'),
    cgOomKill: clave(eventos, 'oom_kill'),
    maquinaDispMb: disponibleKb === undefined ? undefined : Math.round(Number(disponibleKb) / 1024),
    // El TOTAL, no sólo el aumento: si el último latido de un contenedor dice N y el arranque del
    // siguiente dice N+1, la máquina mató a exactamente un proceso entre los dos — el nuestro.
    maquinaOomKillsTotal: contadores.maquinaOomKills,
  }

  if (previo) {
    Object.assign(campos, {
      cpuMs: ms(delta(contadores.cpuUs, previo.cpuUs)),
      throttleVeces: delta(contadores.throttleVeces, previo.throttleVeces),
      throttleMs: ms(delta(contadores.throttleUs, previo.throttleUs)),
      cgCpuEsperaMs: ms(delta(contadores.cgCpuEsperaUs, previo.cgCpuEsperaUs)),
      cgMemEsperaMs: ms(delta(contadores.cgMemEsperaUs, previo.cgMemEsperaUs)),
      maquinaCpuEsperaMs: ms(delta(contadores.maquinaCpuEsperaUs, previo.maquinaCpuEsperaUs)),
      maquinaMemEsperaMs: ms(delta(contadores.maquinaMemEsperaUs, previo.maquinaMemEsperaUs)),
      maquinaOomKills: delta(contadores.maquinaOomKills, previo.maquinaOomKills),
    })
  }

  return { campos: sinIndefinidos(campos), contadores }
}

/** Segundos que lleva el hilo principal sin marcar su tic (0 si va al día). */
export function segundosSinResponder(inicioMs: number, ahoraMs: number, ultimoTicS: number): number {
  return Math.max(0, Math.round((ahoraMs - inicioMs) / 1000) - ultimoTicS)
}

/** Una línea JSON con la misma forma que los logs de producción (`level`, `message`, `timestamp`). */
export function lineaJson(level: 'info' | 'warn', message: string, campos: Campos): string {
  return `${JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...campos })}\n`
}

type ProcesoMinimo = Pick<NodeJS.Process, 'on' | 'prependListener' | 'listenerCount' | 'exit' | 'uptime' | 'memoryUsage'>

/**
 * Ganchos del hilo principal: quién llamó a `process.exit`, la salida y las señales. Nada de esto cambia
 * qué hace el proceso, y un fallo al escribir nunca le llega al servidor.
 *
 * 🔴 NO se activa `process.report.reportOnFatalError`: el reporte de Node incluye TODAS las variables de
 * entorno (DATABASE_URL, llaves de Stripe…) y mandarlo a stderr las publicaría en Better Stack. Excluirlas
 * (`excludeEnv`) existe desde Node 22.13, y producción corre Node 20 (auditoría de Codex, 28-sep-2026).
 */
export function instalarGanchos(proc: ProcesoMinimo, escribir: (linea: string) => void): void {
  const registrar = (construir: () => string) => {
    try {
      escribir(construir())
    } catch {
      // La caja negra nunca tumba al servidor.
    }
  }
  const memoria = () => {
    const m = proc.memoryUsage()
    return { rssMb: Math.round(m.rss / MB), heapMb: Math.round(m.heapUsed / MB) }
  }

  let llamador: string[] | undefined
  const salirOriginal = proc.exit
  proc.exit = ((codigo?: number | string | null) => {
    try {
      // [0] "Error", [1] este envoltorio; desde [2], quien pidió salir.
      llamador = (new Error().stack ?? '')
        .split('\n')
        .slice(2, 10)
        .map(renglon => renglon.trim().slice(0, 200))
    } catch {
      // Sin pila, la salida se registra igual.
    }
    return salirOriginal.call(proc, codigo)
  }) as typeof proc.exit

  proc.on('exit', codigo => {
    registrar(() => lineaJson('warn', '[caja-negra] salida', { codigo, t: Math.round(proc.uptime()), ...memoria(), llamador }))
  })

  for (const senal of ['SIGTERM', 'SIGINT'] as const) {
    // Sólo si alguien ya la atiende: un oyente nuevo le quitaría a la señal su efecto por defecto. Y va
    // PRIMERO en la fila: un manejador que llama a `process.exit` sin esperar no dejaría correr al resto.
    if (proc.listenerCount(senal) === 0) continue
    proc.prependListener(senal, () => {
      registrar(() => lineaJson('warn', '[caja-negra] señal', { senal, t: Math.round(proc.uptime()), ...memoria() }))
    })
  }
}

/** ¿El runtime de Prisma que carga el cliente trae el parche del mapa de campos? */
export function parcheDePrismaActivo(
  leerRuntime: () => string = () => fs.readFileSync(require.resolve('@prisma/client/runtime/library.js'), 'utf8'),
): boolean {
  try {
    return leerRuntime().includes(MARCA_PARCHE_PRISMA)
  } catch {
    return false
  }
}

export interface EstadoCajaNegra {
  prismaParche: boolean
  latidos: boolean
}

let estado: EstadoCajaNegra | null = null

/** Arranca la caja negra. Idempotente: un reintento del arranque no duplica ganchos ni hilos. */
export function iniciarCajaNegra(opciones: { latidos: boolean }): EstadoCajaNegra {
  if (estado) return estado
  const escribir = (linea: string) => {
    fs.writeSync(1, linea)
  }

  instalarGanchos(process, escribir)
  estado = { prismaParche: parcheDePrismaActivo(), latidos: opciones.latidos && arrancarHiloDeLatidos(escribir) }

  try {
    escribir(
      lineaJson('info', '[caja-negra] arranque', {
        ...estado,
        pid: process.pid,
        node: process.version,
        heapLimiteMb: Math.round(v8.getHeapStatistics().heap_size_limit / MB),
        cpuMax: leerArchivo('/sys/fs/cgroup/cpu.max')?.trim(),
        oomScoreAdj: leerArchivo('/proc/self/oom_score_adj')?.trim(),
        ...muestrear(leerArchivo, null).campos,
      }),
    )
  } catch {
    // Sin línea de arranque, el servidor arranca igual.
  }
  return estado
}

/**
 * El hilo aparte carga ESTE archivo ya compilado. En desarrollo (tsx) no hay `.js` que cargar, y ahí la
 * caja negra no hace falta.
 */
function arrancarHiloDeLatidos(escribir: (linea: string) => void): boolean {
  if (!__filename.endsWith('.js')) return false
  try {
    // [0] segundo en que el hilo principal marcó su último tic, [1] su heap en MB.
    const compartido = new Int32Array(new SharedArrayBuffer(8))
    const inicioMs = Date.now()
    const tic = () => {
      Atomics.store(compartido, 0, Math.round((Date.now() - inicioMs) / 1000))
      Atomics.store(compartido, 1, Math.round(v8.getHeapStatistics().used_heap_size / MB))
    }
    tic()
    setInterval(tic, 1000).unref()

    const hilo = new Worker(__filename, {
      workerData: { cajaNegra: true, compartido, inicioMs, intervaloMs: INTERVALO_LATIDO_MS },
      execArgv: [], // sólo módulos de Node: nada que precargar
      resourceLimits: { maxOldGenerationSizeMb: 32 },
    })
    hilo.unref()
    // Sin este oyente, un error del hilo se volvería una excepción del proceso entero.
    hilo.on('error', error => {
      try {
        escribir(lineaJson('warn', '[caja-negra] el hilo de latidos se detuvo', { error: String(error) }))
      } catch {
        // Nada: los latidos son un extra.
      }
    })
    return true
  } catch {
    return false
  }
}

/** Dentro del hilo aparte: un latido ahora y otro cada `intervaloMs`, pase lo que pase con el principal. */
function latir(datos: { compartido: Int32Array; inicioMs: number; intervaloMs: number }): void {
  let previo: Contadores | null = null
  const uno = () => {
    try {
      const { campos, contadores } = muestrear(leerArchivo, previo)
      previo = contadores
      fs.writeSync(
        1,
        lineaJson('info', '[caja-negra] latido', {
          rssMb: Math.round(process.memoryUsage.rss() / MB),
          heapMb: Atomics.load(datos.compartido, 1),
          hiloSinResponderS: segundosSinResponder(datos.inicioMs, Date.now(), Atomics.load(datos.compartido, 0)),
          ...campos,
        }),
      )
    } catch {
      // Un latido perdido no importa: el siguiente sale en 10 s.
    }
  }
  uno()
  setInterval(uno, datos.intervaloMs)
}

if (!isMainThread && workerData?.cajaNegra) latir(workerData)
