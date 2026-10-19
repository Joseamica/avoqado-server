/**
 * Script de importación de Shopify (bloque 5, Task 6): aplica por lotes y junta las filas de familia que el servicio rechazó.
 * `importMenu` va simulado: el script lo recibe como función, sin tocar la base.
 */
import Papa from 'papaparse'

import { chunkImportMenuData, convertShopifyCsv } from '@/services/dashboard/shopifyCatalogImport'
import { aplicarLotes, reporteCsv, resumenFinal } from '../../../scripts/importar-catalogo-shopify'

const HEADERS = ['Handle', 'Title', 'Status', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price']
const fila = (handle: string, title: string, value: string, sku: string) => [handle, title, 'active', 'Talla', value, sku, '10.00'] as const
const archivo = Papa.unparse({
  fields: HEADERS,
  data: [
    fila('camisa', 'Camisa', 'S', 'CA-S'),
    fila('camisa', '', 'M', 'CA-M'),
    fila('falda', 'Falda', 'S', 'FA-S'),
    fila('falda', '', 'M', 'FA-M'),
  ],
})
const conversion = convertShopifyCsv(archivo, { factor: '20' })
const stats = (ejemplos: Array<{ sku: string; name: string; motivo: string }>) => ({
  products: 2 - ejemplos.length,
  productsKeptOnRecipe: 0,
  productsKeptUntracked: 0,
  filasDeFamiliaRechazadas: { total: ejemplos.length, ejemplos },
})

describe('aplicarLotes', () => {
  it('un lote parcialmente rechazado y otro rechazado entero: junta TODAS las filas con su lote y el resumen no dice sólo «Aplicado»', async () => {
    const chunks = chunkImportMenuData(conversion.data, 2)
    expect(chunks).toHaveLength(2)
    const respuestas = [
      stats([{ sku: 'CA-M', name: 'Camisa · M', motivo: 'El código 7501 ya lo tiene «Dueño».' }]),
      stats([
        { sku: 'FA-S', name: 'Falda · S', motivo: 'Ya existe otra familia «Falda»' },
        { sku: 'FA-M', name: 'Falda · M', motivo: 'Ya existe otra familia «Falda»' },
      ]),
    ]
    const importar = jest.fn(async () => ({ stats: respuestas.shift()! }))
    const log = jest.fn()

    const rechazadas = await aplicarLotes(chunks, importar, log)

    expect(importar).toHaveBeenCalledTimes(2)
    expect(rechazadas).toEqual([
      { lote: 1, sku: 'CA-M', name: 'Camisa · M', motivo: 'El código 7501 ya lo tiene «Dueño».' },
      { lote: 2, sku: 'FA-S', name: 'Falda · S', motivo: 'Ya existe otra familia «Falda»' },
      { lote: 2, sku: 'FA-M', name: 'Falda · M', motivo: 'Ya existe otra familia «Falda»' },
    ])
    const dicho = log.mock.calls.map(c => c[0]).join('\n')
    expect(dicho).toContain('lote 1/2')
    expect(dicho).toContain('lote 2/2')
    expect(dicho).toContain('CA-M')
    expect(dicho).toContain('Ya existe otra familia «Falda»')

    const resumen = resumenFinal(2, 2, rechazadas)
    expect(resumen).toContain('Aplicado con 3 filas rechazadas')
    expect(resumen).not.toContain('✅')
  })

  it('sin rechazos el resumen es el de siempre', async () => {
    const chunks = chunkImportMenuData(conversion.data, 2)
    const rechazadas = await aplicarLotes(chunks, async () => ({ stats: stats([]) }), jest.fn())
    expect(rechazadas).toEqual([])
    expect(resumenFinal(2, 2, rechazadas)).toBe('\n✅ Aplicado: 2 lote(s); bitácora: 2 registro(s) MENU_IMPORTED.')
  })

  it('si un lote falla, avisa cuántos quedaron cargados y vuelve a lanzar el error', async () => {
    const chunks = chunkImportMenuData(conversion.data, 2)
    const importar = jest
      .fn()
      .mockResolvedValueOnce({ stats: stats([]) })
      .mockRejectedValueOnce(new Error('se cayó'))
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(aplicarLotes(chunks, importar, jest.fn())).rejects.toThrow('se cayó')
    expect(error.mock.calls.map(c => c[0]).join('\n')).toContain('Falló el lote 2/2; los 1 anteriores sí quedaron cargados')
    error.mockRestore()
  })
})

describe('reporteCsv', () => {
  const outcome = (_sku: string, omitted: boolean) => (omitted ? 'OMITIDO' : 'CREAR')
  const leer = (texto: string) => Papa.parse<Record<string, string>>(texto, { header: true }).data

  it('trae la columna «familia» (el Handle con el que viaja cada variante)', () => {
    const filas = leer(reporteCsv(conversion.variants, outcome, new Map()))
    expect(filas.map(f => [f.sku, f.familia, f.estado])).toEqual([
      ['CA-S', 'camisa', 'CREAR'],
      ['CA-M', 'camisa', 'CREAR'],
      ['FA-S', 'falda', 'CREAR'],
      ['FA-M', 'falda', 'CREAR'],
    ])
  })

  it('una fila rechazada por el servicio sale como RECHAZADO_FAMILIA con su motivo', () => {
    const filas = leer(reporteCsv(conversion.variants, outcome, new Map([['CA-M', 'El código 7501 ya lo tiene «Dueño».']])))
    const rechazada = filas.find(f => f.sku === 'CA-M')!
    expect(rechazada.estado).toBe('RECHAZADO_FAMILIA')
    expect(rechazada.detalle).toContain('El código 7501 ya lo tiene «Dueño».')
    expect(filas.find(f => f.sku === 'CA-S')!.estado).toBe('CREAR')
  })
})
