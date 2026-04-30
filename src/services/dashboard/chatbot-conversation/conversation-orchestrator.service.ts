import OpenAI from 'openai'
import { StaffRole } from '@prisma/client'
import { getUserAccess } from '@/services/access/access.service'
import { RelativeDateRange } from '@/utils/datetime'
import { SharedQueryService } from '../shared-query.service'
import { SecurityViolationType } from '../security-response.service'
import { TableAccessControlService, UserRole } from '../table-access-control.service'
import { ActionEngine } from '../chatbot-actions/action-engine.service'
import { ActionClassification, ActionContext, ActionResponse } from '../chatbot-actions/types'
import { ConversationPlannerService } from './conversation-planner.service'
import { ToolCatalogService } from './tool-catalog.service'
import { ConversationPlan, OrchestratorRequest, PlanStepMetadata, PlannerQueryStep, PlannerStep } from './types'

interface OrchestratorResponse {
  response: string
  queryResult?: unknown
  confidence: number
  metadata: {
    queryGenerated: boolean
    queryExecuted: boolean
    rowsReturned?: number
    dataSourcesUsed: string[]
    routedTo: 'ConversationOrchestrator'
    planId: string
    planMode: ConversationPlan['mode']
    steps: PlanStepMetadata[]
    riskLevel?: 'low' | 'medium' | 'high' | 'critical'
    reasonCode?: string
    blocked?: boolean
    violationType?: SecurityViolationType
    action?: Record<string, unknown>
  }
}

interface QueryExecutionResult {
  response: string
  result: unknown
  dataSource: string
  rowsReturned?: number
}

export class ConversationOrchestratorService {
  private readonly planner: ConversationPlannerService
  private readonly toolCatalog: ToolCatalogService

  constructor(
    openai: OpenAI,
    private readonly actionEngine: ActionEngine,
    toolCatalog = new ToolCatalogService(),
  ) {
    this.toolCatalog = toolCatalog
    this.planner = new ConversationPlannerService(openai, toolCatalog)
  }

  async process(request: OrchestratorRequest): Promise<OrchestratorResponse | null> {
    const plan = await this.planner.plan(request)

    if (this.shouldFallbackToLegacy(plan)) {
      return null
    }

    const planId = this.createPlanId()
    const metadataSteps: PlanStepMetadata[] = []
    const responseBlocks: string[] = []
    const queryResults: unknown[] = []
    const dataSources = new Set<string>()
    const executedStepIds = new Set<string>()
    let actionMetadata: Record<string, unknown> | undefined
    let queryExecuted = false
    let blocked = false
    let violationType: SecurityViolationType | undefined

    for (const step of plan.steps) {
      if (this.hasUnmetDependencies(step, executedStepIds)) {
        metadataSteps.push(this.stepMetadata(step, 'skipped'))
        continue
      }

      if (step.kind === 'unsupported') {
        blocked = blocked || plan.riskLevel === 'high'
        if (plan.riskLevel === 'high') {
          violationType = SecurityViolationType.PROMPT_INJECTION
        }
        responseBlocks.push(this.formatUnsupported(step.topic, step.reason))
        metadataSteps.push(this.stepMetadata(step, plan.riskLevel === 'high' ? 'blocked' : 'skipped'))
        continue
      }

      if (step.kind === 'clarify') {
        responseBlocks.push(step.question)
        metadataSteps.push(this.stepMetadata(step, 'needs_input'))
        return this.buildResponse({
          plan,
          planId,
          responseBlocks,
          queryResults,
          dataSources,
          metadataSteps,
          queryExecuted,
          actionMetadata,
          blocked,
          violationType,
          reasonCode: 'planner_clarification',
        })
      }

      if (step.kind === 'action') {
        const actionContext = await this.buildActionContext(request)
        const actionResult = await this.executeActionStep(step, request.message, actionContext)
        const actionStatus = this.toActionStepStatus(actionResult)
        responseBlocks.push(actionResult.message)
        actionMetadata = this.actionMetadata(actionResult)
        dataSources.add('chatbot.action_engine')
        metadataSteps.push(this.stepMetadata(step, actionStatus))

        const hasDependentSteps = plan.steps.some(candidate => this.getDependsOn(candidate).includes(step.id))
        if (hasDependentSteps && actionResult.type !== 'confirmed') {
          responseBlocks.push('Primero confirma este cambio. Después puedo decirte cómo quedó.')
          for (const dependent of plan.steps.filter(candidate => this.getDependsOn(candidate).includes(step.id))) {
            metadataSteps.push(this.stepMetadata(dependent, 'skipped'))
          }
          return this.buildResponse({
            plan,
            planId,
            responseBlocks,
            queryResults,
            dataSources,
            metadataSteps,
            queryExecuted,
            actionMetadata,
            blocked,
            violationType,
            reasonCode: `action_${actionResult.type}`,
          })
        }

        if (actionResult.type !== 'confirmed') {
          return this.buildResponse({
            plan,
            planId,
            responseBlocks,
            queryResults,
            dataSources,
            metadataSteps,
            queryExecuted,
            actionMetadata,
            blocked,
            violationType,
            reasonCode: `action_${actionResult.type}`,
          })
        }

        executedStepIds.add(step.id)
        queryExecuted = true
        continue
      }

      if (step.kind === 'query') {
        if (step.tool === 'adHocAnalytics') {
          metadataSteps.push(this.stepMetadata(step, 'skipped'))
          continue
        }

        const access = this.validateQueryAccess(step, request.userRole || UserRole.VIEWER)
        if (!access.allowed) {
          responseBlocks.push(access.message)
          metadataSteps.push(this.stepMetadata(step, 'blocked'))
          blocked = true
          violationType = access.violationType
          continue
        }

        const queryResult = await this.executeQueryStep(step, request.venueId)
        responseBlocks.push(queryResult.response)
        queryResults.push(queryResult.result)
        dataSources.add(queryResult.dataSource)
        metadataSteps.push(this.stepMetadata(step, 'executed'))
        executedStepIds.add(step.id)
        queryExecuted = true
      }
    }

    if (responseBlocks.length === 0) {
      return null
    }

    return this.buildResponse({
      plan,
      planId,
      responseBlocks,
      queryResults,
      dataSources,
      metadataSteps,
      queryExecuted,
      actionMetadata,
      blocked,
      violationType,
      reasonCode: blocked ? 'planner_blocked' : 'planner_executed',
    })
  }

