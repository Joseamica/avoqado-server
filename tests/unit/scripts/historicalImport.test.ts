/**
 * Carga del histórico de números de vinculación (spec 2026-10-30 §5.7, plan A10). El libro se arma en memoria con datos
 * inventados: el Excel real trae teléfonos de clientes y nunca entra al repo.
 */
import * as XLSX from 'xlsx'

import {
  importBatchFor,
  parseHistoricalWorkbook,
  planHistoricalImport,
  type HistoricalRow,
} from '../../../scripts/lib/linkingNumbers/historicalImport'

const ICCID = (n: number) => `89520000000000000${String(n).padStart(2, '0')}F`
const FECHA_1_ABR_2026 = 46113 // número de serie de Excel, como lo trae el archivo del back-office

/** Como el archivo real: la hoja empieza en B3, el encabezado «Tipo deSIM» viene sin espacio y el número es numérico. */
function libro(datos: unknown[][], encabezados: unknown[] = ['ID SIM', 'Tipo deSIM', 'Mes', 'Fecha', '# Vinculación', 'Status Venta']) {
  const ws = XLSX.utils.sheet_add_aoa({}, [encabezados, ...datos], { origin: 'B3' })
  ws['!ref'] = `B3:${ws['!ref']!.split(':')[1]}` // SheetJS lo deja en A1; el archivo real declara B3
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet3')
  return wb
}

const fila = (iccid: unknown, numero: unknown, status = 'Aprobada') => [
  iccid,
  'SIM de Caja Vinculado',
  'Abr',
  FECHA_1_ABR_2026,
  numero,
  status,
]

