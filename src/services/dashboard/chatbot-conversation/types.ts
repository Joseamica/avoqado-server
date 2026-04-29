import { StaffRole } from '@prisma/client'
import { RelativeDateRange } from '@/utils/datetime'
import { UserRole } from '../table-access-control.service'

export type PlannerStepKind = 'query' | 'action' | 'clarify' | 'unsupported'

export interface PlannerQueryStep {
  id: string
  kind: 'query'
  tool: string
  args: Record<string, unknown>
  dependsOn?: string[]
}

export interface PlannerActionStep {
  id: string
  kind: 'action'
  actionType: string
  args: Record<string, unknown>
  dependsOn?: string[]
}

export interface PlannerClarifyStep {
  id: string
  kind: 'clarify'
  question: string
  missing: string[]
}

export interface PlannerUnsupportedStep {
  id: string
  kind: 'unsupported'
  topic: string
  reason: string
}

export type PlannerStep = PlannerQueryStep | PlannerActionStep | PlannerClarifyStep | PlannerUnsupportedStep

export interface ConversationPlan {
  mode: 'single' | 'multi_step' | 'clarification' | 'unsupported'
  steps: PlannerStep[]
  userFacingSummary: string
  riskLevel: 'low' | 'medium' | 'high'
}

export interface AssistantConversationState {
  lastEntities: Array<{ type: string; id?: string; name: string; sourceStepId: string }>
  lastIntent?: string
  lastTool?: string
  pendingActionId?: string
  pendingDisambiguation?: boolean
}

export interface ConversationEntry {
  role: 'user' | 'assistant'
  content: string
  timestamp?: Date
}

export interface PlannerRequest {
  message: string
  venueId: string
  userId: string
  conversationHistory?: ConversationEntry[]
}

export interface OrchestratorRequest extends PlannerRequest {
  userRole?: UserRole
  fallbackStaffRole?: StaffRole
  ipAddress?: string
  includeVisualization?: boolean
}

export interface PlanStepMetadata {
  id: string
  kind: PlannerStepKind
  tool?: string
  actionType?: string
  status: 'executed' | 'preview' | 'blocked' | 'skipped' | 'needs_input'
}

export interface ConversationMetadata {
  routedTo: 'ConversationOrchestrator'
  planId: string
  planMode: ConversationPlan['mode']
  steps: PlanStepMetadata[]
}

export type QueryToolName =
  | 'sales'
  | 'averageTicket'
  | 'topProducts'
  | 'staffPerformance'
  | 'reviews'
  | 'businessOverview'
  | 'inventoryAlerts'
  | 'recipeCount'
  | 'recipeList'
  | 'recipeUsage'
  | 'pendingOrders'
  | 'activeShifts'
  | 'profitAnalysis'
  | 'paymentMethodBreakdown'
  | 'adHocAnalytics'

export interface QueryToolDefinition {
  name: QueryToolName
  description: string
  tables: string[]
  requiresDateRange: boolean
  defaultDateRange?: RelativeDateRange
  allowTextSqlFallback?: boolean
}