  private shouldFallbackToLegacy(plan: ConversationPlan): boolean {
    if (plan.mode === 'unsupported') return false
    const executable = plan.steps.filter(step => step.kind !== 'unsupported')
    return executable.length === 1 && executable[0]?.kind === 'query' && executable[0].tool === 'adHocAnalytics'
  }

  private async buildActionContext(request: OrchestratorRequest): Promise<ActionContext> {
    const access = await getUserAccess(request.userId, request.venueId)
    return {
      venueId: request.venueId,
      userId: request.userId,
      role: access.role || request.fallbackStaffRole || StaffRole.VIEWER,
      permissions: access.corePermissions,
      permissionsAreEffective: true,
      ipAddress: request.ipAddress,
    }
  }

  private async executeActionStep(
    step: Extract<PlannerStep, { kind: 'action' }>,
    message: string,
    context: ActionContext,
  ): Promise<ActionResponse> {
    const continuedAction = await this.actionEngine.continueDisambiguation(message, context)
    if (continuedAction) {
      return continuedAction
    }

    if (step.actionType === 'auto.detect') {
      const detection = await this.actionEngine.detectAction(message, context)
      if (!detection.isAction || !detection.classification) {
        return { type: 'error', message: 'No pude identificar una acción segura para preparar.' }
      }
      return this.actionEngine.processAction(detection.classification, context)
    }

    const classification: ActionClassification = {
      actionType: step.actionType,
      params: step.args || {},
      entityName: typeof step.args?.entityName === 'string' ? step.args.entityName : undefined,
      confidence: 0.9,
    }
    return this.actionEngine.processAction(classification, context)
  }

  private validateQueryAccess(
    step: PlannerQueryStep,
    userRole: UserRole,
  ): { allowed: true } | { allowed: false; message: string; violationType: SecurityViolationType } {
    const tool = this.toolCatalog.getQueryTool(step.tool)
    if (!tool) {
      return {
        allowed: false,
        message: 'Esa consulta no está registrada como herramienta permitida.',
        violationType: SecurityViolationType.UNAUTHORIZED_TABLE,
      }
    }

    if (tool.tables.length === 0) {
      return { allowed: true }
    }

    const validation = TableAccessControlService.validateAccess(tool.tables, userRole)
    if (validation.allowed) {
      return { allowed: true }
    }

    return {
      allowed: false,
      message: TableAccessControlService.formatAccessDeniedMessage(validation, 'es'),
      violationType: validation.violationType || SecurityViolationType.UNAUTHORIZED_TABLE,
    }
  }

