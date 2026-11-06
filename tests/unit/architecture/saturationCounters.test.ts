/**
 * Tienda híbrida (T3a): los folios sin pagar no son saturación. Todo `onlineOrder.count` con PENDING_ACCEPTANCE dentro de
 * `src/services/online-ordering` debe usar uno de los dos ayudantes de `constants.ts`; un conteo suelto volvería a contar folios.
 */
import fs from 'fs'
import path from 'path'

const DIR = path.join(__dirname, '../../../src/services/online-ordering')
const archivosTs = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return archivosTs(p)
    return e.name.endsWith('.ts') ? [p] : []
  })

describe('conteos de PENDING_ACCEPTANCE en online-ordering', () => {
  it('todos usan awaitingAcceptanceWhere o unpaidFoliosWhere', () => {
    const malos: string[] = []
    for (const f of archivosTs(DIR)) {
      const lineas = fs.readFileSync(f, 'utf8').split('\n')
      lineas.forEach((l, i) => {
        if (!/onlineOrder\s*\.\s*count\s*\(/.test(l)) return
        // la llamada puede ocupar varias líneas: miramos hasta 4 líneas hacia abajo
        const bloque = lineas.slice(i, i + 5).join(' ')
        if (/PENDING_ACCEPTANCE/.test(bloque) && !/awaitingAcceptanceWhere|unpaidFoliosWhere/.test(bloque)) {
          malos.push(`${path.relative(DIR, f)}:${i + 1}`)
        }
      })
    }
    expect(malos).toEqual([])
  })
})
