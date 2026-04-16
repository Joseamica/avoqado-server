import { SerializedItemCustodyState, SerializedItemStatus } from '@prisma/client'

export interface OrgStockOverviewItem {
  id: string
  serialNumber: string
  status: SerializedItemStatus
  categoryId: string
  categoryName: string
  createdAt: string
  soldAt: string | null
  registeredFromVenueId: string | null
  registeredFromVenueName: string | null
  sellingVenueId: string | null
  sellingVenueName: string | null
  currentVenueId: string | null
  currentVenueName: string | null
  createdById: string | null
  createdByName: string | null
  // Chain-of-custody (plan §2.2). Populated by the custody service + shown as
  // new columns in the Detalle SIMs table.
  custodyState: SerializedItemCustodyState
  assignedSupervisorId: string | null
  assignedSupervisorName: string | null
  assignedPromoterId: string | null
  assignedPromoterName: string | null
  promoterAcceptedAt: string | null
  promoterRejectedAt: string | null
}

export interface OrgStockBulkGroup {
  id: string
  firstCreatedAt: string
  lastCreatedAt: string
  categoryId: string
  categoryName: string
  registeredFromVenueId: string | null
  registeredFromVenueName: string | null
  createdById: string | null
  createdByName: string | null
  itemCount: number
  serialNumberFirst: string
  serialNumberLast: string
  serialNumbers: string[]
  availableCount: number
  soldCount: number
  damagedCount: number
  returnedCount: number
}

export interface OrgStockSucursalAggregate {
  venueId: string
  venueName: string
  totalSims: number
  available: number
  sold: number
  damaged: number
  returned: number
  rotacionPct: number
  salesLast7Days: number[]
  lastActivity: string | null
}

export interface OrgStockCategoriaAggregate {
  categoryId: string
  categoryName: string
  totalSims: number
  available: number
  sold: number
  rotacionPct: number
  pctOfTotal: number
  sucursalesConStock: number
  estimatedCoverageDays: number | null
}

export interface OrgStockLastActivity {
  timestamp: string
  venueName: string
  action: 'UPLOAD' | 'SALE'
}

export interface OrgStockSummary {
  totalSims: number
  available: number
  sold: number
  damaged: number
  returned: number
  rotacionPct: number
  totalCargas: number
  sucursalesInvolucradas: number
  categoriasActivas: number
  dateRange: { from: string; to: string }
  generatedAt: string
  lastActivity: OrgStockLastActivity | null
}

export interface OrgStockOverview {
  summary: OrgStockSummary
  items: OrgStockOverviewItem[]
  bulkGroups: OrgStockBulkGroup[]
  aggregatesBySucursal: OrgStockSucursalAggregate[]
  aggregatesByCategoria: OrgStockCategoriaAggregate[]
}

export interface OrgStockOverviewOptions {
  dateFrom?: Date
  dateTo?: Date
}