  private async executeQueryStep(step: PlannerQueryStep, venueId: string): Promise<QueryExecutionResult> {
    const dateRange = this.getDateRange(step)
    if (!venueId) {
      throw new Error('ConversationOrchestrator requires venueId')
    }

    switch (step.tool) {
      case 'sales': {
        const sales = await SharedQueryService.getSalesForPeriod(venueId, dateRange)
        return this.queryResult(step.tool, sales, this.formatSales(sales, dateRange))
      }
      case 'averageTicket': {
        const sales = await SharedQueryService.getSalesForPeriod(venueId, dateRange)
        return this.queryResult(
          step.tool,
          { averageTicket: sales.averageTicket, orderCount: sales.orderCount, currency: sales.currency },
          `El ticket promedio en ${this.formatDateRangeName(dateRange)} es de ${this.money(sales.averageTicket, sales.currency)}, basado en ${sales.orderCount} órdenes.`,
        )
      }
      case 'topProducts': {
        const products = await SharedQueryService.getTopProducts(venueId, dateRange, this.limit(step, 5))
        const list = products
          .map(
            (product, index) => `${index + 1}. ${product.productName} (${product.quantitySold} vendidos, ${this.money(product.revenue)})`,
          )
          .join('\n')
        return this.queryResult(
          step.tool,
          products,
          products.length > 0
            ? `Los productos más vendidos en ${this.formatDateRangeName(dateRange)} son:\n${list}`
            : `No encontré productos vendidos en ${this.formatDateRangeName(dateRange)}.`,
          products.length,
        )
      }
      case 'staffPerformance': {
        const staff = await SharedQueryService.getStaffPerformance(venueId, dateRange, this.limit(step, 5))
        const list = staff
          .map(
            (member, index) =>
              `${index + 1}. ${member.staffName}: ${member.totalOrders} órdenes, ${this.money(member.totalRevenue)} en ventas.`,
          )
          .join('\n')
        return this.queryResult(
          step.tool,
          staff,
          staff.length > 0
            ? `El desempeño de staff en ${this.formatDateRangeName(dateRange)}:\n${list}`
            : 'No encontré turnos o ventas de staff para ese periodo.',
          staff.length,
        )
      }
      case 'reviews': {
        const reviews = await SharedQueryService.getReviewStats(venueId, dateRange)
        return this.queryResult(
          step.tool,
          reviews,
          `En ${this.formatDateRangeName(dateRange)} tienes ${reviews.totalReviews} reseñas con promedio de ${reviews.averageRating.toFixed(1)} estrellas.`,
        )
      }
      case 'businessOverview': {
        const [sales, reviews, products] = await Promise.all([
          SharedQueryService.getSalesForPeriod(venueId, dateRange),
          SharedQueryService.getReviewStats(venueId, dateRange),
          SharedQueryService.getTopProducts(venueId, dateRange, 3),
        ])
        const topProduct = products[0]?.productName || 'sin producto líder'
        return this.queryResult(
          step.tool,
          { sales, reviews, topProducts: products },
          `Resumen de ${this.formatDateRangeName(dateRange)}: ${this.money(sales.totalRevenue, sales.currency)} en ventas, ${sales.orderCount} órdenes, ticket promedio de ${this.money(sales.averageTicket, sales.currency)}, ${reviews.totalReviews} reseñas y producto líder: ${topProduct}.`,
        )
      }
      case 'inventoryAlerts': {
        const alerts = await SharedQueryService.getInventoryAlerts(venueId)
        const list = alerts
          .slice(0, this.limit(step, 8))
          .map(
            (alert, index) =>
              `${index + 1}. ${alert.rawMaterialName}: ${alert.currentStock} ${alert.unit} (mínimo ${alert.minimumStock} ${alert.unit}).`,
          )
          .join('\n')
        return this.queryResult(
          step.tool,
          alerts,
          alerts.length > 0 ? `Tienes ${alerts.length} alertas de inventario:\n${list}` : 'No tienes alertas de bajo inventario activas.',
          alerts.length,
        )
      }
      case 'recipeCount': {
        const count = await SharedQueryService.getRecipeCount(venueId)
        return this.queryResult(step.tool, count, `Tienes ${count.totalRecipes} recetas activas en tu inventario.`)
      }
      case 'recipeList': {
        const recipes = await SharedQueryService.getRecipeList(venueId, this.limit(step, 20))
        const list = recipes.recipes.map((recipe, index) => `${index + 1}. ${recipe.productName}`).join('\n')
        const more = recipes.hasMore ? `\nHay ${recipes.totalRecipes - recipes.recipes.length} más.` : ''
        return this.queryResult(
          step.tool,
          recipes,
          recipes.recipes.length > 0
            ? `Tienes ${recipes.totalRecipes} recetas activas:\n${list}${more}`
            : 'No encontré recetas activas en tu inventario.',
          recipes.recipes.length,
        )
      }
      case 'recipeUsage': {
        const usage = await SharedQueryService.getRecipeUsage(venueId, this.limit(step, 5))
        const list = usage.topRecipes
          .map((recipe, index) => `${index + 1}. ${recipe.productName}: ${recipe.quantityUsed} vendidos en ${recipe.orderCount} órdenes.`)
          .join('\n')
        return this.queryResult(
          step.tool,
          usage,
          usage.topRecipes.length > 0
            ? `La receta que más se usa es ${usage.topRecipes[0].productName}. Ranking:\n${list}`
            : `Tienes ${usage.totalRecipes} recetas activas, pero no encontré ventas asociadas para calcular uso.`,
          usage.topRecipes.length,
        )
      }
      case 'pendingOrders': {
        const pending = await SharedQueryService.getPendingOrders(venueId)
        return this.queryResult(
          step.tool,
          pending,
          `Tienes ${pending.total} órdenes pendientes o abiertas: ${pending.byStatus.pending} pendientes, ${pending.byStatus.confirmed} confirmadas, ${pending.byStatus.preparing} en preparación y ${pending.byStatus.ready} listas.`,
        )
      }
      case 'activeShifts': {
        const shifts = await SharedQueryService.getActiveShifts(venueId)
        const list = shifts
          .slice(0, this.limit(step, 8))
          .map(
            (shift, index) => `${index + 1}. ${shift.staffName}: ${shift.durationMinutes} min, ${this.money(shift.salesTotal)} en ventas.`,
          )
          .join('\n')
        return this.queryResult(
          step.tool,
          shifts,
          shifts.length > 0 ? `Hay ${shifts.length} turnos activos:\n${list}` : 'No hay turnos activos en este momento.',
          shifts.length,
        )
      }
      case 'profitAnalysis': {
        const profit = await SharedQueryService.getProfitAnalysis(venueId, dateRange, this.limit(step, 5))
        return this.queryResult(
          step.tool,
          profit,
          `Rentabilidad de ${this.formatDateRangeName(dateRange)}: ingresos ${this.money(profit.totalRevenue, profit.currency)}, costos ${this.money(profit.totalCost, profit.currency)}, ganancia bruta ${this.money(profit.grossProfit, profit.currency)} y margen ${profit.grossMarginPercent.toFixed(1)}%.`,
        )
      }
      case 'paymentMethodBreakdown': {
        const breakdown = await SharedQueryService.getPaymentMethodBreakdown(venueId, dateRange)
        const list = breakdown.methods
          .map(method => `${method.method}: ${this.money(method.amount, breakdown.currency)} (${method.percentage.toFixed(1)}%)`)
          .join('\n')
        return this.queryResult(
          step.tool,
          breakdown,
          breakdown.methods.length > 0
            ? `Métodos de pago en ${this.formatDateRangeName(dateRange)}:\n${list}`
            : `No encontré pagos en ${this.formatDateRangeName(dateRange)}.`,
          breakdown.methods.length,
        )
      }
      default:
        throw new Error(`Unsupported query tool: ${step.tool}`)
    }
  }

