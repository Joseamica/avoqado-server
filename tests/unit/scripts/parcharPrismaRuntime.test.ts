/**
 * Parche de rendimiento al runtime de Prisma 6 (`scripts/parchar-prisma-runtime.cjs`).
 *
 * Perfil V8 de producción del 28-sep-2026: el medio segundo crónico de hilo retenido era Prisma
 * reconstruyendo, en CADA findUnique/findFirst/create/update/upsert/delete, un mapa nombre→campo del
 * modelo con `reduce` + spread — O(n²) en tiempo y en basura. Venue tiene 256 campos: 3.3 ms por
 * consulta y el GC que eso provoca. El parche construye el mapa una vez por modelo.
 *
 * Estas pruebas ejercen el TEXTO real que el parche deja en node_modules (no una copia a mano): se arma
 * la función con ese texto y se compara el mapa que produce contra el del código original de Prisma.
 */
import fs from 'node:fs'
import path from 'node:path'

import { MARCA_PARCHE_PRISMA } from '@/observability/cajaNegra'

const { parchar, aplicarParche, ORIGINAL, PARCHADO, MARCA } = require('../../../scripts/parchar-prisma-runtime.cjs') as {
  parchar: (codigo: string) => { estado: 'aplicado' | 'ya-aplicado' | 'sin-ancla'; codigo: string }
  aplicarParche: (archivo: string, sistema: unknown) => { estado: string; detalle?: string }
  ORIGINAL: string
  PARCHADO: string
  MARCA: string
}

type Campo = { name: string; kind?: string; type?: string }
type ClienteFalso = { _runtimeDataModel: { models: Record<string, { fields: Campo[] }> } }
type Lo = (cliente: ClienteFalso, modelo: string) => Record<string, Campo>

/**
 * Arma `lo` con el texto de Prisma cortado justo después de calcular el mapa `a`, y devuelve ese mapa
 * en vez del Proxy del API fluido. Así se prueba exactamente la parte que el parche reemplaza.
 */
function armarLo(prefijo: string): Lo {
  return new Function(`${prefijo}return a}return lo`)() as Lo
}

const campos = (): Campo[] => [
  { name: 'id', kind: 'scalar', type: 'String' },
  { name: 'name', kind: 'scalar', type: 'String' },
  { name: 'staff', kind: 'object', type: 'StaffVenue' },
  { name: 'orders', kind: 'object', type: 'Order' },
]

const cliente = (): ClienteFalso => ({ _runtimeDataModel: { models: { Venue: { fields: campos() } } } })

describe('parche del runtime de Prisma — el mapa de campos se arma una vez por modelo', () => {
  it('produce el MISMO mapa que el código original de Prisma: mismos campos, mismo orden', () => {
    const original = armarLo(ORIGINAL)(cliente(), 'Venue')
    const parchado = armarLo(PARCHADO)(cliente(), 'Venue')

    expect(parchado).toEqual(original)
    expect(Object.keys(parchado)).toEqual(Object.keys(original))
    expect(parchado.staff.type).toBe('StaffVenue')
  })

  it('🔴 no lo reconstruye en cada consulta: la segunda vez devuelve el mismo mapa', () => {
    const c = cliente()
    const loParchado = armarLo(PARCHADO)
    expect(loParchado(c, 'Venue')).toBe(loParchado(c, 'Venue'))

    // El defecto que se corrige: el original arma un mapa nuevo (O(n²)) en cada acceso.
    const loOriginal = armarLo(ORIGINAL)
    expect(loOriginal(c, 'Venue')).not.toBe(loOriginal(c, 'Venue'))
  })

  it('un modelo no reutiliza el mapa de otro', () => {
    const c: ClienteFalso = {
      _runtimeDataModel: {
        models: { Venue: { fields: campos() }, Order: { fields: [{ name: 'total', kind: 'scalar' }] } },
      },
    }
    const lo = armarLo(PARCHADO)

    expect(Object.keys(lo(c, 'Order'))).toEqual(['total'])
    expect(Object.keys(lo(c, 'Venue'))).toEqual(['id', 'name', 'staff', 'orders'])
  })

  it('dos clientes con modelos distintos del mismo nombre no se mezclan (la llave es el modelo, no el nombre)', () => {
    const lo = armarLo(PARCHADO)
    const a = lo(cliente(), 'Venue')
    const b = lo({ _runtimeDataModel: { models: { Venue: { fields: [{ name: 'otro' }] } } } }, 'Venue')

    expect(Object.keys(a)).toEqual(['id', 'name', 'staff', 'orders'])
    expect(Object.keys(b)).toEqual(['otro'])
  })

  it('un nombre de campo repetido conserva al último, igual que el original', () => {
    const repetido = (): ClienteFalso => ({
      _runtimeDataModel: {
        models: {
          X: {
            fields: [
              { name: 'a', type: 'uno' },
              { name: 'a', type: 'dos' },
            ],
          },
        },
      },
    })

    expect(armarLo(PARCHADO)(repetido(), 'X')).toEqual(armarLo(ORIGINAL)(repetido(), 'X'))
    expect(armarLo(PARCHADO)(repetido(), 'X').a.type).toBe('dos')
  })
})

