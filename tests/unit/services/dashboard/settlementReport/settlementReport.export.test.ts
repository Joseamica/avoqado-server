import * as XLSX from 'xlsx'
import { construirLibro } from '@/workers/settlementReportXlsx.worker'
import { conTurnoDeReporte, generarArchivo } from '@/services/dashboard/settlementReport/settlementReport.export'
import type { ReporteDeLiquidacion } from '@/services/dashboard/settlementReport/settlementReport.service'

const rep = (o: Partial<ReporteDeLiquidacion> = {}): ReporteDeLiquidacion => ({
  venueName: 'REST TESTARUDO CAFE',
  timezone: 'America/Mexico_City',
  startDate: '2026-08-01',
  endDate: '2026-08-31',
  dateBasis: 'charge',
  ventanaDesde: '2026-08-01',
  ventanaHasta: '2026-08-31',
  candidatosLeidos: 2,
  transacciones: [
    {
      paymentId: 'p1',
      venueName: 'REST TESTARUDO CAFE',
      folio: '000123',
      fechaCobro: '2026-08-31 12:38',
      terminal: 'AVQD-1',
      autorizacion: '079820',
      ultimos4: '1073',
      tipoTarjeta: 'DEBIT',
      operacion: 'SALE',
      marca: '=HYPERLINK("x")',
      consumo: 60,
      propina: 0,
      total: 60,
      comision: 1.17,
      ivaComision: 0.19,
      totalComision: 1.36,
      montoADepositar: 58.64,
      fechaDeposito: '2026-09-01',
      motivoSinFecha: null,
    },
    {
      paymentId: 'p2',
      venueName: 'REST TESTARUDO CAFE',
      folio: 'f2',
      fechaCobro: '2026-08-20 10:00',
      terminal: null,
      autorizacion: null,
      ultimos4: null,
      tipoTarjeta: 'NONE',
      operacion: 'REFUND',
      marca: null,
      consumo: -65,
      propina: 0,
      total: -65,
      comision: null,
      ivaComision: null,
      totalComision: null,
      montoADepositar: null,
      fechaDeposito: null,
      motivoSinFecha: 'SIN_COSTO',
    },
  ],
  depositos: [
    {
      fechaDeposito: '2026-09-01',
      primerCobro: '2026-08-31',
      ultimoCobro: '2026-08-31',
      cobros: 1,
      consumo: 60,
      propinas: 0,
      total: 60,
      comision: 1.17,
      ivaComision: 0.19,
      totalComision: 1.36,
      depositoNeto: 58.64,
    },
  ],
  sinFecha: { cobros: 1, consumo: -65, propinas: 0, total: -65, desde: '2026-08-20', hasta: '2026-08-20' },
  ...o,
})

describe('generarArchivo — CSV', () => {
  it('BOM, encabezados en español, números sin tocar, texto neutralizado, «Sin calcular»', async () => {
    const f = await generarArchivo(rep(), 'transactions', 'csv', ['folio', 'marca', 'total', 'montoADepositar'])
    const txt = f.buffer.toString('utf8')
    expect(txt.startsWith('﻿')).toBe(true)
    const [h, l1, l2] = txt.slice(1).split('\r\n')
    expect(h).toBe('Folio,Marca,Total,Monto a depositar,Fecha de depósito (estimada)') // la obligatoria se agrega sola
    expect(l1).toBe(`000123,"'=HYPERLINK(""x"")",60.00,58.64,2026-09-01`)
    expect(l2).toBe('f2,,-65.00,Sin calcular,Sin calcular')
    expect(f.extension).toBe('csv')
    expect(f.nombre).toMatch(/^transacciones-2026-08-01-a-2026-08-31\.csv$/)
  })
  it('Dispersiones con el renglón «Sin fecha calculada» al final', async () => {
    const f = await generarArchivo(rep(), 'deposits', 'csv', ['fechaDeposito', 'periodo', 'total', 'depositoNeto'])
    const lineas = f.buffer.toString('utf8').slice(1).split('\r\n')
    expect(lineas[1]).toBe('2026-09-01,2026-08-31 al 2026-08-31,60.00,58.64')
    expect(lineas[2]).toBe('Sin fecha calculada,1 cobros del 2026-08-20 al 2026-08-20,-65.00,')
  })
})