  private queryResult(tool: string, result: unknown, response: string, rowsReturned?: number): QueryExecutionResult {
    return {
      response,
      result,
      dataSource: `shared_query.${tool}`,
      rowsReturned: rowsReturned ?? (Array.isArray(result) ? result.length : undefined),
    }
  }

  private getDateRange(step: PlannerQueryStep): RelativeDateRange {
    const raw = typeof step.args.dateRange === 'string' ? step.args.dateRange : undefined
    const allowed: RelativeDateRange[] = [
      'today',
      'yesterday',
      'last7days',
      'last30days',
      'thisWeek',
      'thisMonth',
      'lastWeek',
      'lastMonth',
      'allTime',
    ]
    if (raw && allowed.includes(raw as RelativeDateRange)) {
      return raw as RelativeDateRange
    }
    return this.toolCatalog.getQueryTool(step.tool)?.defaultDateRange || 'thisMonth'
  }

  private limit(step: PlannerQueryStep, fallback: number): number {
    const raw = Number(step.args.limit)
    if (!Number.isFinite(raw)) return fallback
    return Math.min(Math.max(Math.trunc(raw), 1), 25)
  }

  private formatSales(
    sales: { totalRevenue: number; orderCount: number; averageTicket: number; currency: string },
    dateRange: RelativeDateRange,
  ): string {
    return `En ${this.formatDateRangeName(dateRange)} vendiste ${this.money(sales.totalRevenue, sales.currency)} en total, con ${sales.orderCount} órdenes y ticket promedio de ${this.money(sales.averageTicket, sales.currency)}.`
  }

