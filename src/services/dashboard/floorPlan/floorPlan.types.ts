/**
 * Plano de mesas del dashboard (spec docs/superpowers/specs/2026-10-08-plano-de-mesas-dashboard-design.md).
 * Coordenadas normalizadas 0–1 relativas a la caja del ÁREA: mesa = centro; barra/cocina/puerta = esquina
 * superior izquierda + ancho/alto; pared = inicio → fin; letrero = esquina superior izquierda.
 */
export const FLOOR_PLAN_LIMITS = { areas: 30, tables: 500, elements: 1500 } as const

export type FloorShapeCode = 'WIDE' | 'SQUARE' | 'TALL'
export type TableShapeCode = 'SQUARE' | 'ROUND' | 'RECTANGLE'
export type FloorElementTypeCode = 'WALL' | 'BAR_COUNTER' | 'SERVICE_AREA' | 'LABEL' | 'DOOR'

export interface PlanArea {
  id: string
  name: string
  floorShape: FloorShapeCode | null
  sortOrder: number
  externalId: string | null
}

export interface PlanTable {
  id: string
  number: string
  capacity: number
  shape: TableShapeCode
  rotation: number
  positionX: number | null
  positionY: number | null
  areaId: string | null
  /** Tiene una cuenta sin pagar: el editor no ofrece quitarla y el servidor no la archiva. */
  hasOpenOrder: boolean
}

export interface PlanElement {
  id: string
  type: FloorElementTypeCode
  areaId: string | null
  positionX: number
  positionY: number
  width: number | null
  height: number | null
  rotation: number
  endX: number | null
  endY: number | null
  label: string | null
  color: string | null
}

export interface FloorPlanDto {
  fingerprint: string
  areas: PlanArea[]
  tables: PlanTable[]
  elements: PlanElement[]
  limits: typeof FLOOR_PLAN_LIMITS
  overLimit: boolean
}

export interface DesiredArea {
  id?: string
  clientId?: string
  name: string
  floorShape: FloorShapeCode
  sortOrder: number
}

export interface DesiredTable {
  id?: string
  clientId?: string
  number: string
  capacity: number
  shape: TableShapeCode
  rotation: number
  positionX: number | null
  positionY: number | null
  /** id de un área existente o clientId de una nueva; null = sin acomodar. */
  areaRef: string | null
}

export interface DesiredElement {
  id?: string
  clientId?: string
  type: FloorElementTypeCode
  areaRef: string
  positionX: number
  positionY: number
  width?: number | null
  height?: number | null
  rotation: number
  endX?: number | null
  endY?: number | null
  label?: string | null
  color?: string | null
}

export interface PublishFloorPlanInput {
  saveId: string
  baseFingerprint: string
  areas: DesiredArea[]
  tables: DesiredTable[]
  elements: DesiredElement[]
}
