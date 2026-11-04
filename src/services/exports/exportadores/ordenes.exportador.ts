import type { ExportColumnDef } from '@/services/dashboard/export.helpers'
import { countOrdersForExportHasta, fetchOrdersExportPage, type OrderFilters } from '@/services/dashboard/order.dashboard.service'
import { construirWhereKeyset, fecha, lista, str } from './comun'
import type { Exportador } from './types'

export type FilaOrden = Awaited<ReturnType<typeof fetchOrdersExportPage>>[number]

// Mismo registro que el GET viejo (`order.dashboard.controller.ts`, `exportOrdersData`); ahora vive aquí y el controller lo importa.
export const ORDENES_COLUMNAS: ExportColumnDef<FilaOrden>[] = [
  { id: 'createdAt', label: 'Fecha', value: r => r.createdAt?.toISOString() ?? '' },
  { id: 'orderId', label: 'ID', value: r => r.id },
  { id: 'orderNumber', label: 'Folio', value: r => r.orderNumber ?? '' },
  { id: 'type', label: 'Tipo', value: r => r.type ?? '' },
  { id: 'customerName', label: 'Cliente', value: r => r.customerName ?? '' },
  { id: 'tableName', label: 'Mesa', value: r => r.table?.number ?? '' },
  {
    id: 'waiterName',
    label: 'Mesero',
    value: r => {
      const w = r.servedBy || r.createdBy
      return w ? `${w.firstName ?? ''} ${w.lastName ?? ''}`.trim() : ''
    },
  },
  { id: 'status', label: 'Estatus', value: r => r.status ?? '' },
  { id: 'productsCount', label: 'Productos', value: r => r._count?.items ?? 0 },
  { id: 'tipAmount', label: 'Propina', value: r => Number(r.tipAmount) || 0 },
  { id: 'total', label: 'Total', value: r => Number(r.total) || 0 },
]

export const ordenes: Exportador<OrderFilters, FilaOrden> = {
  kind: 'ordenes',
  titulo: 'Órdenes',
  nombreArchivo: 'orders', // el mismo nombre de archivo que baja hoy
  permiso: 'orders:read',
  parsearFiltros(raw) {
    const r = (raw ?? {}) as Record<string, unknown>
    return {
      statuses: lista(r.statuses),
      types: lista(r.types),
      tableIds: lista(r.tableIds),
      staffIds: lista(r.staffIds),
      search: str(r.search),
      startDate: fecha(r.startDate, 'startDate'),
      endDate: fecha(r.endDate, 'endDate'),
    }
  },
  async autorizar() {
    return null // hoy: sólo `orders:read` en la ruta, sin función de plan
  },
  columnas: ORDENES_COLUMNAS,
  contar: (venueId, f, corte) => countOrdersForExportHasta(venueId, f, corte),
  pagina: (venueId, f, corte, despuesDe, limite) => fetchOrdersExportPage(venueId, f, corte, construirWhereKeyset(despuesDe), limite),
  cursorDe: f => ({ createdAt: f.createdAt.toISOString(), id: f.id }),
}
