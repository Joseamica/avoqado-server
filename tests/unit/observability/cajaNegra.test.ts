/**
 * Caja negra del proceso (`src/observability/cajaNegra.ts`).
 *
 * El 27 y el 28-sep-2026 el contenedor de producción murió de golpe dos veces: sin error, sin SIGTERM,
 * sin evento de Render. No quedó nada que dijera por qué. La caja negra deja, con escrituras síncronas:
 * un latido cada 10 s desde un hilo aparte (memoria del proceso y del contenedor, throttling de CPU,
 * presión, memoria de la máquina, y cuánto lleva sin responder el hilo principal), y quién llamó a
 * `process.exit` o qué señal llegó.
 *
 * Los textos de /sys y /proc de abajo son reales: se leyeron del contenedor de producción el
 * 28-sep-2026 (sólo lectura, por SSH).
 */
import { EventEmitter } from 'node:events'

import {
  instalarGanchos,
  lineaJson,
  muestrear,
  parcheDePrismaActivo,
  segundosSinResponder,
  type Leer,
  MARCA_PARCHE_PRISMA,
} from '@/observability/cajaNegra'

const MB = 1024 * 1024

/** Archivos reales del contenedor de producción (28-sep-2026, ~04:50Z). */
const produccion: Record<string, string> = {
  '/sys/fs/cgroup/memory.current': '605913088\n',
  '/sys/fs/cgroup/memory.max': '2147483648\n',
  '/sys/fs/cgroup/memory.events': 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\nsock_throttled 0\n',
  '/sys/fs/cgroup/memory.stat': 'anon 421666816\nfile 127119360\nkernel 56152064\nsock 0\nshmem 0\n',
  '/sys/fs/cgroup/memory.pressure':
    'some avg10=0.00 avg60=0.00 avg300=0.00 total=5375\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=5375\n',
  '/sys/fs/cgroup/cpu.stat':
    'usage_usec 167740045\nuser_usec 134745813\nsystem_usec 32994231\nnice_usec 0\n' +
    'core_sched.force_idle_usec 0\nnr_periods 34778\nnr_throttled 605\nthrottled_usec 125355308\n',
  '/sys/fs/cgroup/cpu.pressure':
    'some avg10=0.36 avg60=0.15 avg300=0.44 total=33815126\nfull avg10=0.36 avg60=0.14 avg300=0.36 total=31014603\n',
  '/proc/meminfo': 'MemTotal:       32134512 kB\nMemFree:  1000 kB\nMemAvailable:    5258788 kB\n',
  '/proc/vmstat': 'nr_free_pages 1\noom_kill 1494\nnr_zone_active_anon 2\n',
  '/proc/pressure/memory':
    'some avg10=0.00 avg60=0.00 avg300=0.00 total=2467223626\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1949676352\n',
  '/proc/pressure/cpu': 'some avg10=11.86 avg60=15.24 avg300=17.39 total=1108822081431\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
}

const lector =
  (archivos: Record<string, string>): Leer =>
  ruta =>
    archivos[ruta] ?? null

/** Diez segundos después: el contenedor fue frenado por cuota, esperó CPU y la máquina mató a alguien. */
const diezSegundosDespues: Record<string, string> = {
  ...produccion,
  '/sys/fs/cgroup/cpu.stat':
    'usage_usec 168740045\nuser_usec 134745813\nsystem_usec 32994231\nnice_usec 0\n' +
    'core_sched.force_idle_usec 0\nnr_periods 34878\nnr_throttled 612\nthrottled_usec 126655308\n',
  '/sys/fs/cgroup/cpu.pressure':
    'some avg10=9.00 avg60=0.15 avg300=0.44 total=35015126\nfull avg10=0.36 avg60=0.14 avg300=0.36 total=31014603\n',
  '/sys/fs/cgroup/memory.pressure':
    'some avg10=0.00 avg60=0.00 avg300=0.00 total=9375\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=6375\n',
  '/proc/vmstat': 'nr_free_pages 1\noom_kill 1496\nnr_zone_active_anon 2\n',
  '/proc/pressure/memory':
    'some avg10=0.00 avg60=0.00 avg300=0.00 total=2467223626\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1950176352\n',
  '/proc/pressure/cpu': 'some avg10=11.86 avg60=15.24 avg300=17.39 total=1108825081431\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
}

