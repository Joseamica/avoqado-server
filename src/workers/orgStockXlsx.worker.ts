import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import * as XLSX from 'xlsx'
import type { OrgStockOverview } from '../services/organization-dashboard/orgStockControl.types'

// WHY: este módulo corre en un worker thread. Sólo puede importar SheetJS y
// TIPOS — un import de valor que arrastre Prisma abriría un pool de conexiones
// nuevo por cada descarga.

export const ORG_STOCK_XLSX_TASK = 'build-org-stock-xlsx'

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

function buildResumenSheet(data: OrgStockOverview, orgSlug: string): XLSX.WorkSheet {
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

function buildCargasSheet(data: OrgStockOverview): XLSX.WorkSheet {
  const rows = data.bulkGroups.map((g, idx) => ({
    '#': idx + 1,
    'Fecha y Hora': fmtDateTime(g.firstCreatedAt),
    'Sucursal Receptora': g.registeredFromVenueName ?? '—',
    Categoría: g.categoryName,
    'Cantidad SIMs': g.itemCount,
    'ICCID Primero': g.serialNumberFirst,
    'ICCID Último': g.serialNumberLast,
    'Registrado Por': g.createdByName ?? '—',
    // White-label orgs use this; blank for everyone else.
    'ID Registrante': g.createdByEmployeeCode ?? '',
    Disponibles: g.availableCount,
    Vendidos: g.soldCount,
    Estado: g.soldCount > 0 ? 'Parcialmente vendido' : 'Todo disponible',
  }))
  return XLSX.utils.json_to_sheet(rows)
}

function buildDetalleSheet(data: OrgStockOverview): XLSX.WorkSheet {
  const rows = data.items.map((item, idx) => ({
    '#': idx + 1,
    ICCID: item.serialNumber,
    Categoría: item.categoryName,
    Estado: item.status,
    Custodia: item.custodyState,
    'Fecha Carga': fmtDate(item.createdAt),
    'Sucursal Receptora': item.registeredFromVenueName ?? '—',
    'Sucursal Actual': item.currentVenueName ?? 'Stock Org',
    'Sucursal Venta': item.sellingVenueName ?? '',
    'Fecha Venta': fmtDate(item.soldAt),
    'Registrado Por': item.createdByName ?? '—',
    'ID Registrante': item.createdByEmployeeCode ?? '',
    Supervisor: item.assignedSupervisorName ?? '',
    'ID Supervisor': item.assignedSupervisorEmployeeCode ?? '',
    Promotor: item.assignedPromoterName ?? '',
    'ID Promotor': item.assignedPromoterEmployeeCode ?? '',
  }))
  return XLSX.utils.json_to_sheet(rows)
}

function buildPorSucursalSheet(data: OrgStockOverview): XLSX.WorkSheet {
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

function buildPorCategoriaSheet(data: OrgStockOverview): XLSX.WorkSheet {
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

/**
 * Arma el libro completo. TODO lo que hay aquí es CPU síncrona: `json_to_sheet`
 * y `XLSX.write` no ceden el hilo ni una vez. Por eso vive en un worker y no en
 * el proceso que atiende cobros.
 *
 * ponytail: el costo es lineal con `data.items` (~1.7 s por cada 60k SIMs en una
 * Mac, más en el contenedor de Render). El techo real lo pone `resourceLimits`
 * del worker: si un tenant crece lo bastante, muere el thread y no la API. Si
 * eso empieza a pasar, el siguiente paso es un job de export con notificación,
 * no subirle la memoria.
 */
export function construirLibroXlsx(data: OrgStockOverview, orgSlug = ''): Buffer {
  const wb = XLSX.utils.book_new()

  const wsResumen = buildResumenSheet(data, orgSlug)
  wsResumen['!cols'] = [{ wch: 35 }, { wch: 28 }]
  XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen Ejecutivo')

  const wsCargas = buildCargasSheet(data)
  wsCargas['!cols'] = [
    { wch: 5 },
    { wch: 18 },
    { wch: 38 },
    { wch: 22 },
    { wch: 14 },
    { wch: 24 },
    { wch: 24 },
    { wch: 22 },
    { wch: 14 }, // ID Registrante
    { wch: 12 },
    { wch: 10 },
    { wch: 22 },
  ]
  XLSX.utils.book_append_sheet(wb, wsCargas, 'Cargas (Resumen)')

  const wsDetalle = buildDetalleSheet(data)
  wsDetalle['!cols'] = [
    { wch: 5 }, // #
    { wch: 24 }, // ICCID
    { wch: 22 }, // Categoría
    { wch: 12 }, // Estado
    { wch: 18 }, // Custodia
    { wch: 12 }, // Fecha Carga
    { wch: 38 }, // Sucursal Receptora
    { wch: 22 }, // Sucursal Actual
    { wch: 22 }, // Sucursal Venta
    { wch: 12 }, // Fecha Venta
    { wch: 25 }, // Registrado Por
    { wch: 14 }, // ID Registrante
    { wch: 22 }, // Supervisor
    { wch: 14 }, // ID Supervisor
    { wch: 22 }, // Promotor
    { wch: 14 }, // ID Promotor
  ]
  XLSX.utils.book_append_sheet(wb, wsDetalle, 'Detalle SIMs')

  const wsSucursal = buildPorSucursalSheet(data)
  wsSucursal['!cols'] = [{ wch: 5 }, { wch: 38 }, { wch: 20 }, { wch: 14 }, { wch: 12 }, { wch: 12 }]
  XLSX.utils.book_append_sheet(wb, wsSucursal, 'Por Sucursal')

  const wsCategoria = buildPorCategoriaSheet(data)
  wsCategoria['!cols'] = [{ wch: 5 }, { wch: 30 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 20 }]
  XLSX.utils.book_append_sheet(wb, wsCategoria, 'Por Categoría')

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

if (!isMainThread && parentPort && workerData?.task === ORG_STOCK_XLSX_TASK) {
  const port = parentPort
  try {
    const buffer = construirLibroXlsx(workerData.data as OrgStockOverview, workerData.orgSlug as string)
    // WHY: copia de tamaño exacto para poder TRANSFERIRLA. Sin transferList el
    // buffer se clona y el hilo principal paga la copia de decenas de MB que
    // este worker existe para evitar.
    const bytes = new ArrayBuffer(buffer.length)
    new Uint8Array(bytes).set(buffer)
    port.postMessage({ ok: true, bytes }, [bytes])
  } catch {
    // WHY: el detalle del fallo no viaja — puede traer ICCIDs del tenant.
    port.postMessage({ ok: false })
  }
}
