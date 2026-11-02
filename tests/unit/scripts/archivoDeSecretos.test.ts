/**
 * El archivo de secretos de los avisos de Rappi: escribirlo sin poder dejarlo a medias y no correr dos veces a la vez.
 *
 * Lo que protegen (hallazgos #2 y #3 de Codex, bloque 0 de «Rappi fase 2»):
 *  · 🔴 `writeFileSync` TRUNCA el destino antes de escribir: un disco lleno a media escritura dejaba vacío el archivo que tenía
 *    los únicos secretos que existen (los de tienda, Rappi no los vuelve a mostrar). Ahora se escribe a un temporal y se
 *    renombra encima: o queda el contenido viejo o el nuevo, nunca uno a medias.
 *  · 🔴 Dos corridas a la vez con el mismo archivo podían terminar «bien» con claves distintas en Rappi y en disco. El candado
 *    (`<salida>.lock`, creado con `wx`) hace que la segunda se niegue antes de leer nada.
 * Todo contra un directorio temporal REAL (`mkdtemp`), no contra un `fs` simulado: lo que importa es lo que queda en disco.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

import { conCandado, escribirAtomico600 } from '../../../scripts/_archivo-de-secretos'

let dir: string
let ruta: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rappi-secretos-'))
  ruta = path.join(dir, 'secretos.json')
})

afterEach(() => {
  jest.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

const modo = (r: string) => fs.statSync(r).mode & 0o777
const leer = (r: string) => fs.readFileSync(r, 'utf8')
const BUENO = '{\n  "NEW_ORDER": "el-unico-que-existe"\n}\n'
const NUEVO = '{\n  "NEW_ORDER": "el-unico-que-existe",\n  "PING": "otro"\n}\n'
const discoLleno = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })

describe('escribirAtomico600', () => {
  // ── 1 · FUNCIÓN NUEVA ───────────────────────────────────────────────────────────────
  it('crea el archivo con el texto y permisos 600, aunque la umask del proceso sea permisiva', () => {
    const umask = process.umask(0)
    try {
      escribirAtomico600(ruta, BUENO)
    } finally {
      process.umask(umask)
    }

    expect(leer(ruta)).toBe(BUENO)
    expect(modo(ruta)).toBe(0o600)
    expect(fs.readdirSync(dir)).toEqual(['secretos.json']) // ni un temporal sobrante
  })

  it('reemplaza uno que ya existía y le cierra los permisos (644 ⇒ 600)', () => {
    fs.writeFileSync(ruta, BUENO, { mode: 0o644 })
    fs.chmodSync(ruta, 0o644)

    escribirAtomico600(ruta, NUEVO)

    expect(leer(ruta)).toBe(NUEVO)
    expect(modo(ruta)).toBe(0o600)
    expect(fs.readdirSync(dir)).toEqual(['secretos.json'])
  })

  it('🔴 el temporal nace en 600: nunca existe un archivo con secretos y permisos abiertos', () => {
    const umask = process.umask(0)
    const real = fs.writeSync
    const modosAlEscribir: number[] = []
    jest.spyOn(fs, 'writeSync').mockImplementation(((fd: number, ...resto: unknown[]) => {
      modosAlEscribir.push(fs.fstatSync(fd).mode & 0o777)
      return (real as (...a: unknown[]) => number)(fd, ...resto)
    }) as typeof fs.writeSync)
    try {
      escribirAtomico600(ruta, NUEVO)
    } finally {
      process.umask(umask)
    }

    expect(modosAlEscribir.length).toBeGreaterThan(0)
    expect(modosAlEscribir.every(m => m === 0o600)).toBe(true)
  })

  it('🔴 un fallo de disco DESPUÉS de truncar (a media escritura) deja el destino INTACTO y borra el temporal', () => {
    fs.writeFileSync(ruta, BUENO, { mode: 0o600 })
    const real = fs.writeSync
    const aMedias = (fd: number, datos: Buffer, offset?: number, largo?: number): number => {
      const desde = offset ?? 0
      ;(real as (...a: unknown[]) => number)(fd, datos, desde, Math.min(largo ?? datos.length - desde, 5)) // escribe un pedazo…
      throw discoLleno() // …y el disco se llena
    }
    jest.spyOn(fs, 'writeSync').mockImplementation(aMedias as unknown as typeof fs.writeSync)

    expect(() => escribirAtomico600(ruta, NUEVO)).toThrow(/ENOSPC/)

    expect(leer(ruta)).toBe(BUENO)
    expect(modo(ruta)).toBe(0o600)
    expect(fs.readdirSync(dir)).toEqual(['secretos.json'])
  })

  it('🔴 si el disco se llena al confirmar (fsync), el destino también queda intacto', () => {
    fs.writeFileSync(ruta, BUENO, { mode: 0o600 })
    jest.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw discoLleno()
    })

    expect(() => escribirAtomico600(ruta, NUEVO)).toThrow(/ENOSPC/)

    expect(leer(ruta)).toBe(BUENO)
    expect(fs.readdirSync(dir)).toEqual(['secretos.json'])
  })

  it('si el reemplazo falla (el destino es una carpeta), el temporal se borra y el error sale', () => {
    fs.mkdirSync(ruta)
    fs.writeFileSync(path.join(ruta, 'algo'), 'x')

    expect(() => escribirAtomico600(ruta, NUEVO)).toThrow()

    expect(fs.readdirSync(dir)).toEqual(['secretos.json'])
    expect(fs.statSync(ruta).isDirectory()).toBe(true)
  })

  it('una carpeta que no existe falla sin crear nada', () => {
    expect(() => escribirAtomico600(path.join(dir, 'no-existe', 'secretos.json'), NUEVO)).toThrow(/ENOENT/)
    expect(fs.readdirSync(dir)).toEqual([])
  })
})

describe('conCandado', () => {
  const candado = () => `${ruta}.lock`

  it('mientras corre, el candado existe (600) con el pid y la hora; al terminar lo suelta y devuelve el resultado', async () => {
    let visto: { contenido: string; modo: number } | undefined

    const r = await conCandado(candado(), async () => {
      visto = { contenido: leer(candado()), modo: modo(candado()) }
      return 42
    })

    expect(r).toBe(42)
    expect(visto?.modo).toBe(0o600)
    expect(visto?.contenido).toContain(`pid=${process.pid}`)
    expect(visto?.contenido).toMatch(/desde=\d{4}-\d{2}-\d{2}T/)
    expect(fs.existsSync(candado())).toBe(false)
  })

  it('🔴 lo suelta también si la tarea falla, y el error sale tal cual', async () => {
    await expect(
      conCandado(candado(), async () => {
        throw new Error('Rappi respondió 500')
      }),
    ).rejects.toThrow('Rappi respondió 500')

    expect(fs.existsSync(candado())).toBe(false)
  })

  it('🔴 si ya existe NO corre la tarea, no lo borra ni lo cambia, y dice qué pasa y qué hacer (con la ruta)', async () => {
    fs.writeFileSync(candado(), 'pid=999 desde=2026-10-21T10:00:00.000Z\n')
    const tarea = jest.fn(async () => 1)

    const fallo = conCandado(candado(), tarea)

    await expect(fallo).rejects.toThrow(/otra corrida/i)
    await expect(conCandado(candado(), tarea)).rejects.toThrow(/murió/i)
    await expect(conCandado(candado(), tarea)).rejects.toThrow(/bórralo a mano/i)
    await expect(conCandado(candado(), tarea)).rejects.toThrow(candado())
    await expect(conCandado(candado(), tarea)).rejects.toThrow(/pid=999/) // a quién pertenece, para decidir
    expect(tarea).not.toHaveBeenCalled()
    expect(leer(candado())).toBe('pid=999 desde=2026-10-21T10:00:00.000Z\n')
  })

  it('🔴 dos corridas a la vez: la segunda se niega y la primera termina', async () => {
    let soltar: () => void = () => undefined
    const primera = conCandado(candado(), () => new Promise<string>(ok => (soltar = () => ok('primera'))))

    await expect(conCandado(candado(), async () => 'segunda')).rejects.toThrow(/otra corrida/i)

    soltar()
    await expect(primera).resolves.toBe('primera')
    expect(fs.existsSync(candado())).toBe(false)
  })

  it('no borra un candado que ya no es suyo (alguien borró el suyo a mano y otra corrida tomó uno nuevo)', async () => {
    await conCandado(candado(), async () => {
      fs.rmSync(candado())
      fs.writeFileSync(candado(), 'pid=777 desde=2026-10-21T11:00:00.000Z\n')
    })

    expect(leer(candado())).toBe('pid=777 desde=2026-10-21T11:00:00.000Z\n')
  })
})
