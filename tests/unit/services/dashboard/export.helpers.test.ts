/**
 * La ayuda COMPARTIDA de exportación (pagos, órdenes, contabilidad, inventario, recibos…).
 *
 * QA del pago al staff (2026-10-03, defecto 1): el PDF salía ilegible — cada celda se dibujaba en
 * `doc.y - rowHeight + 4` y cada `doc.text()` movía `doc.y`, así que las celdas de una fila se iban recorriendo, el
 * encabezado quedaba abajo de las filas y «Total» flotaba sobre el título. pdfkit comprime el contenido, así que se
 * prueba con las COORDENADAS de cada `text()`.
 */
import PDFDocument from 'pdfkit'
import * as XLSX from 'xlsx'
import { encodeExport, ExportColumnDef, fechaMx } from '@/services/dashboard/export.helpers'

type Row = { a: string; b: number; c: string }
const COLS: ExportColumnDef<Row>[] = [
  { id: 'a', label: 'Col A', value: r => r.a },
  { id: 'b', label: 'Col B', value: r => r.b },
  { id: 'c', label: 'Col C', value: r => r.c },
]
const filas = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ a: `a${i}`, b: i, c: `c${i}` }))

/** Cada `text(texto, x, y)` con coordenadas explícitas (las celdas), en orden, y la página en que cayó. */
async function celdasDelPdf(rows: Row[], title = 'Prueba') {
  const text = jest.spyOn(PDFDocument.prototype, 'text')
  const addPage = jest.spyOn(PDFDocument.prototype, 'addPage')
  try {
    await encodeExport('pdf', { allColumns: COLS, requestedColumnIds: ['a', 'b', 'c'], rows, title })
    let pagina = -1 // el constructor de PDFDocument abre la primera página con su propio addPage()
    const celdas: Array<{ t: string; x: number; y: number; pagina: number }> = []
    const sueltos: string[] = []
    // Las llamadas a addPage y text se intercalan: se ordenan por su número de invocación global.
    const eventos = [
      ...text.mock.calls.map((args, i) => ({ orden: text.mock.invocationCallOrder[i], args })),
      ...addPage.mock.calls.map((_args, i) => ({ orden: addPage.mock.invocationCallOrder[i], args: null })),
    ].sort((p, q) => p.orden - q.orden)
    for (const e of eventos) {
      if (e.args === null) pagina++
      else if (typeof e.args[1] === 'number' && typeof e.args[2] === 'number') {
        celdas.push({ t: String(e.args[0]), x: e.args[1] as number, y: e.args[2] as number, pagina })
      } else sueltos.push(String(e.args[0]))
    }
    return { celdas, sueltos, paginas: pagina + 1 }
  } finally {
    text.mockRestore()
    addPage.mockRestore()
  }
}

describe('encodeExport · PDF: una tabla que se lee', () => {
  it('las celdas de una fila comparten la misma y; el encabezado va antes y cada fila más abajo que la anterior', async () => {
    const { celdas } = await celdasDelPdf(filas(3))
    const porFila = new Map<number, string[]>()
    for (const c of celdas) porFila.set(c.y, [...(porFila.get(c.y) ?? []), c.t])
    expect([...porFila.values()]).toEqual([
      ['Col A', 'Col B', 'Col C'],
      ['a0', '0', 'c0'],
      ['a1', '1', 'c1'],
      ['a2', '2', 'c2'],
    ])
    const ys = [...porFila.keys()]
    expect(ys).toEqual([...ys].sort((p, q) => p - q))
    // Las x de cada fila, de izquierda a derecha y las mismas en todas las filas.
    const xs = (y: number) => celdas.filter(c => c.y === y).map(c => c.x)
    for (const y of ys) expect(xs(y)).toEqual(xs(ys[0]))
    expect(xs(ys[0])).toEqual([...xs(ys[0])].sort((p, q) => p - q))
  })

  it('cuando no cabe, salta de página y repite el encabezado; ninguna fila se sale de la hoja', async () => {
    const { celdas, paginas } = await celdasDelPdf(filas(80))
    expect(paginas).toBeGreaterThan(1)
    // A4 horizontal: 595.28 de alto, margen 32.
    expect(Math.max(...celdas.map(c => c.y))).toBeLessThan(595.28 - 32)
    for (let p = 0; p < paginas; p++) {
      const enPagina = celdas.filter(c => c.pagina === p)
      expect(enPagina.slice(0, 3).map(c => c.t)).toEqual(['Col A', 'Col B', 'Col C'])
      const ys = [...new Set(enPagina.map(c => c.y))]
      expect(ys).toEqual([...ys].sort((a, b) => a - b))
    }
    // Ninguna fila se perdió ni se repitió.
    expect(celdas.filter(c => /^a\d+$/.test(c.t)).map(c => c.t)).toEqual(filas(80).map(r => r.a))
  })

  it('«Generado:» en formato de México (día mes año, 24 h), no el de EE. UU.', async () => {
    const { sueltos } = await celdasDelPdf(filas(1))
    expect(sueltos).toContainEqual(expect.stringMatching(/^Generado: \d{1,2} (ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic) \d{4}, \d{2}:\d{2}$/))
  })
})

describe('fechaMx', () => {
  it('«29 sep 2026» de una fecha AAAA-MM-DD, sin moverla de día', () => {
    expect(fechaMx('2026-09-29')).toBe('29 sep 2026')
    expect(fechaMx('2026-10-03')).toBe('3 oct 2026')
    expect(fechaMx('2026-01-01')).toBe('1 ene 2026')
  })
})

describe('encodeExport · Excel', () => {
  const libro = async (title: string, cols: ExportColumnDef<Row>[] = COLS) =>
    XLSX.read((await encodeExport('xlsx', { allColumns: cols, requestedColumnIds: ['a', 'b', 'c'], rows: filas(2), title })).buffer, {
      cellNF: true,
    })

  it('el nombre de la hoja se recorta limpio: sin separador colgando ni caracteres prohibidos', async () => {
    expect((await libro('Recibo de Carlos Rodríguez · 2026-09-01 al 2026-09-30')).SheetNames).toEqual(['Recibo de Carlos Rodríguez'])
    expect((await libro('Ventas: 1/2 [x]?*')).SheetNames[0]).toBe('Ventas 12 x')
    expect((await libro('Pagos')).SheetNames).toEqual(['Pagos'])
    expect((await libro('···')).SheetNames).toEqual(['Export'])
  })

  it('una columna con `numFmt` lleva ese formato en sus celdas numéricas; las demás no cambian', async () => {
    const cols = COLS.map(c => (c.id === 'b' ? { ...c, numFmt: '$#,##0.00' } : c))
    const hoja = (await libro('Pagos', cols)).Sheets.Pagos
    expect(hoja.B2).toMatchObject({ t: 'n', v: 0, z: '$#,##0.00' })
    expect(hoja.B3).toMatchObject({ t: 'n', v: 1, z: '$#,##0.00' })
    expect(hoja.B1.v).toBe('Col B') // el encabezado sigue siendo texto
    expect(hoja.A2.z).not.toBe('$#,##0.00')
    // Sin `numFmt`, igual que antes.
    expect((await libro('Pagos')).Sheets.Pagos.B2.z).not.toBe('$#,##0.00')
  })
})