describe('caja negra — qué dice un latido', () => {
  it('lee la memoria del contenedor y de la máquina en MB', () => {
    const { campos } = muestrear(lector(produccion), null)

    expect(campos.cgMemMb).toBe(578)
    expect(campos.cgAnonMb).toBe(402)
    expect(campos.cgMaxMb).toBe(2048)
    expect(campos.cgEventosMax).toBe(0)
    expect(campos.cgOomKill).toBe(0)
    expect(campos.maquinaDispMb).toBe(5136)
  })

  it('🔴 lleva el TOTAL de muertes por memoria de la máquina: comparado con el arranque siguiente, prueba quién mató', () => {
    const primero = muestrear(lector(produccion), null)
    const { campos } = muestrear(lector(diezSegundosDespues), primero.contadores)

    expect(primero.campos.maquinaOomKillsTotal).toBe(1494)
    expect(campos.maquinaOomKillsTotal).toBe(1496)
  })

  it('el primer latido no inventa lo que pasó "en el intervalo": no hay intervalo todavía', () => {
    const { campos } = muestrear(lector(produccion), null)

    expect(campos).not.toHaveProperty('throttleMs')
    expect(campos).not.toHaveProperty('cpuMs')
    expect(campos).not.toHaveProperty('maquinaOomKills')
  })

  it('🔴 reporta lo que pasó EN el intervalo: CPU usada, throttling, espera de CPU y memoria', () => {
    const primero = muestrear(lector(produccion), null)
    const { campos } = muestrear(lector(diezSegundosDespues), primero.contadores)

    expect(campos.cpuMs).toBe(1000)
    expect(campos.throttleVeces).toBe(7)
    expect(campos.throttleMs).toBe(1300)
    expect(campos.cgCpuEsperaMs).toBe(1200)
    expect(campos.cgMemEsperaMs).toBe(4)
    expect(campos.maquinaCpuEsperaMs).toBe(3000)
    expect(campos.maquinaMemEsperaMs).toBe(500)
    expect(campos.maquinaOomKills).toBe(2)
  })

  it('un contador que bajó (se reinició) no se reporta como un número negativo', () => {
    const primero = muestrear(lector(diezSegundosDespues), null)
    const { campos } = muestrear(lector(produccion), primero.contadores)

    expect(campos).not.toHaveProperty('throttleMs')
    expect(campos).not.toHaveProperty('maquinaOomKills')
  })

  it('🔴 un archivo que no existe (macOS, kernel sin PSI) no rompe la muestra: sólo falta ese dato', () => {
    const soloMemoria = lector({ '/sys/fs/cgroup/memory.current': '605913088\n' })
    const primero = muestrear(soloMemoria, null)
    const { campos } = muestrear(soloMemoria, primero.contadores)

    expect(campos).toEqual({ cgMemMb: 578 })
  })

  it('basura en un archivo tampoco rompe la muestra', () => {
    const basura = lector({
      '/sys/fs/cgroup/memory.current': 'max\n',
      '/sys/fs/cgroup/cpu.stat': 'usage_usec abc\n',
      '/proc/meminfo': 'MemAvailable: nada\n',
    })

    expect(() => muestrear(basura, null)).not.toThrow()
    expect(muestrear(basura, null).campos).toEqual({})
  })

  it('un lector que lanza no rompe la muestra', () => {
    const roto: Leer = () => {
      throw new Error('EACCES')
    }
    expect(muestrear(roto, null).campos).toEqual({})
  })
})

// Sólo la aritmética: que el hilo aparte escribe con el principal congelado se probó fuera de Jest
// (el hilo carga el .js compilado), con un bloqueo real de 12 s — ver el reporte del 28-sep.
describe('caja negra — cuántos segundos lleva sin responder el hilo principal', () => {
  it('🔴 cuenta los segundos desde el último tic del hilo principal', () => {
    const inicio = 1_000_000
    // El hilo principal marcó el segundo 40; ahora es el segundo 47: lleva 7 s sin poder correr.
    expect(segundosSinResponder(inicio, inicio + 47_000, 40)).toBe(7)
  })

  it('un hilo principal al día marca 0 (o 1 por redondeo), nunca negativo', () => {
    const inicio = 1_000_000
    expect(segundosSinResponder(inicio, inicio + 40_400, 40)).toBe(0)
    expect(segundosSinResponder(inicio, inicio + 39_000, 40)).toBe(0)
  })
})

describe('caja negra — formato de las líneas', () => {
  it('es JSON de una sola línea, con el mismo formato que el resto de los logs de producción', () => {
    const linea = lineaJson('info', '[caja-negra] latido', { cgMemMb: 578, hiloSinResponderS: 0 })
    const registro = JSON.parse(linea)

    expect(linea.endsWith('\n')).toBe(true)
    expect(linea.trimEnd()).not.toContain('\n')
    expect(registro).toMatchObject({ level: 'info', message: '[caja-negra] latido', cgMemMb: 578 })
    expect(typeof registro.timestamp).toBe('string')
  })

  it('🔴 una línea completa cabe en una sola escritura atómica al pipe (< 4 KB): no se mezcla con otra', () => {
    const primero = muestrear(lector(produccion), null)
    const { campos } = muestrear(lector(diezSegundosDespues), primero.contadores)
    const latido = lineaJson('info', '[caja-negra] latido', { ...campos, rssMb: 700, heapMb: 300, hiloSinResponderS: 3 })

    expect(Buffer.byteLength(latido)).toBeLessThan(4096)
  })
})

