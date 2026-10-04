import { columnasDelRecibo, filasDelRecibo, RenglonRecibo } from '@/services/dashboard/staffPay/recibos.service'

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
  const renglon = (x: Partial<RenglonRecibo>): RenglonRecibo => ({ ...r('CLASE', 'Pilates', '1030.00'), fecha: '2026-09-29', hora: '18:00', ...x })
  const celdas = (formato: 'pdf' | 'xlsx', x: RenglonRecibo) =>
    Object.fromEntries(columnasDelRecibo(formato).map(c => [c.label, c.value(x)]))

  it('el PDF lleva el monto con $ en formato de México y la fecha como «29 sep 2026»', () => {
    expect(celdas('pdf', renglon({}))).toEqual({ Fecha: '29 sep 2026', Hora: '18:00', Sede: 'PN', Concepto: 'Pilates', Lugares: null, Monto: '$1,030.00' })
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

  it('el Excel deja el monto como NÚMERO con formato de moneda', () => {
    const monto = columnasDelRecibo('xlsx').find(c => c.id === 'monto')!
    expect(monto.value(renglon({ monto: '-150.00' }))).toBe(-150)
    expect(monto.numFmt).toBe('$#,##0.00')
  })
})