describe('parche del runtime de Prisma — cómo se aplica', () => {
  const runtimeFalso = `"use strict";var x=1;${ORIGINAL}return l=>{};}var Om=[];`

  it('reemplaza la función original por la versión que guarda el mapa', () => {
    const { estado, codigo } = parchar(runtimeFalso)

    expect(estado).toBe('aplicado')
    expect(codigo).toContain(MARCA)
    expect(codigo).not.toContain(ORIGINAL)
    // El resto del archivo queda intacto, byte por byte.
    expect(codigo).toBe(runtimeFalso.replace(ORIGINAL, () => PARCHADO))
  })

  it('es idempotente: correrlo dos veces no parcha dos veces', () => {
    const primera = parchar(runtimeFalso).codigo
    const segunda = parchar(primera)

    expect(segunda.estado).toBe('ya-aplicado')
    expect(segunda.codigo).toBe(primera)
  })

  it('🔴 si Prisma cambió su código, no toca nada y lo dice (el build no se cae por una optimización)', () => {
    const otroPrisma = '"use strict";function lo(e,r){return e}'
    expect(parchar(otroPrisma)).toEqual({ estado: 'sin-ancla', codigo: otroPrisma })
  })

  it('si el ancla aparece dos veces no adivina cuál parchar', () => {
    const doble = `${ORIGINAL}}${ORIGINAL}}`
    expect(parchar(doble)).toEqual({ estado: 'sin-ancla', codigo: doble })
  })
})

describe('🔴 parche del runtime de Prisma — nunca detiene el build', () => {
  const RUTA = '/rt/library.js'
  const runtime = `"use strict";${ORIGINAL}return l=>{};}`

  /** Un sistema de archivos de mentira que puede fallar en un paso a elegir. */
  const sistemaFalso = (fallaAl?: 'leer' | 'escribir' | 'renombrar') => {
    const archivos = new Map<string, string>([[RUTA, runtime]])
    return {
      archivos,
      readFileSync: (ruta: string) => {
        if (fallaAl === 'leer') throw new Error('EACCES al leer')
        return archivos.get(ruta)
      },
      writeFileSync: (ruta: string, contenido: string) => {
        if (fallaAl === 'escribir') throw new Error('ENOSPC al escribir')
        archivos.set(ruta, contenido)
      },
      renameSync: (de: string, a: string) => {
        if (fallaAl === 'renombrar') throw new Error('EACCES al renombrar')
        archivos.set(a, archivos.get(de) as string)
        archivos.delete(de)
      },
      rmSync: (ruta: string) => {
        archivos.delete(ruta)
      },
    }
  }

  it('escribe aparte y renombra: nadie ve el archivo a medias, y no queda el temporal', () => {
    const sistema = sistemaFalso()

    expect(aplicarParche(RUTA, sistema)).toEqual({ estado: 'aplicado' })
    expect(sistema.archivos.get(RUTA)).toContain(MARCA)
    expect([...sistema.archivos.keys()]).toEqual([RUTA])
  })

  it.each(['leer', 'escribir', 'renombrar'] as const)(
    'si falla al %s, no lanza: deja el runtime como estaba y borra el temporal',
    fallaAl => {
      const sistema = sistemaFalso(fallaAl)

      const resultado = aplicarParche(RUTA, sistema)

      expect(resultado.estado).toBe('error')
      expect(resultado.detalle).toContain(`al ${fallaAl}`)
      expect(sistema.archivos.get(RUTA)).toBe(runtime)
      expect([...sistema.archivos.keys()]).toEqual([RUTA])
    },
  )
})

describe('parche del runtime de Prisma — lo que está instalado y cómo llega a producción', () => {
  const raiz = path.resolve(__dirname, '../../..')

  it('🔴 la versión de Prisma instalada trae el código que el parche espera (o ya viene parchada)', () => {
    const runtime = require.resolve('@prisma/client/runtime/library.js')
    const { estado } = parchar(fs.readFileSync(runtime, 'utf8'))

    // Si esto falla tras actualizar Prisma: el parche dejó de aplicar y el servidor volvería a pagar
    // el mapa O(n²) en cada consulta. Revisa si la nueva versión ya lo corrigió o actualiza el ancla.
    expect(['aplicado', 'ya-aplicado']).toContain(estado)
  })

  it('el cliente generado carga justo el archivo que se parcha', () => {
    const generado = fs.readFileSync(path.join(raiz, 'node_modules/.prisma/client/index.js'), 'utf8')
    expect(generado).toContain("require('@prisma/client/runtime/library.js')")
  })

  it('el build de producción (el que corre Render) aplica el parche', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'))
    expect(pkg.scripts.build.startsWith('node scripts/parchar-prisma-runtime.cjs && ')).toBe(true)
  })

  it('el arranque del servidor busca la misma marca que deja el parche', () => {
    expect(MARCA_PARCHE_PRISMA).toBe(MARCA)
  })
})
