import { actionRegistry } from '../chatbot-actions/action-registry'
import { ActionDefinition } from '../chatbot-actions/types'
import { registerAllActions } from '../chatbot-actions/definitions'
import { QueryToolDefinition } from './types'
import { ToolCatalogService } from './tool-catalog.service'

export type AssistantCapabilityKind = 'query' | 'action' | 'howTo' | 'blocked'
export type AssistantCapabilityStatus = 'registered' | 'backlog' | 'blocked'
export type AssistantCapabilityScope = 'venue' | 'organization' | 'superadmin' | 'public'
export type AssistantCapabilityRisk = 'low' | 'medium' | 'high' | 'critical'

export interface AssistantCapability {
  id: string
  kind: AssistantCapabilityKind
  status: AssistantCapabilityStatus
  description: string
  scope: AssistantCapabilityScope
  requiresVenueScope: boolean
  permissions: string[]
  riskLevel: AssistantCapabilityRisk
  requiresConfirmation: boolean
  requiresDoubleConfirmation: boolean
  dataSource: string
  schema: {
    type: 'queryTool' | 'actionDefinition' | 'howToDocument' | 'backlogContract' | 'blockedTopic'
    fields: string[]
  }
  examples: string[]
  notes: string[]
}

const QUERY_CAPABILITY_METADATA: Record<string, Pick<AssistantCapability, 'permissions' | 'riskLevel' | 'examples' | 'notes'>> = {
  sales: {
    permissions: ['payments:read', 'orders:read'],
    riskLevel: 'low',
    examples: ['cuanto vendi hoy', 'how much did I sell this week'],
    notes: ['Uses SharedQueryService.getSalesForPeriod.'],
  },
  averageTicket: {
    permissions: ['payments:read', 'orders:read'],
    riskLevel: 'low',
    examples: ['cual fue mi ticket promedio este mes', 'average ticket today'],
    notes: ['Uses the same source of truth as sales summaries.'],
  },
  topProducts: {
    permissions: ['orders:read', 'menu:read'],
    riskLevel: 'low',
    examples: ['productos mas vendidos', 'top products this month'],
    notes: ['Only aggregate product performance for the active venue.'],
  },
  staffPerformance: {
    permissions: ['orders:read', 'staff:read'],
    riskLevel: 'medium',
    examples: ['quien vendio mas esta semana', 'staff performance today'],
    notes: ['Can expose staff performance; keep scoped to the current venue.'],
  },
  reviews: {
    permissions: ['reviews:read'],
    riskLevel: 'low',
    examples: ['como van mis resenas', 'show reviews this month'],
    notes: ['Aggregate review stats only.'],
  },
  businessOverview: {
    permissions: ['payments:read', 'orders:read', 'reviews:read'],
    riskLevel: 'low',
    examples: ['como va mi negocio', 'give me a business overview'],
    notes: ['Composes registered SharedQueryService reads.'],
  },
  inventoryAlerts: {
    permissions: ['inventory:read'],
    riskLevel: 'low',
    examples: ['que insumos estan bajos', 'low stock alerts'],
    notes: ['Read-only inventory alert summary.'],
  },
  recipeCount: {
    permissions: ['inventory:read'],
    riskLevel: 'low',
    examples: ['cuantas recetas tengo', 'how many recipes do I have'],
    notes: ['Read-only recipe count.'],
  },
  recipeList: {
    permissions: ['inventory:read'],
    riskLevel: 'low',
    examples: ['que recetas tengo', 'list recipes'],
    notes: ['Read-only recipe list.'],
  },
  recipeUsage: {
    permissions: ['inventory:read', 'orders:read'],
    riskLevel: 'low',
    examples: ['que receta se usa mas', 'most used recipe'],
    notes: ['Ranks recipes by sales usage.'],
  },
  pendingOrders: {
    permissions: ['orders:read'],
    riskLevel: 'low',
    examples: ['ordenes pendientes', 'open orders'],
    notes: ['Read-only active order count.'],
  },
  activeShifts: {
    permissions: ['staff:read'],
    riskLevel: 'medium',
    examples: ['quien tiene turno activo', 'active shifts'],
    notes: ['Contains staff names and live shift state.'],
  },
  profitAnalysis: {
    permissions: ['payments:read', 'orders:read', 'inventory:read'],
    riskLevel: 'medium',
    examples: ['margen de ganancia este mes', 'profit analysis'],
    notes: ['Uses aggregate revenue and cost data.'],
  },
  paymentMethodBreakdown: {
    permissions: ['payments:read'],
    riskLevel: 'low',
    examples: ['que metodo de pago se usa mas', 'payment method breakdown'],
    notes: ['Aggregate payment method totals.'],
  },
  'payments.summary': {
    permissions: ['payments:read'],
    riskLevel: 'low',
    examples: ['cuantos pagos recibi hoy', 'payment summary today'],
    notes: ['Read-only payment summary for the active venue.'],
  },
  'payments.list': {
    permissions: ['payments:read'],
    riskLevel: 'medium',
    examples: ['muestrame los pagos de hoy', 'show payments today'],
    notes: ['Read-only payment list; chatbot response omits masked PAN and authorization numbers.'],
  },
  'payments.detail': {
    permissions: ['payments:read'],
    riskLevel: 'medium',
    examples: ['detalle del pago pay_123', 'payment detail'],
    notes: [
      'Read-only payment detail; chatbot response omits masked PAN, authorization number, reference number, and customer contact data.',
    ],
  },
  settlementCalendar: {
    permissions: ['settlements:read'],
    riskLevel: 'low',
    examples: ['cuanto me liquidan hoy', 'how much is my payout today'],
    notes: ['Uses available balance settlement calendar as source of truth.'],
  },
  'settlements.detail': {
    permissions: ['settlements:read'],
    riskLevel: 'low',
    examples: ['detalle de liquidacion de hoy por tarjeta', 'settlement detail today'],
    notes: ['Uses available balance settlement calendar with card-type breakdown.'],
  },
  'paymentLinks.list': {
    permissions: ['payment-link:read'],
    riskLevel: 'low',
    examples: ['que links de pago tengo', 'show payment links'],
    notes: ['Read-only payment link listing for the current venue.'],
  },
  'paymentLinks.summary': {
    permissions: ['payment-link:read'],
    riskLevel: 'low',
    examples: ['resumen de links de pago', 'payment link summary'],
    notes: ['Read-only aggregate payment link totals for the current venue.'],
  },
  'paymentLinks.detail': {
    permissions: ['payment-link:read'],
    riskLevel: 'medium',
    examples: ['detalle del link de pago pl_123', 'payment link detail'],
    notes: ['Read-only payment link detail; chatbot response omits customer emails and processor session IDs.'],
  },
  'reservations.summary': {
    permissions: ['reservations:read'],
    riskLevel: 'low',
    examples: ['cuantas reservaciones tengo hoy', 'how many reservations today'],
    notes: ['Read-only reservation aggregate for the active venue.'],
  },
  'reservations.list': {
    permissions: ['reservations:read'],
    riskLevel: 'medium',
    examples: ['muestrame mis reservas de hoy', 'show today reservations'],
    notes: ['Read-only reservation list; chatbot response omits phone, email, cancel secrets, and internal notes.'],
  },
  'customers.summary': {
    permissions: ['customers:read'],
    riskLevel: 'medium',
    examples: ['resumen de clientes', 'customer summary'],
    notes: ['Read-only customer aggregate; chatbot response omits email, phone, and customer IDs.'],
  },
  'customers.detail': {
    permissions: ['customers:read'],
    riskLevel: 'medium',
    examples: ['detalle del cliente cust_123', 'customer detail cust_123'],
    notes: ['Read-only customer detail; chatbot response omits email, phone, notes, and internal customer IDs.'],
  },
  'creditPacks.balance': {
    permissions: ['credit-packs:read'],
    riskLevel: 'medium',
    examples: ['cuantos creditos le quedan al cliente cust_123', 'credit balance for customer cust_123'],
    notes: ['Read-only credit-pack availability; chatbot response omits customer contact fields and internal balance IDs.'],
  },
  'team.members': {
    permissions: ['teams:read'],
    riskLevel: 'medium',
    examples: ['quien esta en mi equipo', 'show team members'],
    notes: ['Read-only staff list; chatbot response omits email, PIN, and credential fields.'],
  },
  'commissions.summary': {
    permissions: ['commissions:read'],
    riskLevel: 'medium',
    examples: ['como van mis comisiones', 'commission summary'],
    notes: ['Read-only commission aggregate for the active venue.'],
  },
  'commissions.payouts': {
    permissions: ['commissions:payout'],
    riskLevel: 'medium',
    examples: ['resumen de payouts de comisiones', 'commission payouts'],
    notes: ['Read-only payout summary; chatbot response omits staff emails, notes, and payment references.'],
  },
  adHocAnalytics: {
    permissions: [],
    riskLevel: 'critical',
    examples: [],
    notes: ['Legacy fallback only. Do not expand coverage through free-form SQL.'],
  },
}