/** Un `process` de mentira: lo justo para instalar los ganchos sin tocar el proceso de Jest. */
function procesoFalso(senalesAtendidas: string[] = []) {
  const emisor = new EventEmitter()
  const salidas: Array<number | string | null | undefined> = []
  const proc = Object.assign(emisor, {
    exit: (codigo?: number | string | null) => {
      salidas.push(codigo)
    },
    uptime: () => 12.3,
    memoryUsage: () => ({ rss: 700 * MB, heapUsed: 300 * MB }),
    report: { reportOnFatalError: false, filename: '', excludeNetwork: false },
  })
  for (const senal of senalesAtendidas) emisor.on(senal, () => undefined)
  return { proc, salidas }
}

describe('caja negra — ganchos del proceso', () => {
  it('🔴 registra quién llamó a process.exit y con qué código, y la salida sí ocurre', () => {
    const { proc, salidas } = procesoFalso()
    const lineas: string[] = []
    instalarGanchos(proc as never, linea => lineas.push(linea))

    proc.exit(3)
    proc.emit('exit', 3)

    expect(salidas).toEqual([3]) // el exit original se llamó, con el mismo código
    const salida = JSON.parse(lineas[0])
    expect(salida).toMatchObject({ level: 'warn', message: '[caja-negra] salida', codigo: 3, rssMb: 700, heapMb: 300 })
    expect(salida.llamador.join('\n')).toContain('cajaNegra.test')
  })

  it('una salida sin process.exit (el bucle se vació) no inventa un llamador', () => {
    const { proc } = procesoFalso()
    const lineas: string[] = []
    instalarGanchos(proc as never, linea => lineas.push(linea))

    proc.emit('exit', 0)

    expect(JSON.parse(lineas[0])).not.toHaveProperty('llamador')
  })

  it('🔴 sólo observa señales que alguien ya atiende: no cambia qué hace el proceso con SIGTERM', () => {
    const { proc } = procesoFalso(['SIGTERM'])
    const lineas: string[] = []
    instalarGanchos(proc as never, linea => lineas.push(linea))

    // SIGTERM ya tenía quién la atendiera: observarla no cambia nada.
    expect(proc.listenerCount('SIGTERM')).toBe(2)
    // SIGINT no tenía a nadie: agregar un oyente le quitaría su efecto por defecto (terminar).
    expect(proc.listenerCount('SIGINT')).toBe(0)

    proc.emit('SIGTERM')
    expect(JSON.parse(lineas[0])).toMatchObject({ message: '[caja-negra] señal', senal: 'SIGTERM' })
  })

  it('🔴 la señal queda escrita aunque el manejador que ya estaba cierre el proceso al instante', () => {
    const { proc } = procesoFalso()
    // Como el apagado rápido de desarrollo: llama a process.exit sin esperar y nada después corre.
    proc.on('SIGTERM', () => {
      throw new Error('el proceso ya terminó')
    })
    const lineas: string[] = []
    instalarGanchos(proc as never, linea => lineas.push(linea))

    expect(() => proc.emit('SIGTERM')).toThrow('el proceso ya terminó')
    expect(JSON.parse(lineas[0])).toMatchObject({ message: '[caja-negra] señal', senal: 'SIGTERM' })
  })

  it('🔴 NO activa el reporte fatal de Node: en Node 20 publicaría las variables de entorno (credenciales) en los logs', () => {
    const { proc } = procesoFalso()
    instalarGanchos(proc as never, () => undefined)

    expect(proc.report).toEqual({ reportOnFatalError: false, filename: '', excludeNetwork: false })
  })

  it('🔴 si escribir falla, el proceso no se entera (la caja negra nunca tumba al servidor)', () => {
    const { proc, salidas } = procesoFalso(['SIGTERM'])
    instalarGanchos(proc as never, () => {
      throw new Error('EAGAIN')
    })

    expect(() => proc.emit('SIGTERM')).not.toThrow()
    expect(() => proc.exit(1)).not.toThrow()
    expect(() => proc.emit('exit', 1)).not.toThrow()
    expect(salidas).toEqual([1])
  })
})

describe('caja negra — ¿quedó activo el parche de Prisma?', () => {
  it('sí, cuando el runtime instalado trae la marca del parche', () => {
    expect(parcheDePrismaActivo(() => `var ${MARCA_PARCHE_PRISMA}=new WeakMap;function lo(){}`)).toBe(true)
  })

  it('no, cuando el runtime no la trae (build sin el paso del parche, o Prisma cambió)', () => {
    expect(parcheDePrismaActivo(() => 'function lo(){}')).toBe(false)
  })

  it('no, y sin lanzar, cuando el runtime no se puede leer', () => {
    expect(
      parcheDePrismaActivo(() => {
        throw new Error('ENOENT')
      }),
    ).toBe(false)
  })
})
