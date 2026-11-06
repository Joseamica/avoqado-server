/**
 * Tienda híbrida T9b (decisión 18, R28): «Entregado» (`OnlineOrder.COMPLETED`) de un folio (`requiresAcceptance = false`) lo escribe
 * SÓLO una persona (`DELIVER` de `casTransitionInTx`) o el fin del día del negocio (`cerrarFoliosDelDiaTerminado`). Los cierres
 * automáticos de «Mi equipo» (`paidPickupSync`, la rama de `conciliarPedidoEnLinea`) filtran `requiresAcceptance: true` EN SU `where`.
 *
 * Inventario cerrado: lee `src/` y falla si aparece otra escritura de `COMPLETED` sobre un pedido en línea, o si una de las
 * permitidas pierde su filtro. Una escritura nueva se agrega aquí A PROPÓSITO, con su razón.
 */
import * as fs from 'fs'
import * as path from 'path'

const SRC = path.resolve(__dirname, '../../../src')

function archivos(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? archivos(p) : p.endsWith('.ts') ? [p] : []
  })
}

/** Con el enum del pedido en línea, siempre es de él. Con el texto `'COMPLETED'` (que también usan Order y Payment) sólo si una escritura de `onlineOrder` está a la vista. */
const ESCRIBE_ENUM = /(?:data:\s*\{\s*status|\bto):\s*OnlineOrderStatus\.COMPLETED/
const ESCRIBE_TEXTO = /(?:data:\s*\{\s*status|\bto):\s*'COMPLETED'/
const ESCRITURA_DE_PEDIDO = /onlineOrder\.(?:update|updateMany|upsert|create|createMany)\b/
const ANTES = 14 // líneas hacia atrás donde debe estar el filtro del `where`

/** Archivo (relativo a `src/`) → cuántas escrituras tiene y qué filtro debe verse justo antes de cada una. */
const PERMITIDAS: Record<string, { veces: number; filtro: RegExp }> = {
  // Una persona: `DELIVER` (`to: COMPLETED`) pasa por `casTransitionInTx`; los folios entran porque una persona lo pidió.
  'services/online-ordering/transitions.service.ts': { veces: 1, filtro: /DELIVER: \{/ },
  // El fin del día del negocio: sólo folios.
  'services/online-ordering/folios.service.ts': { veces: 1, filtro: /requiresAcceptance: false/ },
  // «Mi equipo»: nunca un folio.
  'services/online-ordering/paidPickupSync.ts': { veces: 1, filtro: /requiresAcceptance: true/ },
  'services/shared/cuentaCancelada.ts': { veces: 1, filtro: /requiresAcceptance: true/ },
}

describe('quién escribe «Entregado» en un pedido en línea', () => {
  const hallazgos = archivos(SRC).flatMap(archivo => {
    const texto = fs.readFileSync(archivo, 'utf8')
    if (!/onlineOrder|OnlineOrder/.test(texto)) return []
    const lineas = texto.split('\n')
    const cerca = (i: number) => lineas.slice(Math.max(0, i - 20), i + 21).join('\n')
    return lineas.flatMap((l, i) =>
      ESCRIBE_ENUM.test(l) || (ESCRIBE_TEXTO.test(l) && ESCRITURA_DE_PEDIDO.test(cerca(i)))
        ? [{ rel: path.relative(SRC, archivo), i, lineas }]
        : [],
    )
  })

  it('sólo las escrituras de la lista, cada una una sola vez', () => {
    const porArchivo: Record<string, number> = {}
    for (const h of hallazgos) porArchivo[h.rel] = (porArchivo[h.rel] ?? 0) + 1
    const esperado = Object.fromEntries(Object.entries(PERMITIDAS).map(([k, v]) => [k, v.veces]))
    expect(porArchivo).toEqual(esperado)
  })

  it.each(Object.keys(PERMITIDAS))('%s: su escritura lleva su filtro en el `where` (no se confía en la lectura)', rel => {
    const { filtro } = PERMITIDAS[rel]
    for (const h of hallazgos.filter(x => x.rel === rel)) {
      const ventana = h.lineas.slice(Math.max(0, h.i - ANTES), h.i + 1).join('\n')
      expect(ventana).toMatch(filtro)
    }
  })

  it('ningún SQL crudo escribe OnlineOrder', () => {
    const crudos = archivos(SRC).filter(a => /UPDATE\s+"OnlineOrder"/i.test(fs.readFileSync(a, 'utf8')))
    expect(crudos.map(a => path.relative(SRC, a))).toEqual([])
  })
})