describe('parseHistoricalWorkbook', () => {
  it('lee los encabezados de la fila 3 y da la fila de Excel de cada renglón', () => {
    const wb = libro([fila(ICCID(1), 5511111111), fila(ICCID(2), '334651O556', 'Rechazada')])
    expect(wb.Sheets.Sheet3['!ref']).toBe('B3:G5') // como el archivo real, que empieza en B3
    const rows = parseHistoricalWorkbook(wb)

    expect(rows).toEqual([
      {
        iccid: ICCID(1),
        simType: 'SIM de Caja Vinculado',
        saleDate: new Date('2026-04-01T12:00:00-06:00'),
        rawNumber: '5511111111',
        status: 'Aprobada',
        rowIndex: 4,
      },
      {
        iccid: ICCID(2),
        simType: 'SIM de Caja Vinculado',
        saleDate: new Date('2026-04-01T12:00:00-06:00'),
        rawNumber: '334651O556',
        status: 'Rechazada',
        rowIndex: 5,
      },
    ])
  })

  it('normaliza el ICCID como el inventario (sin espacios, en mayúsculas) y salta los renglones vacíos', () => {
    const rows = parseHistoricalWorkbook(
      libro([[` ${ICCID(3).toLowerCase()} `, null, null, null, '55 3333-3333', null], [], fila(ICCID(4), 5544444444)]),
    )

    expect(rows.map(r => [r.iccid, r.rawNumber, r.simType, r.saleDate, r.status, r.rowIndex])).toEqual([
      [ICCID(3), '55 3333-3333', null, null, null, 4],
      [ICCID(4), '5544444444', 'SIM de Caja Vinculado', new Date('2026-04-01T12:00:00-06:00'), 'Aprobada', 6],
    ])
  })

  it('un ICCID numérico (Excel ya le comió dígitos) queda vacío para que la fila vaya a inválidos', () => {
    const [row] = parseHistoricalWorkbook(libro([fila(8.952e19, 5511111111)]))
    expect(row.iccid).toBe('')
  })

  it('sin las columnas «ID SIM» y «# Vinculación» se detiene con un mensaje claro', () => {
    expect(() => parseHistoricalWorkbook(libro([fila(ICCID(1), 5511111111)], ['SIM', 'Tipo', 'Mes', 'Fecha', 'Número', 'Status']))).toThrow(
      /ID SIM/,
    )
    expect(() =>
      parseHistoricalWorkbook(libro([fila(ICCID(1), 5511111111)], ['ID SIM', 'Tipo', 'Mes', 'Fecha', 'Número', 'Status'])),
    ).toThrow(/# Vinculación/)
  })
})

describe('planHistoricalImport', () => {
  const ventas = new Map([
    [ICCID(1), { id: 'sv-sin-numero', linkingNumber: null }],
    [ICCID(2), { id: 'sv-con-otro', linkingNumber: '5599999999' }],
    [ICCID(9), { id: 'sv-con-el-mismo', linkingNumber: '5590000000' }],
  ])
  const rows = parseHistoricalWorkbook(
    libro([
      fila(ICCID(1), 5511111111), // 4: venta sin número → se llena
      fila(ICCID(2), 5522222222), // 5: venta con otro número → choque, no se pisa
      fila(ICCID(3), 552233344), // 6: 9 dígitos y sin venta → histórico
      fila(ICCID(4), '334651O556'), // 7: con una «O» → inválido
      fila(ICCID(5), '55 3333-3333'), // 8: pegado con espacios y guion → histórico, sólo dígitos
      fila(ICCID(6), 5533333333), // 9: el mismo número que la 8 en otra SIM → repetido
      fila('', 5544444444), // 10: sin ICCID → inválido
      fila(ICCID(1), 5511111111), // 11: la misma SIM y el mismo número otra vez → nada nuevo
      fila(ICCID(1), 5512121212), // 12: la misma venta con otro número → choque contra lo que la fila 4 le puso
      fila(ICCID(9), 5590000000), // 13: la venta ya tiene ese número → nada que hacer
      fila(ICCID(5), 5533333333), // 14: la misma SIM y número que la 8 → no se duplica en el histórico
      fila(ICCID(7), 12345678), // 15: 8 dígitos → inválido
    ]),
  )
  const plan = planHistoricalImport(rows, ventas)

  it('llena la venta sin número y no pisa la que ya tiene otro', () => {
    expect(plan.fillSale).toEqual([{ verificationId: 'sv-sin-numero', number: '5511111111', rowIndex: 4 }])
    expect(plan.conflicts).toEqual([
      { verificationId: 'sv-con-otro', current: '5599999999', excel: '5522222222', rowIndex: 5 },
      { verificationId: 'sv-sin-numero', current: '5511111111', excel: '5512121212', rowIndex: 12 },
    ])
  })

  it('el ICCID sin venta va al histórico (también el de 9 dígitos), una sola vez por SIM y número', () => {
    const fecha = new Date('2026-04-01T12:00:00-06:00')
    expect(plan.toHistorical).toEqual([
      { iccid: ICCID(3), number: '552233344', saleDate: fecha, status: 'Aprobada' },
      { iccid: ICCID(5), number: '5533333333', saleDate: fecha, status: 'Aprobada' },
      { iccid: ICCID(6), number: '5533333333', saleDate: fecha, status: 'Aprobada' },
    ])
  })

  it('334651O556, la fila sin ICCID y el de 8 dígitos van a inválidos, con su valor tal cual', () => {
    expect(plan.invalid).toEqual([
      { rowIndex: 7, raw: '334651O556' },
      { rowIndex: 10, raw: '5544444444' },
      { rowIndex: 15, raw: '12345678' },
    ])
  })

  it('repeatedNumbers lista los números que el archivo trae en más de una fila (venta), aunque sea la misma SIM', () => {
    // 5511111111: filas 4 y 11, la misma SIM vendida dos veces. 5533333333: filas 8, 9 (otra SIM) y 14.
    expect(plan.repeatedNumbers).toEqual(['5511111111', '5533333333'])
  })

  it('sin ventas (corrida sin base) toda fila válida va al histórico y nada se llena', () => {
    const sinBase = planHistoricalImport(rows, new Map())
    expect(sinBase.fillSale).toEqual([])
    expect(sinBase.conflicts).toEqual([])
    expect(sinBase.toHistorical.map(h => h.iccid)).toEqual([ICCID(1), ICCID(2), ICCID(3), ICCID(5), ICCID(6), ICCID(1), ICCID(9)])
    expect(sinBase.invalid).toHaveLength(3)
  })

  // Regresión
  it('no modifica el mapa de ventas que recibe', () => {
    expect(ventas.get(ICCID(1))).toEqual({ id: 'sv-sin-numero', linkingNumber: null })
  })

  it('un inválido que se repite no cuenta como repetido, y uno que sale una sola vez tampoco', () => {
    const r: HistoricalRow = { iccid: ICCID(8), simType: null, saleDate: null, rawNumber: '334651O556', status: null, rowIndex: 4 }
    const unaVez = { ...r, iccid: ICCID(9), rawNumber: '5577777777', rowIndex: 6 }
    expect(planHistoricalImport([r, { ...r, rowIndex: 5 }, unaVez], new Map()).repeatedNumbers).toEqual([])
  })
})

describe('importBatchFor', () => {
  it('<fecha de México>-<8 del sha1 del archivo>', () => {
    // sha1('abc') = a9993e36…; las 03:00 UTC del 3-nov todavía son el 2-nov en México.
    expect(importBatchFor(Buffer.from('abc'), new Date('2026-11-03T03:00:00Z'))).toBe('2026-11-02-a9993e36')
  })
})
