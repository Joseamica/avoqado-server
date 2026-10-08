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
      ...text.mock.calls.map((args, i) => ({ orden: text.mock.invocationCallOrder[i], args: args as unknown[] })),
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

  /** Lo que pdfkit DIBUJA de cada celda (ya con «…» si no cupo) y el ancho que se le dio, en orden. */
  async function dibujado(cols: ExportColumnDef<Row>[], rows: Row[]) {
    const proto = PDFDocument.prototype as unknown as { _fragment: (texto: string, ...resto: unknown[]) => unknown }
    const fragment = jest.spyOn(proto, '_fragment')
    const text = jest.spyOn(PDFDocument.prototype, 'text')
    try {
      await encodeExport('pdf', { allColumns: cols, requestedColumnIds: cols.map(c => c.id), rows, title: 'Prueba' })
      const anchos = text.mock.calls
        .filter(args => typeof args[1] === 'number')
        .map(args => ({ t: String(args[0]), x: args[1] as unknown as number, width: (args[3] as { width: number }).width }))
      return { fragmentos: fragment.mock.calls.map(args => String(args[0])), anchos }
    } finally {
      fragment.mockRestore()
      text.mockRestore()
    }
  }

  it('sin pesos, columnas iguales como siempre (las demás exportaciones no cambian)', async () => {
    const { anchos } = await dibujado(COLS, filas(1))
    const encabezado = anchos.slice(0, 3)
    expect(new Set(encabezado.map(c => c.width)).size).toBe(1)
    const paso = encabezado[1].x - encabezado[0].x
    expect(encabezado[2].x - encabezado[1].x).toBeCloseTo(paso)
    expect(encabezado[0].width).toBeCloseTo(paso - 8)
  })

  it('con `pdfAncho` cada columna toma su parte y un texto largo se dibuja completo, sin «…»', async () => {
    const largo = 'Diferencia · Yoga (clase grupal) del 28 sep 2026 (clase de septiembre)'
    const conPesos = COLS.map(c => ({ ...c, pdfAncho: c.id === 'c' ? 4 : 1 }))
    const { fragmentos, anchos } = await dibujado(conPesos, [{ a: 'x', b: 1, c: largo }])
    const [a, b, c] = anchos.slice(0, 3)
    expect(a.width).toBeCloseTo(b.width)
    expect(c.width + 8).toBeCloseTo((a.width + 8) * 4)
    expect(fragmentos).toContain(largo)
    expect(fragmentos.some(f => f.includes('…'))).toBe(false)
    // El mismo texto con columnas iguales sí se corta: la prueba ve el corte cuando existe.
    expect((await dibujado(COLS, [{ a: 'x', b: 1, c: largo }])).fragmentos.some(f => f.endsWith('…'))).toBe(true)
  })

  it('con `pdfAjustar` (E6a-fix F13) un texto que no cabe se parte en líneas sin «…» y su fila crece; sin él, se corta como siempre', async () => {
    const largo = 'Comisión Estándar Meseros Turno Vespertino 3 % · venta #ORD-20260929-000123 · base $3,000.00'
    const ajustada = COLS.map(c => (c.id === 'c' ? { ...c, pdfAjustar: true } : c))
    const text = jest.spyOn(PDFDocument.prototype, 'text')
    const proto = PDFDocument.prototype as unknown as { _fragment: (texto: string, ...resto: unknown[]) => unknown }
    const fragment = jest.spyOn(proto, '_fragment')
    try {
      const rows = [
        { a: 'x', b: 1, c: largo },
        { a: 'y', b: 2, c: 'corto' },
      ]
      await encodeExport('pdf', { allColumns: ajustada, requestedColumnIds: ['a', 'b', 'c'], rows, title: 'Prueba' })
      const ys = new Map(text.mock.calls.filter(a => typeof a[2] === 'number').map(a => [String(a[0]), a[2] as unknown as number]))
      const lineas = fragment.mock.calls.map(a => String(a[0]))
      expect(lineas.some(l => l.includes('…'))).toBe(false)
      expect(lineas.join(' ')).toContain('base $3,000.00')
      expect(lineas.filter(l => largo.includes(l.trim()) && l.trim().length > 0).length).toBeGreaterThan(1) // varias líneas
      // La fila del texto largo mide más de 16: la siguiente empieza más abajo que una fila normal.
      expect(ys.get('y')! - ys.get('x')!).toBeGreaterThan(16)
    } finally {
      text.mockRestore()
      fragment.mockRestore()
    }
    // Sin `pdfAjustar` (todas las demás exportaciones), el mismo texto se corta con «…» en una sola línea.
    expect((await dibujado(COLS, [{ a: 'x', b: 1, c: largo }])).fragmentos.some(f => f.endsWith('…'))).toBe(true)
  })

  it('`resumen` (E6a-fix F13) se dibuja bajo el título y antes del encabezado de la tabla; sin él, nada extra', async () => {
    const text = jest.spyOn(PDFDocument.prototype, 'text')
    try {
      const resumen = ['Clases $480.00 · Comisiones $90.00 · Propinas $80.00']
      await encodeExport('pdf', { allColumns: COLS, requestedColumnIds: ['a', 'b', 'c'], rows: filas(1), title: 'Prueba', resumen })
      const orden = text.mock.calls.map(a => String(a[0]))
      expect(orden.indexOf(resumen[0])).toBeGreaterThan(orden.indexOf('Prueba'))
      expect(orden.indexOf(resumen[0])).toBeLessThan(orden.indexOf('Col A'))
    } finally {
      text.mockRestore()
    }
    const { sueltos } = await celdasDelPdf(filas(1))
    expect(sueltos).toHaveLength(2) // el título y «Generado:», como siempre
  })

  it('«Generado:» en formato de México (día mes año, 24 h), no el de EE. UU.', async () => {
    const { sueltos } = await celdasDelPdf(filas(1))
    expect(sueltos).toContainEqual(
      expect.stringMatching(/^Generado: \d{1,2} (ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic) \d{4}, \d{2}:\d{2}$/),
    )
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
