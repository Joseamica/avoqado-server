import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as XLSX from 'xlsx'
import { construirLibroXlsx } from '@/workers/orgStockXlsx.worker'
import { createOrgStockControlExportService } from '@/services/organization-dashboard/orgStockControlExport.service'
import type { OrgStockOverview } from '@/services/organization-dashboard/orgStockControl.types'

function overview(itemCount: number): OrgStockOverview {
  return {
    summary: {
      generatedAt: '2026-09-19T17:44:22.000Z',
      totalSims: itemCount,
      available: itemCount,
      sold: 0,
      damaged: 0,
      returned: 0,
      rotacionPct: 0,
      totalCargas: 1,
      sucursalesInvolucradas: 1,
      categoriasActivas: 1,
      dateRange: { from: '2025-09-19T06:00:00.000Z', to: '2026-09-20T05:59:59.999Z' },
    } as any,
    items: Array.from({ length: itemCount }, (_, i) => ({
      id: `sim-${i}`,
      serialNumber: `8952${String(i).padStart(16, '0')}`,
      categoryName: 'BAIT 100',
      status: 'AVAILABLE',
      custodyState: 'ORG_WAREHOUSE',
      createdAt: '2026-03-14T10:00:00.000Z',
      registeredFromVenueName: 'BAE Mezquital',
      currentVenueName: null,
      sellingVenueName: null,
      soldAt: null,
      createdByName: 'Juan Pérez',
      createdByEmployeeCode: 'PT-004821',
      assignedSupervisorName: null,
      assignedSupervisorEmployeeCode: null,
      assignedPromoterName: null,
      assignedPromoterEmployeeCode: null,
    })) as any,
    bulkGroups: [
      {
        firstCreatedAt: '2026-03-14T10:00:00.000Z',
        registeredFromVenueName: 'BAE Mezquital',
        categoryName: 'BAIT 100',
        itemCount,
        serialNumberFirst: '8952...0',
        serialNumberLast: '8952...N',
        createdByName: 'Juan Pérez',
        createdByEmployeeCode: 'PT-004821',
        availableCount: itemCount,
        soldCount: 0,
      },
    ] as any,
    aggregatesBySucursal: [{ venueName: 'BAE Mezquital', totalSims: itemCount, available: itemCount, sold: 0, rotacionPct: 0 }] as any,
    aggregatesByCategoria: [
      {
        categoryName: 'BAIT 100',
        totalSims: itemCount,
        available: itemCount,
        sold: 0,
        rotacionPct: 0,
        pctOfTotal: 100,
        sucursalesConStock: 1,
      },
    ] as any,
    meta: { itemsTotal: itemCount, itemsTruncated: false },
  }
}

describe('org stock export — el libro se arma FUERA del hilo principal', () => {
  it('no importa SheetJS en el servicio: el trabajo síncrono de CPU vive en el worker', () => {
    // WHY: el 19-sep-2026 este export congeló el event loop 3.27 s (Better Stack
    // "Server congelado ≥3 s"). XLSX.write y json_to_sheet son síncronos: si el
    // servicio vuelve a importarlos, el congelamiento regresa.
    const source = readFileSync(join(process.cwd(), 'src/services/organization-dashboard/orgStockControlExport.service.ts'), 'utf8')
    expect(source).not.toMatch(/from\s+['"]xlsx['"]/u)
  })

  it('delega en el worker y devuelve su buffer sin tocar el libro en el hilo principal', async () => {
    const esperado = Buffer.from('xlsx-del-worker')
    const spawnWorker = jest.fn(() => ({ result: Promise.resolve(esperado), terminate: jest.fn().mockResolvedValue(0) }))
    const service = createOrgStockControlExportService({ spawnWorker, fetchOverview: async () => overview(1) })

    const { buffer, filename } = await service.generateExcelBuffer('org-1', {}, 'playtelecom')

    expect(spawnWorker).toHaveBeenCalledTimes(1)
    expect(buffer).toEqual(esperado)
    expect(filename).toMatch(/^playtelecom-control-stock-\d{4}-\d{2}-\d{2}\.xlsx$/u)
  })

  it('un worker colgado no deja la petición esperando para siempre', async () => {
    const terminate = jest.fn().mockResolvedValue(0)
    const service = createOrgStockControlExportService({
      fetchOverview: async () => overview(1),
      spawnWorker: () => ({ result: new Promise<Buffer>(() => undefined), terminate }),
      timeoutMs: 20,
    })

    await expect(service.generateExcelBuffer('org-1', {}, 'pt')).rejects.toMatchObject({ code: 'ORG_STOCK_EXPORT_TIMEOUT' })
    expect(terminate).toHaveBeenCalled()
  })

  it('si el worker truena, el error no se traga ni cuelga el hilo', async () => {
    const terminate = jest.fn().mockResolvedValue(0)
    const service = createOrgStockControlExportService({
      fetchOverview: async () => overview(1),
      spawnWorker: () => ({ result: Promise.reject(new Error('boom')), terminate }),
    })

    await expect(service.generateExcelBuffer('org-1', {}, 'pt')).rejects.toMatchObject({ code: 'ORG_STOCK_EXPORT_WORKER_FAILED' })
    expect(terminate).toHaveBeenCalled()
  })
})

describe('org stock export — el libro que arma el worker', () => {
  it('conserva las cinco hojas y una fila por SIM', () => {
    const buffer = construirLibroXlsx(overview(3))
    const wb = XLSX.read(buffer, { type: 'buffer' })

    expect(wb.SheetNames).toEqual(['Resumen Ejecutivo', 'Cargas (Resumen)', 'Detalle SIMs', 'Por Sucursal', 'Por Categoría'])
    const detalle = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Detalle SIMs']!)
    expect(detalle).toHaveLength(3)
    expect(detalle[0]).toMatchObject({
      ICCID: '89520000000000000000',
      Categoría: 'BAIT 100',
      Estado: 'AVAILABLE',
      'Fecha Carga': '2026-03-14',
      'ID Registrante': 'PT-004821',
      'Sucursal Actual': 'Stock Org',
    })
  })
})

describe('org stock export — el worker REAL arranca', () => {
  // WHY: la ruta del worker y su execArgv cambian entre `src/*.ts` (tsx/ts-node)
  // y `dist/*.js`. Un mock nunca ve ese fallo; sólo arrancar el thread lo ve.
  it('genera un xlsx legible lanzando el thread de verdad', async () => {
    const { createOrgStockControlExportService: real } = await import('@/services/organization-dashboard/orgStockControlExport.service')
    const service = real({ fetchOverview: async () => overview(50) })

    const { buffer } = await service.generateExcelBuffer('org-1', {}, 'pt')
    const wb = XLSX.read(buffer, { type: 'buffer' })

    expect(wb.SheetNames).toContain('Detalle SIMs')
    expect(XLSX.utils.sheet_to_json(wb.Sheets['Detalle SIMs']!)).toHaveLength(50)
  }, 30_000)
})
