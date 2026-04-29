import { actionRegistry } from '../chatbot-actions/action-registry'
import { registerAllActions } from '../chatbot-actions/definitions'
import { QueryToolDefinition, QueryToolName } from './types'

export class ToolCatalogService {
  private readonly queryTools: Map<QueryToolName, QueryToolDefinition>

  constructor() {
    registerAllActions()
    const queryTools: QueryToolDefinition[] = [
      {
        name: 'sales',
        description: 'Sales revenue, order count, and average ticket for a period.',
        tables: ['Payment', 'Order'],
        requiresDateRange: true,
        defaultDateRange: 'thisMonth',
      },
      {
        name: 'averageTicket',
        description: 'Average ticket for a period.',
        tables: ['Payment', 'Order'],
        requiresDateRange: true,
        defaultDateRange: 'thisMonth',
      },
      {
        name: 'topProducts',
        description: 'Best-selling products for a period.',
        tables: ['OrderItem', 'Order', 'Product', 'MenuCategory'],
        requiresDateRange: true,
        defaultDateRange: 'thisMonth',
      },
      {
        name: 'staffPerformance',
        description: 'Staff performance and tips for a period.',
        tables: ['Staff', 'StaffVenue', 'Order', 'Payment', 'Shift'],
        requiresDateRange: true,
        defaultDateRange: 'thisMonth',
      },
      {
        name: 'reviews',
        description: 'Review count, rating, and distribution for a period.',
        tables: ['Review'],
        requiresDateRange: true,
        defaultDateRange: 'thisMonth',
      },
      {
        name: 'businessOverview',
        description: 'High-level business summary for a period.',
        tables: ['Payment', 'Order', 'OrderItem', 'Product', 'MenuCategory', 'Review'],
        requiresDateRange: true,
        defaultDateRange: 'thisMonth',
      },
      {
        name: 'inventoryAlerts',
        description: 'Low stock inventory alerts.',
        tables: ['RawMaterial'],
        requiresDateRange: false,
      },
      {
        name: 'recipeCount',
        description: 'Count active recipes in the current venue.',
        tables: ['Recipe', 'Product'],
        requiresDateRange: false,
      },
      {
        name: 'recipeList',
        description: 'List active recipes in the current venue.',
        tables: ['Recipe', 'Product'],
        requiresDateRange: false,
      },
      {
        name: 'recipeUsage',
        description: 'Rank recipes by product sales usage.',
        tables: ['Recipe', 'Product', 'OrderItem', 'Order'],
        requiresDateRange: false,
      },
      {
        name: 'pendingOrders',
        description: 'Pending/open order counts by status.',
        tables: ['Order'],
        requiresDateRange: false,
      },
      {
        name: 'activeShifts',
        description: 'Active staff shifts and current sales.',
        tables: ['Shift', 'Staff', 'Order'],
        requiresDateRange: false,
      },
      {
        name: 'profitAnalysis',
        description: 'Gross profit and margin for a period.',
        tables: ['Payment', 'OrderItem', 'Order', 'Product', 'Recipe'],
        requiresDateRange: true,
        defaultDateRange: 'thisMonth',
      },
      {
        name: 'paymentMethodBreakdown',
        description: 'Payment method totals and percentages for a period.',
        tables: ['Payment'],
        requiresDateRange: true,
        defaultDateRange: 'thisMonth',
      },
      {
        name: 'adHocAnalytics',
        description: 'Fallback for analytics questions not covered by known tools.',
        tables: [],
        requiresDateRange: false,
        allowTextSqlFallback: true,
      },
    ]
    this.queryTools = new Map<QueryToolName, QueryToolDefinition>(queryTools.map(tool => [tool.name, tool]))
  }

  getQueryTool(name: string): QueryToolDefinition | undefined {
    return this.queryTools.get(name as QueryToolName)
  }

  listQueryTools(): QueryToolDefinition[] {
    return Array.from(this.queryTools.values())
  }

  isQueryToolAllowed(name: string): boolean {
    return this.queryTools.has(name as QueryToolName)
  }

  isActionAllowed(actionType: string): boolean {
    return actionType === 'auto.detect' || Boolean(actionRegistry.get(actionType))
  }

  listActionTypes(): string[] {
    return [
      'auto.detect',
      ...actionRegistry
        .getAll()
        .map(action => action.actionType)
        .sort(),
    ]
  }

  buildPlannerCatalogSummary(): string {
    const queryTools = this.listQueryTools()
      .map(tool => `- ${tool.name}: ${tool.description}`)
      .join('\n')
    const actionTools = this.listActionTypes()
      .map(actionType => `- ${actionType}`)
      .join('\n')

    return `QUERY TOOLS:\n${queryTools}\n\nACTION TOOLS:\n${actionTools}`
  }
}
