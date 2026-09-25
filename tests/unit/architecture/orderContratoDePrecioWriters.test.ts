/**
 * IVA por producto, plan 2: TODO escritor de Order declara el contrato de precio al crear, y NADIE lo reescribe en
 * un update salvo la fusión de cuentas y la confirmación histórica. Un escritor nuevo sin declararlo tumba esta
 * prueba con su archivo y línea — así la facturación (plan 3) nunca lee un contrato que alguien olvidó escribir.
 */
import fs from 'fs'
import path from 'path'

const SRC = path.join(__dirname, '../../../src')

function archivosTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : archivosTs(p)
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [p] : []
  })
}

const esComentario = (linea: string) => /^\s*(\/\/|\*|\/\*)/.test(linea)

/** Texto de la llamada: desde la línea del `(` hasta que cierran los paréntesis (tope 150 líneas). */
function llamada(lineas: string[], i: number): string {
  let prof = 0
  let abrio = false
  const out: string[] = []
  for (let j = i; j < Math.min(lineas.length, i + 150); j++) {
    out.push(lineas[j])
    for (const ch of lineas[j]) {
      if (ch === '(') {
        prof++
        abrio = true
      } else if (ch === ')') prof--
    }
    if (abrio && prof <= 0) break
  }
  return out.join('\n')
}

/** Nombre de la función de primer nivel que contiene la línea i (la declaración más cercana hacia arriba). */
function funcionQueContiene(lineas: string[], i: number): string | null {
  for (let j = i; j >= 0; j--) {
    // F6 (revisión final): cualquier `const nombre =` de primer nivel cuenta, no sólo
    // `= async` — un escritor declarado como `export const foo: Tipo = (...) => {}` (sin
    // "async" pegado al "=", por una anotación de tipo de por medio, o simplemente síncrono)
    // se perdía antes como `funcion: null`, lo que lo dejaba SIEMPRE fuera de
    // REESCRITURA_AUTORIZADA sin importar su nombre real.
    const m = lineas[j].match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/) ?? lineas[j].match(/^(?:export\s+)?const\s+(\w+)\s*=/)
    if (m) return m[1]
  }
  return null
}

const CREA = /\.order\s*\.\s*(create|upsert)\s*\(/
const ACTUALIZA = /\.order\s*\.\s*(update|updateMany)\s*\(/

/** Pendientes: la Tarea 5 quita las funciones de split. Esta lista sólo encoge. */
const PENDIENTES: Array<{ archivo: string; funcion?: string }> = []

/** Únicos lugares autorizados a CAMBIAR el contrato después de crear. */
const REESCRITURA_AUTORIZADA = new Set(['mergeOrders', 'confirmarContratoIvaIncluido'])

type Sitio = { rel: string; linea: number; funcion: string | null; declara: boolean }

function escanear() {
  const creates: Sitio[] = []
  const reescrituras: Sitio[] = []
  for (const archivo of archivosTs(SRC)) {
    const rel = path.relative(SRC, archivo).split(path.sep).join('/')
    const lineas = fs.readFileSync(archivo, 'utf8').split('\n')
    lineas.forEach((linea, i) => {
      if (esComentario(linea)) return
      if (CREA.test(linea)) {
        creates.push({
          rel,
          linea: i + 1,
          funcion: funcionQueContiene(lineas, i),
          declara: /contratoDePrecio\s*:/.test(llamada(lineas, i)),
        })
      }
      if (ACTUALIZA.test(linea) && /contratoDePrecio\s*:/.test(llamada(lineas, i))) {
        const funcion = funcionQueContiene(lineas, i)
        if (!funcion || !REESCRITURA_AUTORIZADA.has(funcion)) reescrituras.push({ rel, linea: i + 1, funcion, declara: true })
      }
    })
  }
  return { creates, reescrituras }
}

const esPendiente = (s: Sitio) => PENDIENTES.some(p => p.archivo === s.rel && (!p.funcion || p.funcion === s.funcion))

describe('Order.contratoDePrecio — escritores', () => {
  const { creates, reescrituras } = escanear()

  it('encuentra los escritores (si esto baja a 0, el escáner se rompió, no el código)', () => {
    // 23 sitios reales verificados por grep el 25-sep (24 líneas que matchean `.order.create(`/
    // `.order.upsert(` menos 1 comentario en order.mobile.service.ts:735). El umbral es una
    // guarda de cordura del escáner, no un conteo exacto a mantener a mano.
    expect(creates.length).toBeGreaterThanOrEqual(23)
  })

  it('todo create/upsert de Order declara contratoDePrecio', () => {
    const faltan = creates.filter(s => !s.declara && !esPendiente(s)).map(s => `${s.rel}:${s.linea} (${s.funcion})`)
    expect(faltan).toEqual([])
  })

  it('ningún update reescribe el contrato fuera de la fusión y la confirmación', () => {
    expect(reescrituras.map(s => `${s.rel}:${s.linea} (${s.funcion})`)).toEqual([])
  })

  it('cada pendiente sigue existiendo y sigue sin declarar (si ya declara, sácalo de la lista)', () => {
    for (const p of PENDIENTES) {
      const sitios = creates.filter(s => s.rel === p.archivo && (!p.funcion || s.funcion === p.funcion))
      expect(sitios.length).toBeGreaterThan(0)
      expect(sitios.every(s => !s.declara)).toBe(true)
    }
  })
})
