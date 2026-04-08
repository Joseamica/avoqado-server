import * as XLSX from 'xlsx'
import { orgStockControlService } from './orgStockControl.service'
import type { OrgStockOverview, OrgStockOverviewOptions } from './orgStockControl.types'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export class OrgStockControlExportService {
  async generateExcelBuffer(
    orgId: string,
    options: OrgStockOverviewOptions,
    orgSlug: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const data = await orgStockControlService.getOrgOverview(orgId, options)

    const wb = XLSX.utils.book_new()

    const wsResumen = this.buildResumenSheet(data, orgSlug)
    wsResumen['!cols'] = [{ wch: 35 }, { wch: 28 }]
    XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen Ejecutivo')

    const wsCargas = this.buildCargasSheet(data)
    wsCargas['!cols'] = [
      { wch: 5 },
      { wch: 18 },
      { wch: 38 },
      { wch: 22 },
      { wch: 14 },
      { wch: 24 },
      { wch: 24 },
      { wch: 22 },
      { wch: 12 },
      { wch: 10 },
      { wch: 22 },
    ]
    XLSX.utils.book_append_sheet(wb, wsCargas, 'Cargas (Resumen)')

    const wsDetalle = this.buildDetalleSheet(data)
    wsDetalle['!cols'] = [
      { wch: 5 },
      { wch: 24 },
      { wch: 22 },
      { wch: 12 },
      { wch: 12 },
      { wch: 38 },
      { wch: 22 },
      { wch: 22 },
      { wch: 12 },
      { wch: 25 },
    ]
    XLSX.utils.book_append_sheet(wb, wsDetalle, 'Detalle SIMs')

    const wsSucursal = this.buildPorSucursalSheet(data)
    wsSucursal['!cols'] = [{ wch: 5 }, { wch: 38 }, { wch: 20 }, { wch: 14 }, { wch: 12 }, { wch: 12 }]
    XLSX.utils.book_append_sheet(wb, wsSucursal, 'Por Sucursal')

    const wsCategoria = this.buildPorCategoriaSheet(data)
    wsCategoria['!cols'] = [{ wch: 5 }, { wch: 30 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 20 }]
    XLSX.utils.book_append_sheet(wb, wsCategoria, 'Por Categoría')

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer

    const dateStr = new Date().toISOString().split('T')[0]
    const safeSlug = orgSlug.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
    const filename = `${safeSlug}-control-stock-${dateStr}.xlsx`

    return { buffer, filename }
  }

  private buildResumenSheet(data: OrgStockOverview, orgSlug: string): XLSX.WorkSheet {
    const { summary } = data
    const rows = [
      { Métrica: 'Organización', Valor: orgSlug },
      { Métrica: 'Fecha del reporte', Valor: fmtDate(summary.generatedAt) },
      { Métrica: '', Valor: '' },
      { Métrica: 'TOTAL SIMs cargadas', Valor: summary.totalSims },
      { Métrica: 'SIMs disponibles', Valor: summary.available },
      { Métrica: 'SIMs vendidas', Valor: summary.sold },
      { Métrica: 'SIMs dañadas', Valor: summary.damaged },
      { Métrica: 'SIMs devueltas', Valor: summary.returned },
      { Métrica: '% Rotación', Valor: `${summary.rotacionPct.toFixed(2)}%` },
      { Métrica: '', Valor: '' },
      { Métrica: 'Total de cargas (bulk groups)', Valor: summary.totalCargas },
      { Métrica: 'Sucursales involucradas', Valor: summary.sucursalesInvolucradas },
      { Métrica: 'Categorías activas', Valor: summary.categoriasActivas },
      { Métrica: '', Valor: '' },
      { Métrica: 'Rango desde', Valor: fmtDate(summary.dateRange.from) },
      { Métrica: 'Rango hasta', Valor: fmtDate(summary.dateRange.to) },
    ]
    return XLSX.utils.json_to_sheet(rows)
  }

  private buildCargasSheet(data: OrgStockOverview): XLSX.WorkSheet {
    const rows = data.bulkGroups.map((g, idx) => ({
      '#': idx + 1,
      'Fecha y Hora': fmtDateTime(g.firstCreatedAt),
      'Sucursal Receptora': g.registeredFromVenueName ?? '—',
      Categoría: g.categoryName,
      'Cantidad SIMs': g.itemCount,
      'ICCID Primero': g.serialNumberFirst,
      'ICCID Último': g.serialNumberLast,
      'Registrado Por': g.createdByName ?? '—',
      Disponibles: g.availableCount,
      Vendidos: g.soldCount,
      Estado: g.soldCount > 0 ? 'Parcialmente vendido' : 'Todo disponible',
    }))
    return XLSX.utils.json_to_sheet(rows)
  }

  private buildDetalleSheet(data: OrgStockOverview): XLSX.WorkSheet {
    const rows = data.items.map((item, idx) => ({
      '#': idx + 1,
      ICCID: item.serialNumber,
      Categoría: item.categoryName,
      Estado: item.status,
      'Fecha Carga': fmtDate(item.createdAt),
      'Sucursal Receptora': item.registeredFromVenueName ?? '—',
      'Sucursal Actual': item.currentVenueName ?? 'Stock Org',
      'Sucursal Venta': item.sellingVenueName ?? '',
      'Fecha Venta': fmtDate(item.soldAt),
      'Registrado Por': item.createdByName ?? '—',
    }))
    return XLSX.utils.json_to_sheet(rows)
  }

  private buildPorSucursalSheet(data: OrgStockOverview): XLSX.WorkSheet {
    const rows = data.aggregatesBySucursal.map((agg, idx) => ({
      '#': idx + 1,
      'Sucursal Receptora': agg.venueName,
      'Total SIMs Cargados': agg.totalSims,
      Disponibles: agg.available,
      Vendidos: agg.sold,
      '% Vendido': `${agg.rotacionPct.toFixed(2)}%`,
    }))
    return XLSX.utils.json_to_sheet(rows)
  }

  private buildPorCategoriaSheet(data: OrgStockOverview): XLSX.WorkSheet {
    const rows = data.aggregatesByCategoria.map((agg, idx) => ({
      '#': idx + 1,
      Categoría: agg.categoryName,
      'Total SIMs': agg.totalSims,
      Disponibles: agg.available,
      Vendidos: agg.sold,
      '% Rotación': `${agg.rotacionPct.toFixed(2)}%`,
      '% del Total': `${agg.pctOfTotal.toFixed(2)}%`,
      'Sucursales con Stock': agg.sucursalesConStock,
    }))
    return XLSX.utils.json_to_sheet(rows)
  }
}

export const orgStockControlExportService = new OrgStockControlExportService()