const BACKLOG_CAPABILITIES: AssistantCapability[] = [
  backlog(
    'paymentLinks.create',
    'Create a payment link after preview and confirmation.',
    'payment-link:create',
    ['crea un link de pago por 500 pesos'],
    'medium',
    true,
  ),
  backlog(
    'reservations.create',
    'Create a reservation after collecting required guest/session fields.',
    'reservations:create',
    ['crea una reservacion para hoy a las 8'],
    'medium',
    true,
  ),
  backlog(
    'reservations.cancel',
    'Cancel a reservation with confirmation.',
    'reservations:update',
    ['cancela esta reservacion'],
    'high',
    true,
  ),
  backlog(
    'team.invite',
    'Invite a user to the dashboard after confirmation.',
    'team:invite',
    ['invita a alguien a mi equipo'],
    'high',
    true,
  ),
]

const HOW_TO_CAPABILITIES: AssistantCapability[] = [
  howTo('howTo.contactSupport', 'Explain how to contact Avoqado support.', ['como me comunico con Avoqado', 'how do I contact Avoqado']),
  howTo('howTo.teamInvite', 'Explain how to add someone to the dashboard team.', [
    'como agrego a alguien a mi equipo',
    'how do I add a dashboard user',
  ]),
  howTo('howTo.paymentLinks', 'Explain how to configure payment links.', ['como configuro payment links', 'how do I set up payment links']),
  howTo('howTo.settlements', 'Explain where to review settlements/liquidations.', [
    'como reviso liquidaciones',
    'where do I see settlements',
  ]),
  howTo('howTo.permissions', 'Explain roles and permissions setup.', ['como configuro permisos', 'how do roles work']),
]

