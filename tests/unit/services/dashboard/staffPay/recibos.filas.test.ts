import PDFDocument from 'pdfkit'
import { encodeExport } from '@/services/dashboard/export.helpers'
import { Prisma } from '@prisma/client'
import { columnasDelRecibo, filasDelRecibo, RenglonRecibo, totalesPorTipoDelRecibo } from '@/services/dashboard/staffPay/recibos.service'
import { conceptoDe, FilaRecibo } from '@/services/dashboard/staffPay/recibos.formato'

const r = (tipo: RenglonRecibo['tipo'], concepto: string, monto: string): RenglonRecibo => ({
  tipo,
  fecha: '2026-08-06',
  hora: null,
  sede: 'PN',
  concepto,
  lugares: null,
  monto,
})

describe('filasDelRecibo — lo que reciben el PDF y el Excel (Codex R2-R1-14)', () => {
  it('un descuento manual de −$50 sale con su signo y el total cuadra con los renglones', () => {
    const filas = filasDelRecibo({
      renglones: [r('CLASE', 'Reformer', '480.00'), r('AJUSTE', 'Llegó tarde', '-50.00')],
      total: '430.00',
      parcial: false,
    })
    expect(filas.map(f => [f.concepto, f.monto])).toEqual([
      ['Reformer', '480.00'],
      ['Llegó tarde', '-50.00'],
      ['Total', '430.00'],
    ])
    const suma = filas.slice(0, -1).reduce((a, f) => a + Number(f.monto), 0)
    expect(suma.toFixed(2)).toBe(filas.at(-1)!.monto)
  })
  it('en vista parcial la fila del total lo dice', () => {
    expect(filasDelRecibo({ renglones: [], total: '0.00', parcial: true }).at(-1)!.concepto).toBe('Total (vista parcial)')
  })
})

describe('columnasDelRecibo — cómo se ve cada celda (QA 2026-10-03, defectos 1, 9 y 15)', () => {
  const renglon = (x: Partial<RenglonRecibo>): RenglonRecibo => ({
    ...r('CLASE', 'Pilates', '1030.00'),
    fecha: '2026-09-29',
    hora: '18:00',
    ...x,
  })
  const celdas = (formato: 'pdf' | 'xlsx', x: RenglonRecibo) =>
    Object.fromEntries(columnasDelRecibo(formato).map(c => [c.label, c.value(x)]))

  it('el PDF lleva el monto con $ en formato de México y la fecha como «29 sep 2026»', () => {
    expect(celdas('pdf', renglon({}))).toEqual({
      Fecha: '29 sep 2026',
      Hora: '18:00',
      Sede: 'PN',
      Concepto: 'Pilates',
      Lugares: null,
      Monto: '$1,030.00',
    })
    expect(celdas('pdf', renglon({ tipo: 'AJUSTE', monto: '-150.00' })).Monto).toBe('-$150.00')
  })

  it('un ajuste dice la fecha de CAPTURA, sin hora y marcada; su motivo va en «Concepto»', () => {
    const aj = renglon({ tipo: 'AJUSTE', fecha: '2026-10-03', hora: null, concepto: 'Clase de septiembre mal contada', monto: '-150.00' })
    for (const f of ['pdf', 'xlsx'] as const) {
      expect(celdas(f, aj)).toMatchObject({ Fecha: '3 oct 2026 (captura)', Hora: null, Concepto: 'Clase de septiembre mal contada' })
    }
  })

  it('la columna se llama «Concepto» (no «Clase») en los dos formatos, y la fila del total no lleva fecha', () => {
    for (const f of ['pdf', 'xlsx'] as const) {
      expect(columnasDelRecibo(f).map(c => c.label)).toEqual(['Fecha', 'Hora', 'Sede', 'Concepto', 'Lugares', 'Monto'])
      const total = filasDelRecibo({ renglones: [], total: '250.00', parcial: false }).at(-1)!
      expect(celdas(f, total).Fecha).toBe('')
    }
  })

  it('una comisión o una propina llevan la fecha de la VENTA, sin «(captura)» (spec fase 3 §11)', () => {
    for (const tipo of ['COMISION', 'PROPINA'] as const) {
      expect(celdas('pdf', renglon({ tipo, hora: null })).Fecha).toBe('29 sep 2026')
      expect(celdas('xlsx', renglon({ tipo, monto: '-20.00' })).Monto).toBe(-20)
    }
  })

  it('el Excel deja el monto como NÚMERO con formato de moneda', () => {
    const monto = columnasDelRecibo('xlsx').find(c => c.id === 'monto')!
    expect(monto.value(renglon({ monto: '-150.00' }))).toBe(-150)
    expect(monto.numFmt).toBe('$#,##0.00')
  })
})