  private formatUnsupported(topic: string, reason: string): string {
    return `Sobre ${topic}: ${reason} Puedo ayudarte con datos y operaciones del venue actual.`
  }

  private formatDateRangeName(dateRange: RelativeDateRange): string {
    const names: Record<RelativeDateRange, string> = {
      today: 'hoy',
      yesterday: 'ayer',
      last7days: 'los últimos 7 días',
      last30days: 'los últimos 30 días',
      thisWeek: 'esta semana',
      thisMonth: 'este mes',
      lastWeek: 'la semana pasada',
      lastMonth: 'el mes pasado',
      allTime: 'todo el historial',
    }
    return names[dateRange] || dateRange
  }

  private money(value: number, currency = 'MXN'): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(value)
  }

  private toActionStepStatus(result: ActionResponse): PlanStepMetadata['status'] {
    if (result.type === 'preview' || result.type === 'double_confirm') return 'preview'
    if (result.type === 'requires_input' || result.type === 'disambiguate') return 'needs_input'
    if (result.type === 'permission_denied' || result.type === 'error') return 'blocked'
    if (result.type === 'confirmed') return 'executed'
    return 'skipped'
  }

  private actionMetadata(result: ActionResponse): Record<string, unknown> {
    return {
      type: result.type,
      actionId: result.actionId,
      preview: result.preview,
      missingFields: result.missingFields,
      formFields: result.formFields,
      candidates: result.candidates,
      entityId: result.entityId,
    }
  }

  private hasUnmetDependencies(step: PlannerStep, executedStepIds: Set<string>): boolean {
    return this.getDependsOn(step).some((dependency: string) => !executedStepIds.has(dependency))
  }

  private getDependsOn(step: PlannerStep): string[] {
    if (step.kind !== 'query' && step.kind !== 'action') return []
    return step.dependsOn || []
  }

  private stepMetadata(step: PlannerStep, status: PlanStepMetadata['status']): PlanStepMetadata {
    return {
      id: step.id,
      kind: step.kind,
      tool: step.kind === 'query' ? step.tool : undefined,
      actionType: step.kind === 'action' ? step.actionType : undefined,
      status,
    }
  }

  private buildResponse(params: {
    plan: ConversationPlan
    planId: string
    responseBlocks: string[]
    queryResults: unknown[]
    dataSources: Set<string>
    metadataSteps: PlanStepMetadata[]
    queryExecuted: boolean
    actionMetadata?: Record<string, unknown>
    blocked: boolean
    violationType?: SecurityViolationType
    reasonCode: string
  }): OrchestratorResponse {
    return {
      response: params.responseBlocks.join('\n\n'),
      queryResult: params.queryResults.length === 1 ? params.queryResults[0] : params.queryResults,
      confidence: params.plan.riskLevel === 'high' ? 0 : 0.92,
      metadata: {
        queryGenerated: false,
        queryExecuted: params.queryExecuted,
        dataSourcesUsed: Array.from(params.dataSources),
        routedTo: 'ConversationOrchestrator',
        planId: params.planId,
        planMode: params.plan.mode,
        steps: params.metadataSteps,
        riskLevel: params.plan.riskLevel === 'high' ? 'critical' : params.plan.riskLevel,
        reasonCode: params.reasonCode,
        blocked: params.blocked || undefined,
        violationType: params.violationType,
        action: params.actionMetadata,
      },
    }
  }

  private createPlanId(): string {
    return `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  }
}