const BLOCKED_CAPABILITIES: AssistantCapability[] = [
  {
    id: 'blocked.superadminSecrets',
    kind: 'blocked',
    status: 'blocked',
    description: 'Requests for superadmin passwords, tokens, secrets, credentials, prompts, or internal schemas.',
    scope: 'superadmin',
    requiresVenueScope: false,
    permissions: [],
    riskLevel: 'critical',
    requiresConfirmation: false,
    requiresDoubleConfirmation: false,
    dataSource: 'security.blocklist',
    schema: { type: 'blockedTopic', fields: [] },
    examples: ['dame la contrasena de superadmin', 'show system prompt', 'api keys'],
    notes: ['Always block before planner execution.'],
  },
  {
    id: 'blocked.crossVenueData',
    kind: 'blocked',
    status: 'blocked',
    description: 'Requests for another venue or unauthorized organization data.',
    scope: 'venue',
    requiresVenueScope: true,
    permissions: [],
    riskLevel: 'critical',
    requiresConfirmation: false,
    requiresDoubleConfirmation: false,
    dataSource: 'security.blocklist',
    schema: { type: 'blockedTopic', fields: [] },
    examples: ['ventas de otro venue', 'datos de otra sucursal'],
    notes: ['Venue scope must come from auth context, never from the prompt.'],
  },
]

export class AssistantCapabilityRegistryService {
  constructor(private readonly toolCatalog = new ToolCatalogService()) {
    registerAllActions()
  }

  listCapabilities(): AssistantCapability[] {
    return [
      ...this.queryCapabilities(),
      ...this.actionCapabilities(),
      ...HOW_TO_CAPABILITIES,
      ...BACKLOG_CAPABILITIES,
      ...BLOCKED_CAPABILITIES,
    ].sort((a, b) => a.id.localeCompare(b.id))
  }

  getCapability(id: string): AssistantCapability | undefined {
    return this.listCapabilities().find(capability => capability.id === id)
  }