describe('generarArchivo — Excel por worker', () => {
  it('manda encabezado con la nota, tipos por columna y filas al worker; regresa su buffer', async () => {
    let recibido: any
    const spawnWorker = (data: unknown) => {
      recibido = data
      return { result: Promise.resolve(Buffer.from('XLSX')), terminate: () => Promise.resolve() }
    }
    const f = await generarArchivo(rep(), 'transactions', 'xlsx', ['folio', 'total'], { spawnWorker })
    expect(f.buffer.toString()).toBe('XLSX')
    expect(recibido.encabezado).toEqual(
      expect.arrayContaining(['Fechas calculadas con las reglas de tu procesador. Avoqado no ve tu cuenta bancaria.']),
    )
    expect(recibido.columnas).toEqual([
      { label: 'Folio', tipo: 'texto' },
      { label: 'Total', tipo: 'dinero' },
      { label: 'Fecha de depósito (estimada)', tipo: 'texto' },
    ])
    expect(recibido.filas[0]).toEqual(['000123', 60, '2026-09-01']) // folio como texto con ceros
  })
  it('timeout ⇒ 504 y el worker se termina', async () => {
    const terminate = jest.fn().mockResolvedValue(undefined)
    const spawnWorker = () => ({ result: new Promise<Buffer>(() => undefined), terminate })
    await expect(generarArchivo(rep(), 'transactions', 'xlsx', ['folio'], { spawnWorker, timeoutMs: 10 })).rejects.toMatchObject({
      statusCode: 504,
    })
    expect(terminate).toHaveBeenCalled()
  })
})

describe('conTurnoDeReporte', () => {
  it('uno a la vez: el segundo espera y, si no se libera, 429', async () => {
    let soltar!: () => void
    const primero = conTurnoDeReporte(() => new Promise<void>(r => (soltar = r)))
    await expect(conTurnoDeReporte(async () => 'x', 50)).rejects.toMatchObject({ statusCode: 429 })
    soltar()
    await primero
    await expect(conTurnoDeReporte(async () => 'ok', 50)).resolves.toBe('ok') // se liberó
  })
  it('se libera aunque la función truene', async () => {
    await expect(
      conTurnoDeReporte(async () => {
        throw new Error('x')
      }),
    ).rejects.toThrow('x')
    await expect(conTurnoDeReporte(async () => 'ok', 50)).resolves.toBe('ok')
  })
})

it('Excel: folio con ceros queda como texto; dinero con formato; nota arriba', () => {
  const buf = construirLibro({
    hoja: 'Transacciones',
    encabezado: ['Negocio', 'nota'],
    columnas: [
      { label: 'Folio', tipo: 'texto' },
      { label: 'Total', tipo: 'dinero' },
    ],
    filas: [['000123', -65]],
  })
  const ws = XLSX.read(buf).Sheets['Transacciones']
  expect(ws['A1'].v).toBe('Negocio')
  expect(ws['A5']).toMatchObject({ t: 's', v: '000123' })
  expect(ws['B5']).toMatchObject({ t: 'n', v: -65 })
})

describe('generarArchivo — sin columnas pedidas = todas', () => {
  it('Transacciones', async () => {
    const f = await generarArchivo(rep(), 'transactions', 'csv', [])
    expect(f.buffer.toString('utf8').slice(1).split('\r\n')[0]).toBe(
      'Negocio,Folio,Fecha del cobro,Terminal,Código de autorización,Tarjeta,Tipo de tarjeta,Operación,Marca,Consumo,Propina,Total,Comisión,IVA comisión,Total comisión,Monto a depositar,Fecha de depósito (estimada)',
    )
  })
  it('Dispersiones', async () => {
    const f = await generarArchivo(rep(), 'deposits', 'csv', [])
    expect(f.buffer.toString('utf8').slice(1).split('\r\n')[0]).toBe(
      'Negocio,Fecha de depósito (estimada),Periodo de cobros,Consumo,Propinas,Total,Comisión,IVA comisión,Total comisión,Depósito neto',
    )
  })
})
