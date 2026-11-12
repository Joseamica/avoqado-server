import type { ExportColumnDef } from '@/services/dashboard/export.helpers'
import {
  countGlobalMovementsForExportHasta,
  fetchGlobalMovementsExportPage,
  type FiltrosHistorial,
} from '@/services/dashboard/productInventory.service'
import { venueHasFeatureAccess, venueIsExemptFromPlanGating } from '@/services/access/basePlan.service'
import { construirWhereKeyset, fecha, sinFuncion, str } from './comun'
import type { Exportador } from './types'
import { TIPOS_DEL_FILTRO_HISTORIAL } from '@/schemas/dashboard/inventory.schema'

export type FilaHistorial = Awaited<ReturnType<typeof fetchGlobalMovementsExportPage>>[number]

/**
 * El tipo de movimiento en las palabras de la pantalla del Historial (`movementTypeLabel` del DASHBOARD),
 * para que el archivo y la tabla digan lo mismo. Entrada y salida de un traspaso se distinguen: en el
 * archivo no hay ícono de flecha que lo diga.
 */
const TIPO_MOVIMIENTO: Record<string, string> = {
  PURCHASE: 'Recibido',
  COUNT: 'Reconteo',
  LOSS: 'Pérdida',
  USAGE: 'Uso',
  ADJUSTMENT: 'Ajuste',
  RETURN: 'Devolución',
  SALE: 'Venta',
  TRANSFER: 'Transferencia',
  TRANSFER_IN: 'Transferencia (entrada)',
  TRANSFER_OUT: 'Transferencia (salida)',
  SPOILAGE: 'Desperdicio',
}

/** Los tipos que la pantalla deja filtrar en el servidor: los mismos de la ruta del Historial. */
const TIPOS_DEL_FILTRO = new Set<string>(TIPOS_DEL_FILTRO_HISTORIAL)

export const HISTORIAL_INVENTARIO_COLUMNAS: ExportColumnDef<FilaHistorial>[] = [
  { id: 'createdAt', label: 'Fecha', value: r => (r.createdAt ? new Date(r.createdAt).toISOString() : '') },
  { id: 'itemName', label: 'Nombre', value: r => r.itemName ?? '' },
  { id: 'category', label: 'Artículo', value: r => (r.category === 'INGREDIENT' ? 'Insumo' : 'Producto') },
  { id: 'sku', label: 'SKU', value: r => r.sku ?? '' },
  // Un tipo sin traducir sale tal cual: sigue diciendo qué pasó; una celda vacía lo perdería.
  { id: 'type', label: 'Movimiento', value: r => TIPO_MOVIMIENTO[r.type] ?? r.type ?? '' },
  { id: 'quantity', label: 'Ajuste', value: r => Number(r.quantity) || 0 },
  { id: 'unit', label: 'Unidad', value: r => r.unit ?? '' },
  { id: 'previousStock', label: 'Existencia anterior', value: r => Number(r.previousStock) || 0 },
  { id: 'newStock', label: 'Existencia nueva', value: r => Number(r.newStock) || 0 },
  { id: 'cost', label: 'Coste unitario', value: r => Number(r.cost) || 0 },
  // Igual que la pantalla y el kardex: una merma con folio sin costo no vale $0, nadie la valoró.
  // El texto no suma en una hoja de cálculo, igual que una celda vacía.
  { id: 'totalCost', label: 'Coste total', value: r => (r.totalCost === null ? 'Sin valorar' : Number(r.totalCost) || 0) },
  { id: 'supplierName', label: 'Proveedor', value: r => r.supplierName ?? '' },
  { id: 'reason', label: 'Motivo', value: r => r.reason ?? '' },
  { id: 'reference', label: 'Referencia', value: r => r.reference ?? '' },
  { id: 'staffName', label: 'Responsable', value: r => r.staffName ?? '' },
  // Merma: con el folio, su código de motivo y lo «sin existencia» la declaración se reconstruye
  // sumando por folio; el excedente va sólo en el primer renglón del folio (como en la pantalla).
  { id: 'wasteReportId', label: 'Folio de merma', value: r => r.wasteReportId ?? '' },
  { id: 'wasteReasonCode', label: 'Código de motivo', value: r => r.wasteReasonCode ?? '' },
  { id: 'wasteUnrecorded', label: 'Sin existencia', value: r => r.wasteUnrecorded ?? '' },
  { id: 'movementId', label: 'ID', value: r => r.id },
]

export const historialInventario: Exportador<FiltrosHistorial, FilaHistorial> = {
  kind: 'historial-inventario',
  titulo: 'Historial de inventario',
  nombreArchivo: 'historial-inventario',
  permiso: 'inventory:read', // el mismo de la pantalla (`GET /inventory/movements`)
  parsearFiltros(raw) {
    const r = (raw ?? {}) as Record<string, unknown>
    const tipo = str(r.type)
    return {
      search: str(r.search),
      startDate: fecha(r.startDate, 'startDate'),
      endDate: fecha(r.endDate, 'endDate'),
      // Un tipo que la pantalla no ofrece no filtra nada raro: se ignora (= todos), como `ALL`.
      type: tipo && TIPOS_DEL_FILTRO.has(tipo) && tipo !== 'ALL' ? tipo : undefined,
    }
  },
  /** El mismo candado de la pantalla: `checkFeatureAccess('INVENTORY_TRACKING')` en todo `/inventory`. */
  async autorizar(ctx) {
    if (ctx.esSuperadmin) return null
    if (await venueIsExemptFromPlanGating(ctx.venueId)) return null
    if (await venueHasFeatureAccess(ctx.venueId, 'INVENTORY_TRACKING')) return null
    return sinFuncion('INVENTORY_TRACKING')
  },
  columnas: HISTORIAL_INVENTARIO_COLUMNAS,
  contar: (venueId, f, corte) => countGlobalMovementsForExportHasta(venueId, f, corte),
  pagina: (venueId, f, corte, despuesDe, limite) =>
    fetchGlobalMovementsExportPage(venueId, f, corte, construirWhereKeyset(despuesDe), limite),
  cursorDe: f => ({ createdAt: new Date(f.createdAt).toISOString(), id: f.id }),
}
