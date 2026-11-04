import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import * as XLSX from 'xlsx'
import { construirXlsxDesdeMatriz } from '@/services/exports/xlsxDesdeMatriz'
import { EscritorCsv, abrirLibroXlsx } from '@/services/exports/exportEscritores'

describe('escritores de exporte', () => {
  it('xlsx desde matriz: encabezados, números con formato y hoja', () => {
    const buf = construirXlsxDesdeMatriz({
      encabezados: ['ID', 'Total'],
      formatos: [undefined, '$#,##0.00'],
      filas: [['p1', 160]],
      hoja: 'Ventas detalladas',
    })
    const ws = XLSX.read(buf, { cellNF: true }).Sheets['Ventas detalladas']
    expect(ws.A1.v).toBe('ID')
    expect(ws.B2.v).toBe(160)
    expect(ws.B2.z).toBe('$#,##0.00')
  })
  it('xlsx con cero filas trae sólo encabezados', () => {
    const wb = XLSX.read(construirXlsxDesdeMatriz({ encabezados: ['ID'], formatos: [undefined], filas: [], hoja: 'X' }))
    expect(XLSX.utils.sheet_to_json(wb.Sheets.X, { header: 1 })).toEqual([['ID']])
  })
  it('el libro en worker junta las páginas en orden', async () => {
    const libro = abrirLibroXlsx({ encabezados: ['ID'], formatos: [undefined], hoja: 'X' })
    libro.agregar([['p1'], ['p2']])
    libro.agregar([['p3']])
    const buf = await libro.cerrar()
    expect(XLSX.utils.sheet_to_json(XLSX.read(buf).Sheets.X, { header: 1 })).toEqual([['ID'], ['p1'], ['p2'], ['p3']])
  }, 30_000)
  it('un worker que nunca contesta no cuelga el exporte: cerrar() rechaza por tiempo y termina el hilo', async () => {
    const hilo = Object.assign(new EventEmitter(), { postMessage: jest.fn(), terminate: jest.fn(async () => 1) })
    const libro = abrirLibroXlsx({ encabezados: ['ID'], formatos: [undefined], hoja: 'X' }, { timeoutMs: 20, crearHilo: () => hilo as any })
    await expect(libro.cerrar()).rejects.toThrow('EXPORT_XLSX_TIMEOUT')
    expect(hilo.terminate).toHaveBeenCalled()
  })
  it('csv: BOM, CRLF, escapa comas y comillas, por tandas', async () => {
    const destino = new PassThrough()
    const trozos: Buffer[] = []
    destino.on('data', c => trozos.push(c))
    const w = new EscritorCsv(destino, ['Mesero', 'Total'])
    await w.agregar([['Pérez, Ana', 10]])
    await w.agregar([['Dice "hola"', 20]])
    const bytes = await w.cerrar()
    const texto = Buffer.concat(trozos).toString('utf8')
    expect(texto).toBe('﻿Mesero,Total\r\n"Pérez, Ana",10\r\n"Dice ""hola""",20')
    expect(bytes).toBe(Buffer.byteLength(texto))
  })
  it('csv: si el destino falla, agregar() rechaza en vez de quedarse esperando el drain', async () => {
    const destino = new PassThrough({ highWaterMark: 1 }) // sin lector: se llena al primer write
    const w = new EscritorCsv(destino, ['A'], { timeoutMs: 5_000 })
    const p = w.agregar([['x'.repeat(100)]])
    destino.destroy(new Error('gcs caído'))
    await expect(p).rejects.toThrow('gcs caído')
  })
  it('🔴 csv: si el destino falla ENTRE páginas, no queda error sin escucha y la siguiente escritura y el cierre lo lanzan (Codex r2 N1)', async () => {
    const destino = new PassThrough()
    destino.resume()
    const w = new EscritorCsv(destino, ['A'])
    await w.agregar([['x']])
    expect(destino.listenerCount('error')).toBeGreaterThan(0)
    destino.destroy(new Error('gcs caído entre páginas')) // sin escucha, esto sería una excepción sin capturar
    await new Promise(r => setImmediate(r))
    await expect(w.agregar([['y']])).rejects.toThrow('gcs caído entre páginas')
    await expect(w.cerrar()).rejects.toThrow('gcs caído entre páginas')
  })
})
