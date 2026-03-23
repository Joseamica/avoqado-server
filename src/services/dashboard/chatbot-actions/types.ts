import { StaffRole } from '@prisma/client'

// ---------------------------------------------------------------------------
// Field definitions
// ---------------------------------------------------------------------------

export interface FieldDefinition {
  type: 'string' | 'decimal' | 'integer' | 'boolean' | 'enum' | 'date' | 'reference'
  required: boolean
  prompt?: string
  options?: string[]
  default?: unknown
  min?: number
  max?: number
  transform?: 'uppercase' | 'lowercase' | 'trim'
  unique?: boolean
  referenceEntity?: string
}

export interface ListFieldDefinition {
  name: string
  itemFields: Record<string, FieldDefinition>
  minItems: number
  description: string
}

// ---------------------------------------------------------------------------
// Entity resolution
// ---------------------------------------------------------------------------

export interface EntityResolutionConfig {
  searchField: string
  scope: 'venueId'
  fuzzyMatch: boolean
  multipleMatchBehavior: 'ask' | 'first' | 'error'
  resolveVia?: {
    intermediateEntity: string
    intermediateField: string
    linkField: string
  }
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface PreviewTemplate {
  title: string
  summary: string
  showDiff?: boolean
  showImpact?: boolean
}

// ---------------------------------------------------------------------------
// Action definition
// ---------------------------------------------------------------------------

export interface ActionDefinition {
  actionType: string
  entity: string
  operation: 'create' | 'update' | 'delete' | 'custom'
  permission: string
  dangerLevel: 'low' | 'medium' | 'high' | 'blocked'
  service: string
  method: string
  serviceAdapter?: (params: Record<string, unknown>, context: ActionContext) => Promise<unknown>
  description: string
  examples: string[]
  fields: Record<string, FieldDefinition>
  listField?: ListFieldDefinition
  entityResolution?: EntityResolutionConfig
  previewTemplate: PreviewTemplate
}

// ---------------------------------------------------------------------------
// Context & classification
// ---------------------------------------------------------------------------

export interface ActionContext {
  venueId: string
  userId: string
  role: StaffRole
  permissions: string[] | null
  ipAddress?: string
}

export interface ActionClassification {
  actionType: string
  params: Record<string, unknown>
  entityName?: string
  confidence: number
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface DetectionResult {
  isAction: boolean
  domain?: string
  classification?: ActionClassification
}

// ---------------------------------------------------------------------------
// Entity resolution results
// ---------------------------------------------------------------------------

export interface EntityMatch {
  id: string
  name: string
  score: number
  data?: Record<string, unknown>
}

export interface EntityResolutionResult {
  matches: number
  candidates: EntityMatch[]
  exact: boolean
  resolved?: EntityMatch
}

// ---------------------------------------------------------------------------
// Action preview & session
// ---------------------------------------------------------------------------

export interface ActionPreview {
  actionId: string
  actionType: string
  dangerLevel: 'low' | 'medium' | 'high' | 'blocked'
  summary: string
  diff?: Record<string, unknown>
  impact?: {
    affectedRecipes?: number
    stockValue?: number
    details?: string
  }
  canConfirm: boolean
  expiresAt: Date
}

export interface PendingActionSession {
  actionId: string
  definition: ActionDefinition
  params: Record<string, unknown>
  targetEntity?: EntityMatch
  context: ActionContext
  preview: ActionPreview
  createdAt: Date
  expiresAt: Date
}

// ---------------------------------------------------------------------------
// Action response
// ---------------------------------------------------------------------------

export type ActionResponseType =
  | 'preview'
  | 'confirmed'
  | 'requires_input'
  | 'disambiguate'
  | 'not_found'
  | 'permission_denied'
  | 'expired'
  | 'error'
  | 'double_confirm'

export interface ActionResponse {
  type: ActionResponseType
  message: string
  preview?: ActionPreview
  missingFields?: string[]
  candidates?: EntityMatch[]
  entityId?: string
  actionId?: string
}

// ---------------------------------------------------------------------------
// Security constants
// ---------------------------------------------------------------------------

export const FORBIDDEN_LLM_PARAMS = ['venueId', 'orgId', 'userId', 'id', 'createdAt', 'updatedAt', 'deletedAt'] as const
