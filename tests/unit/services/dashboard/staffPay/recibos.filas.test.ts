import { filasDelRecibo, RenglonRecibo } from '@/services/dashboard/staffPay/recibos.service'

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