describe('el PDF del recibo no corta lo que importa (QA bloque B: la diferencia dice su fecha y su mes)', () => {
  it('el concepto más largo de la QA, la fecha de captura y el monto salen completos, sin «…»', async () => {
    const largo = 'Diferencia · Yoga (clase grupal) del 28 sep 2026 (clase de septiembre)'
    const renglones: RenglonRecibo[] = [
      { tipo: 'DIFERENCIA', fecha: '2026-09-28', hora: '18:00', sede: 'Mindform Prado Norte', concepto: largo, lugares: 9, monto: '40.00' },
      {
        tipo: 'AJUSTE',
        fecha: '2026-09-28',
        hora: null,
        sede: 'Mindform Prado Norte',
        concepto: 'Bono',
        lugares: null,
        monto: '-12345.00',
      },
    ]
    const proto = PDFDocument.prototype as unknown as { _fragment: (texto: string, ...resto: unknown[]) => unknown }
    const fragment = jest.spyOn(proto, '_fragment')
    try {
      const columnas = columnasDelRecibo('pdf')
      await encodeExport('pdf', {
        allColumns: columnas,
        requestedColumnIds: columnas.map(c => c.id),
        rows: filasDelRecibo({ renglones, total: '-12305.00', parcial: true }),
        title: 'Recibo de Ana',
      })
      const dibujado = fragment.mock.calls.map(args => String(args[0]))
      for (const t of [largo, '28 sep 2026 (captura)', 'Mindform Prado Norte', '-$12,345.00', 'Total (vista parcial)']) {
        expect(dibujado).toContain(t)
      }
      expect(dibujado.filter(t => t.includes('…'))).toEqual([])
    } finally {
      fragment.mockRestore()
    }
  })
})

describe('totalesPorTipoDelRecibo — la línea de arriba del PDF, como la pantalla (E6a-fix F13, QA E6a H13)', () => {
  it('en el orden fijo de la pantalla (clases, comisiones, propinas, diferencias, ajustes), con su signo', () => {
    expect(totalesPorTipoDelRecibo({ AJUSTE: '-50.00', PROPINA: '220.92', CLASE: '6210.00', COMISION: '222.38' })).toEqual([
      'Clases $6,210.00 · Comisiones $222.38 · Propinas $220.92 · Ajustes -$50.00',
    ])
  })
  it('con un solo tipo, o ninguno, no repite el total', () => {
    expect(totalesPorTipoDelRecibo({ CLASE: '480.00' })).toEqual([])
    expect(totalesPorTipoDelRecibo({})).toEqual([])
  })
})

describe('conceptoDe — una comisión dice su esquema UNA vez y su tasa (E6a-fix F13, QA E6a H11)', () => {
  const fila = (x: Partial<FilaRecibo>): FilaRecibo => ({
    tipo: 'COMISION',
    instante: new Date('2026-09-29T18:00:00Z'),
    id: 'c1',
    venueId: 'v1',
    fecha: '2026-09-29',
    hora: '12:00',
    clase: null,
    sedeFoto: null,
    reason: null,
    origen: null,
    lugares: null,
    monto: new Prisma.Decimal(90),
    regla: null,
    orden: '1042',
    esquema: 'Comisión Estándar Meseros',
    base: new Prisma.Decimal(3000),
    tasa: new Prisma.Decimal('0.0300'),
    limite: null,
    motivo: 'VENTA',
    agrupada: false,
    cobros: 1,
    ...x,
  })
  it.each([
    [{}, 'Comisión Estándar Meseros 3 % · venta #1042 · base $3,000.00'],
    [{ esquema: 'comisiones de barra' }, 'Comisión de barra 3 % · venta #1042 · base $3,000.00'],
    [{ esquema: 'Lagree', tasa: new Prisma.Decimal('0.1250') }, 'Comisión Lagree 12.5 % · venta #1042 · base $3,000.00'],
    [{ esquema: null }, 'Comisión 3 % · venta #1042 · base $3,000.00'],
    [{ esquema: 'Comisión' }, 'Comisión 3 % · venta #1042 · base $3,000.00'],
    [{ tasa: null }, 'Comisión Estándar Meseros · venta #1042 · base $3,000.00'], // fija, o congelada antes de F13
    [{ motivo: 'DEVOLUCION' }, 'Devolución · comisión Estándar Meseros 3 % · venta #1042'],
    [{ motivo: 'ANULACION', orden: null }, 'Anulación · comisión Estándar Meseros 3 %'],
    // Final-fix G6: el 3 % de la base no da el monto porque el esquema lo subió a su mínimo o lo bajó a su tope; lo dice.
    [
      { base: new Prisma.Decimal(1), monto: new Prisma.Decimal(5), limite: 'MINIMO' },
      'Comisión Estándar Meseros 3 % · venta #1042 · base $1.00 → mínimo $5.00',
    ],
    [
      { base: new Prisma.Decimal(10000), monto: new Prisma.Decimal(200), limite: 'TOPE' },
      'Comisión Estándar Meseros 3 % · venta #1042 · base $10,000.00 → tope $200.00',
    ],
    // Sólo la venta: la devolución y la anulación dicen su monto en la columna, sin base que explicar.
    [{ motivo: 'DEVOLUCION', limite: 'MINIMO' }, 'Devolución · comisión Estándar Meseros 3 % · venta #1042'],
    [{ motivo: 'ANULACION', orden: null, limite: 'TOPE' }, 'Anulación · comisión Estándar Meseros 3 %'],
  ] as Array<[Partial<FilaRecibo>, string]>)('%o ⇒ %s', (x, esperado) => {
    expect(conceptoDe(fila(x))).toBe(esperado)
  })
})