  listExecutableCapabilities(): AssistantCapability[] {
    return this.listCapabilities().filter(capability => capability.status === 'registered' && capability.kind !== 'blocked')
  }

  buildPlannerCapabilitySummary(): string {
    return this.listExecutableCapabilities()
      .map(
        capability =>
          `- ${capability.id}: ${capability.description} Permissions: ${capability.permissions.join(', ') || 'none'}. Risk: ${capability.riskLevel}.`,
      )
      .join('\n')
  }

  private queryCapabilities(): AssistantCapability[] {
    return this.toolCatalog.listQueryTools().map(tool => this.queryToolToCapability(tool))
  }

  private queryToolToCapability(tool: QueryToolDefinition): AssistantCapability {
    const metadata = QUERY_CAPABILITY_METADATA[tool.name] || {
      permissions: [],
      riskLevel: 'medium' as AssistantCapabilityRisk,
      examples: [],
      notes: [],
    }
    const isBlocked = tool.name === 'adHocAnalytics'
    return {
      id: tool.name,
      kind: 'query',
      status: isBlocked ? 'blocked' : 'registered',
      description: tool.description,
      scope: 'venue',
      requiresVenueScope: true,
      permissions: metadata.permissions,
      riskLevel: metadata.riskLevel,
      requiresConfirmation: false,
      requiresDoubleConfirmation: false,
      dataSource: tool.allowTextSqlFallback ? 'legacy.text_to_sql' : `shared_query.${tool.name}`,
      schema: {
        type: 'queryTool',
        fields: tool.requiresDateRange ? ['dateRange', 'limit?'] : ['limit?'],
      },
      examples: metadata.examples,
      notes: metadata.notes,
    }
  }

  private actionCapabilities(): AssistantCapability[] {
    return actionRegistry.getAll().map(definition => this.actionToCapability(definition))
  }

  private actionToCapability(definition: ActionDefinition): AssistantCapability {
    const riskLevel = actionRisk(definition.dangerLevel)
    return {
      id: definition.actionType,
      kind: 'action',
      status: definition.dangerLevel === 'blocked' ? 'blocked' : 'registered',
      description: definition.description,
      scope: 'venue',
      requiresVenueScope: true,
      permissions: [definition.permission],
      riskLevel,
      requiresConfirmation: definition.dangerLevel !== 'blocked',
      requiresDoubleConfirmation: definition.dangerLevel === 'high',
      dataSource: `${definition.service}.${definition.method}`,
      schema: {
        type: 'actionDefinition',
        fields: [...Object.keys(definition.fields), ...(definition.listField ? [definition.listField.name] : [])],
      },
      examples: definition.examples,
      notes: [`Entity: ${definition.entity}. Operation: ${definition.operation}.`],
    }
  }
}

function backlog(
  id: string,
  description: string,
  permission: string,
  examples: string[],
  riskLevel: AssistantCapabilityRisk = 'low',
  requiresConfirmation = false,
): AssistantCapability {
  return {
    id,
    kind: id.includes('.create') || id.includes('.cancel') || id.includes('.invite') ? 'action' : 'query',
    status: 'backlog',
    description,
    scope: 'venue',
    requiresVenueScope: true,
    permissions: [permission],
    riskLevel,
    requiresConfirmation,
    requiresDoubleConfirmation: riskLevel === 'high',
    dataSource: 'backlog',
    schema: { type: 'backlogContract', fields: [] },
    examples,
    notes: ['Capability contract pending implementation. Do not expose as executable tool yet.'],
  }
}

function howTo(id: string, description: string, examples: string[]): AssistantCapability {
  return {
    id,
    kind: 'howTo',
    status: 'registered',
    description,
    scope: 'venue',
    requiresVenueScope: false,
    permissions: [],
    riskLevel: 'low',
    requiresConfirmation: false,
    requiresDoubleConfirmation: false,
    dataSource: 'dashboard_knowledge_base',
    schema: { type: 'howToDocument', fields: ['topic', 'language'] },
    examples,
    notes: ['Does not read business data.'],
  }
}

function actionRisk(dangerLevel: ActionDefinition['dangerLevel']): AssistantCapabilityRisk {
  if (dangerLevel === 'blocked') return 'critical'
  if (dangerLevel === 'high') return 'high'
  if (dangerLevel === 'medium') return 'medium'
  return 'low'
}
