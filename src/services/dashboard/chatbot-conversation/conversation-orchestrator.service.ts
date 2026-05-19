import OpenAI from 'openai'
import { StaffRole } from '@prisma/client'
import { getUserAccess } from '@/services/access/access.service'
import { evaluatePermissionList } from '@/lib/permissions'
import { DEFAULT_TIMEZONE, type RelativeDateRange } from '@/utils/datetime'
import { SharedQueryService, type DateRangeSpec } from '../shared-query.service'
import { SecurityResponseService, SecurityViolationType } from '../security-response.service'
import { TableAccessControlService, UserRole } from '../table-access-control.service'
import { ActionEngine } from '../chatbot-actions/action-engine.service'
import { ActionClassification, ActionContext, ActionResponse } from '../chatbot-actions/types'
import { ConversationPlannerService } from './conversation-planner.service'
import { ToolCatalogService } from './tool-catalog.service'
import { AssistantCapabilityRegistryService } from './assistant-capability-registry.service'
import { ConversationPlan, OrchestratorRequest, PlanStepMetadata, PlannerQueryStep, PlannerStep } from './types'
import { isCustomDateRangeSpec } from './date-range-parser'

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
    intent?: string
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

interface ConversationOrchestratorOptions {
  plannerModelFallbackEnabled?: boolean
}

type ResponseLanguage = 'es' | 'en'

export class ConversationOrchestratorService {
  private readonly planner: ConversationPlannerService
  private readonly toolCatalog: ToolCatalogService
  private readonly capabilityRegistry: AssistantCapabilityRegistryService

  constructor(
    openai: OpenAI,
    private readonly actionEngine: ActionEngine,
    toolCatalog = new ToolCatalogService(),
    options: ConversationOrchestratorOptions = {},
  ) {
    this.toolCatalog = toolCatalog
    this.capabilityRegistry = new AssistantCapabilityRegistryService(toolCatalog)
    this.planner = new ConversationPlannerService(openai, toolCatalog, {
      enableModelFallback: options.plannerModelFallbackEnabled,
    })
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
    const responseLanguage = this.detectResponseLanguage(request.message)
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
          violationType = this.violationTypeForUnsupported(step.topic, step.reason)
          responseBlocks.push(SecurityResponseService.generateSecurityResponse(violationType, responseLanguage).message)
        } else {
          responseBlocks.push(this.formatUnsupported(step.topic, step.reason, responseLanguage))
        }
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

        const access = await this.validateQueryAccess(step, request)
        if (!access.allowed) {
          responseBlocks.push(access.message)
          metadataSteps.push(this.stepMetadata(step, 'blocked'))
          blocked = true
          violationType = access.violationType
          continue
        }

        const queryResult = await this.executeQueryStep(step, request.venueId, responseLanguage)
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
    if (plan.mode === 'unsupported') return plan.riskLevel !== 'high'
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

  private async validateQueryAccess(
    step: PlannerQueryStep,
    request: OrchestratorRequest,
  ): Promise<{ allowed: true } | { allowed: false; message: string; violationType: SecurityViolationType }> {
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

    const capability = this.capabilityRegistry.getCapability(step.tool)
    if (capability?.status === 'blocked') {
      return {
        allowed: false,
        message: 'Esa consulta no está habilitada como herramienta segura.',
        violationType: SecurityViolationType.UNAUTHORIZED_TABLE,
      }
    }

    if (capability?.permissions.length) {
      const permissionAccess = await getUserAccess(request.userId, request.venueId)
      const hasRequiredPermission =
        request.userRole === UserRole.SUPERADMIN ||
        capability.permissions.every(permission => evaluatePermissionList(permissionAccess.corePermissions, permission))
      if (!hasRequiredPermission) {
        return {
          allowed: false,
          message: 'No tienes permisos suficientes para consultar esa información.',
          violationType: SecurityViolationType.UNAUTHORIZED_TABLE,
        }
      }
    }

    const userRole = request.userRole || UserRole.VIEWER
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

  private async executeQueryStep(step: PlannerQueryStep, venueId: string, language: ResponseLanguage): Promise<QueryExecutionResult> {
    const dateRange = this.getDateRange(step)
    if (!venueId) {
      throw new Error('ConversationOrchestrator requires venueId')
    }

    switch (step.tool) {
      case 'sales': {
        const sales = await SharedQueryService.getSalesForPeriod(venueId, dateRange)
        return this.queryResult(step.tool, sales, this.formatSales(sales, dateRange, language))
      }
      case 'averageTicket': {
        const sales = await SharedQueryService.getSalesForPeriod(venueId, dateRange)
        return this.queryResult(
          step.tool,
          { averageTicket: sales.averageTicket, orderCount: sales.orderCount, currency: sales.currency },
          language === 'en'
            ? `The average ticket in ${this.formatDateRangeName(dateRange, language)} is ${this.money(sales.averageTicket, sales.currency, language)}, based on ${sales.orderCount} orders.`
            : `El ticket promedio en ${this.formatDateRangeName(dateRange)} es de ${this.money(sales.averageTicket, sales.currency)}, basado en ${sales.orderCount} órdenes.`,
        )
      }
      case 'topProducts': {
        const products = await SharedQueryService.getTopProducts(venueId, dateRange, this.limit(step, 5))
        const list = products
          .map((product, index) =>
            language === 'en'
              ? `${index + 1}. ${product.productName} (${product.quantitySold} sold, ${this.money(product.revenue, 'MXN', language)})`
              : `${index + 1}. ${product.productName} (${product.quantitySold} vendidos, ${this.money(product.revenue)})`,
          )
          .join('\n')
        return this.queryResult(
          step.tool,
          products,
          products.length > 0
            ? language === 'en'
              ? `The top-selling products ${this.formatDateRangeAdverbial(dateRange, language)} are:\n${list}`
              : `Los productos más vendidos ${this.formatDateRangeAdverbial(dateRange)} son:\n${list}`
            : language === 'en'
              ? `I did not find product sales ${this.formatDateRangeAdverbial(dateRange, language)}.`
              : `No encontré productos vendidos ${this.formatDateRangeAdverbial(dateRange)}.`,
          products.length,
        )
      }
      case 'productSales': {
        const productName = this.requiredStringArg(step, 'productName')
        const productSales = await SharedQueryService.getProductSalesByName(venueId, productName, dateRange)
        const matchedName = productSales.productName || productSales.searchTerm || productName
        return this.queryResult(
          step.tool,
          productSales,
          productSales.quantitySold > 0
            ? language === 'en'
              ? `${this.formatDateRangeSentencePrefix(dateRange, language)}, ${matchedName} sold ${productSales.quantitySold} units for ${this.money(productSales.revenue, productSales.currency, language)} across ${productSales.orderCount} orders.`
              : `${this.formatDateRangeSentencePrefix(dateRange)}, ${matchedName} vendió ${productSales.quantitySold} unidades por ${this.money(productSales.revenue, productSales.currency)} en ${productSales.orderCount} órdenes.`
            : language === 'en'
              ? `I did not find sales for "${matchedName}" ${this.formatDateRangeAdverbial(dateRange, language)}.`
              : `No encontré ventas de "${matchedName}" ${this.formatDateRangeAdverbial(dateRange)}.`,
          productSales.matchedProducts.length,
        )
      }
      case 'productSales.compare': {
        const leftTerm = this.requiredStringArg(step, 'leftTerm')
        const rightTerm = this.requiredStringArg(step, 'rightTerm')
        const comparison = await SharedQueryService.compareProductSales(venueId, {
          leftTerm,
          rightTerm,
          period: dateRange,
          weekendOnly: step.args.weekendOnly === true,
          nightOnly: step.args.nightOnly === true,
        })
        return this.queryResult(
          step.tool,
          comparison,
          this.formatProductSalesComparison(comparison, dateRange, language),
          comparison.left.products.length + comparison.right.products.length,
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
          language === 'en'
            ? `In ${this.formatDateRangeName(dateRange, language)}, you have ${reviews.totalReviews} reviews with an average rating of ${reviews.averageRating.toFixed(1)} stars.`
            : `En ${this.formatDateRangeName(dateRange)} tienes ${reviews.totalReviews} reseñas con promedio de ${reviews.averageRating.toFixed(1)} estrellas.`,
        )
      }
      case 'businessOverview': {
        const [sales, reviews, products] = await Promise.all([
          SharedQueryService.getSalesForPeriod(venueId, dateRange),
          SharedQueryService.getReviewStats(venueId, dateRange),
          SharedQueryService.getTopProducts(venueId, dateRange, 3),
        ])
        const topProduct = products[0]?.productName || 'sin producto líder'
        const actionHints =
          language === 'en'
            ? products.length > 0
              ? ` Suggested actions: promote ${topProduct} in bundles, review low-traffic hours with staff, and test an average-ticket offer around your top products.`
              : ' Suggested actions: start by identifying top products, traffic peaks, and average-ticket opportunities once sales data is available.'
            : products.length > 0
              ? ` Acciones sugeridas: impulsa ${topProduct} en combos, revisa horarios flojos con tu equipo y prueba una oferta para subir ticket promedio alrededor de tus productos top.`
              : ' Acciones sugeridas: primero identifica productos top, horarios fuertes y oportunidades de ticket promedio cuando haya datos de ventas.'
        return this.queryResult(
          step.tool,
          { sales, reviews, topProducts: products },
          language === 'en'
            ? `Summary for ${this.formatDateRangeName(dateRange, language)}: ${this.money(sales.totalRevenue, sales.currency, language)} in sales, ${sales.orderCount} orders, average ticket ${this.money(sales.averageTicket, sales.currency, language)}, ${reviews.totalReviews} reviews, and top product: ${topProduct}.${actionHints}`
            : `Resumen de ${this.formatDateRangeName(dateRange)}: ${this.money(sales.totalRevenue, sales.currency)} en ventas, ${sales.orderCount} órdenes, ticket promedio de ${this.money(sales.averageTicket, sales.currency)}, ${reviews.totalReviews} reseñas y producto líder: ${topProduct}.${actionHints}`,
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
        const staleText =
          pending.staleOpenTotal > 0
            ? language === 'en'
              ? ` ${pending.staleOpenTotal} are older than 24h; review whether they should be closed or cleaned up.`
              : ` ${pending.staleOpenTotal} son antiguas (>24h); conviene revisar si deben cerrarse o limpiarse.`
            : ''
        const recentText =
          pending.recentOpenTotal > 0
            ? language === 'en'
              ? ` Recent average wait: ${pending.averageWaitMinutes} min.`
              : ` Tiempo promedio reciente: ${pending.averageWaitMinutes} min.`
            : language === 'en'
              ? ' There are no open orders created in the last 24 hours.'
              : ' No hay órdenes abiertas creadas en las últimas 24 horas.'
        return this.queryResult(
          step.tool,
          pending,
          language === 'en'
            ? `You have ${pending.total} open orders: ${pending.byStatus.pending} pending, ${pending.byStatus.confirmed} confirmed, ${pending.byStatus.preparing} preparing, and ${pending.byStatus.ready} ready.${recentText}${staleText}`
            : `Tienes ${pending.total} órdenes abiertas: ${pending.byStatus.pending} pendientes, ${pending.byStatus.confirmed} confirmadas, ${pending.byStatus.preparing} en preparación y ${pending.byStatus.ready} listas.${recentText}${staleText}`,
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
      case 'payments.summary': {
        const payments = await SharedQueryService.getPaymentsSummary(venueId, dateRange)
        return this.queryResult(
          step.tool,
          payments,
          payments.totalPayments > 0
            ? `En ${this.formatDateRangeName(dateRange)} recibiste ${payments.totalPayments} pagos por ${this.money(payments.totalAmount, payments.currency)} en total, con ${this.money(payments.totalTips, payments.currency)} en propinas. Completados: ${payments.completedPayments}; reembolsados: ${payments.refundedPayments}.`
            : `No encontré pagos para ${this.formatDateRangeName(dateRange)}.`,
        )
      }
      case 'payments.list': {
        const payments = await SharedQueryService.getPayments(venueId, dateRange, {
          limit: this.limit(step, 10),
          method: typeof step.args.method === 'string' ? step.args.method : undefined,
          source: typeof step.args.source === 'string' ? step.args.source : undefined,
          search: typeof step.args.search === 'string' ? step.args.search : undefined,
        })
        const list = payments.payments
          .map(payment => {
            const card = payment.last4 ? `, terminación ${payment.last4}` : ''
            const order = payment.orderNumber ? `, orden ${payment.orderNumber}` : ''
            const table = payment.tableNumber ? `, mesa ${payment.tableNumber}` : ''
            const staff = payment.processedByName ? `, procesó ${payment.processedByName}` : ''
            return `- ${this.formatDateTime(payment.createdAt)}: ${this.money(payment.amount, payment.currency)} + ${this.money(payment.tipAmount, payment.currency)} propina, ${payment.method}, ${payment.status}${card}${order}${table}${staff}.`
          })
          .join('\n')
        const more = payments.total > payments.payments.length ? `\nHay ${payments.total - payments.payments.length} más.` : ''
        return this.queryResult(
          step.tool,
          payments,
          payments.payments.length > 0
            ? `Pagos de ${this.formatDateRangeName(dateRange)}:\n${list}${more}`
            : `No encontré pagos para ${this.formatDateRangeName(dateRange)}.`,
          payments.payments.length,
        )
      }
      case 'payments.detail': {
        const paymentId = this.requiredStringArg(step, 'paymentId')
        const payment = await SharedQueryService.getPaymentDetail(venueId, paymentId)
        const card = payment.last4 ? `, terminación ${payment.last4}` : ''
        const order = payment.orderNumber ? `, orden ${payment.orderNumber}` : ''
        const table = payment.tableNumber ? `, mesa ${payment.tableNumber}` : ''
        const staff = payment.processedByName ? `, procesó ${payment.processedByName}` : ''
        const items = payment.items.map(item => `- ${item.name}: ${item.quantity} x ${this.money(item.total, payment.currency)}`).join('\n')
        return this.queryResult(
          step.tool,
          payment,
          `Detalle del pago: ${this.money(payment.amount, payment.currency)} + ${this.money(payment.tipAmount, payment.currency)} propina, ${payment.method}, ${payment.status}${card}${order}${table}${staff}.${items ? `\nItems:\n${items}` : ''}`,
        )
      }
      case 'settlementCalendar': {
        const settlement = await SharedQueryService.getSettlementCalendarForPeriod(venueId, dateRange)
        const list = settlement.entries
          .slice(0, this.limit(step, 5))
          .map(
            entry =>
              `${this.formatDate(entry.settlementDate)}: ${this.money(entry.totalNetAmount, settlement.currency)} netos (${entry.transactionCount} transacciones).`,
          )
          .join('\n')
        return this.queryResult(
          step.tool,
          settlement,
          settlement.transactionCount > 0
            ? language === 'en'
              ? `For ${this.formatDateRangeName(dateRange, language)}, your scheduled settlement is ${this.money(settlement.totalNetAmount, settlement.currency, language)} net across ${settlement.transactionCount} transactions.${list ? `\n${list}` : ''}`
              : `Para ${this.formatDateRangeName(dateRange)}, te liquidan ${this.money(settlement.totalNetAmount, settlement.currency)} netos en ${settlement.transactionCount} transacciones.${list ? `\n${list}` : ''}`
            : language === 'en'
              ? `There are no settlements scheduled for ${this.formatDateRangeName(dateRange, language)}.`
              : `No hay liquidaciones programadas para ${this.formatDateRangeName(dateRange)}.`,
          settlement.entries.length,
        )
      }
      case 'settlements.detail': {
        const settlement = await SharedQueryService.getSettlementDetailForPeriod(venueId, dateRange)
        const list = settlement.entries
          .slice(0, this.limit(step, 8))
          .map(entry => {
            const byCard = entry.byCardType
              .map(card => `${card.cardType}: ${this.money(card.netAmount, settlement.currency)} (${card.transactionCount})`)
              .join(', ')
            return `- ${this.formatDate(entry.settlementDate)}: ${this.money(entry.totalNetAmount, settlement.currency)} netos, ${entry.transactionCount} transacciones, ${entry.status}${byCard ? `; ${byCard}` : ''}.`
          })
          .join('\n')
        return this.queryResult(
          step.tool,
          settlement,
          settlement.transactionCount > 0
            ? `Detalle de liquidaciones de ${this.formatDateRangeName(dateRange)}: ${this.money(settlement.totalNetAmount, settlement.currency)} netos en ${settlement.transactionCount} transacciones.\n${list}`
            : `No hay liquidaciones para ${this.formatDateRangeName(dateRange)}.`,
          settlement.entries.length,
        )
      }
      case 'paymentLinks.list': {
        const links = await SharedQueryService.getPaymentLinks(venueId, {
          limit: this.limit(step, 10),
          status: typeof step.args.status === 'string' ? step.args.status : undefined,
          search: typeof step.args.search === 'string' ? step.args.search : undefined,
        })
        const list = links.links
          .slice(0, this.limit(step, 10))
          .map(link => {
            const amount = link.amountType === 'OPEN' || link.amount == null ? 'monto abierto' : this.money(link.amount, link.currency)
            return `- ${link.title}: ${link.status}, ${amount}, ${link.paymentCount} pagos, ${this.money(link.totalCollected, link.currency)} cobrado. https://pay.avoqado.io/${link.shortCode}`
          })
          .join('\n')
        const more = links.hasMore ? `\nHay ${links.total - links.links.length} más.` : ''
        return this.queryResult(
          step.tool,
          links,
          links.links.length > 0 ? `Tienes ${links.total} links de pago:\n${list}${more}` : 'No encontré links de pago para este venue.',
          links.links.length,
        )
      }
      case 'paymentLinks.detail': {
        const linkId = this.requiredStringArg(step, 'linkId')
        const link = await SharedQueryService.getPaymentLinkDetail(venueId, linkId)
        const amount = link.amountType === 'OPEN' || link.amount == null ? 'monto abierto' : this.money(link.amount, link.currency)
        const sessions = link.recentSessions
          .map(session => `- ${this.formatDateTime(session.createdAt)}: ${this.money(session.amount, link.currency)}, ${session.status}.`)
          .join('\n')
        return this.queryResult(
          step.tool,
          link,
          `Detalle del link ${link.title}: ${link.status}, ${amount}, ${link.paymentCount} pagos, ${this.money(link.totalCollected, link.currency)} cobrado. ${link.url}${sessions ? `\nSesiones recientes:\n${sessions}` : ''}`,
          link.recentSessions.length,
        )
      }
      case 'paymentLinks.summary': {
        const summary = await SharedQueryService.getPaymentLinksSummary(venueId)
        return this.queryResult(
          step.tool,
          summary,
          summary.totalLinks > 0
            ? `Tienes ${summary.totalLinks} links de pago: ${summary.activeLinks} activos y ${summary.pausedLinks} pausados. Han cobrado ${this.money(summary.totalCollected, summary.currency)} en ${summary.paymentCount} pagos y ${summary.checkoutSessionCount} sesiones de checkout.`
            : 'No encontré links de pago para este venue.',
        )
      }
      case 'reservations.summary': {
        const reservations = await SharedQueryService.getReservationSummary(venueId, dateRange)
        const includeAllTimeFallback = step.args.includeAllTimeFallback === true && dateRange === 'today'
        if (includeAllTimeFallback) {
          const allTimeReservations = await SharedQueryService.getReservationSummary(venueId, 'allTime')
          return this.queryResult(
            step.tool,
            { today: reservations, allTime: allTimeReservations },
            this.formatReservationSummaryWithFallback(reservations, allTimeReservations, language),
          )
        }

        const byStatus = Object.entries(reservations.byStatus)
          .map(([status, count]) => `${status}: ${count}`)
          .join(', ')
        return this.queryResult(
          step.tool,
          reservations,
          reservations.total > 0
            ? language === 'en'
              ? `In ${this.formatDateRangeName(dateRange, language)}, you have ${reservations.total} reservations. ${byStatus || 'No status breakdown'}. No-show: ${reservations.noShowRate.toFixed(1)}%.`
              : `En ${this.formatDateRangeName(dateRange)} tienes ${reservations.total} reservaciones. ${byStatus || 'Sin desglose por estado'}. No-show: ${reservations.noShowRate.toFixed(1)}%.`
            : language === 'en'
              ? `I did not find reservations for ${this.formatDateRangeName(dateRange, language)}.`
              : `No encontré reservaciones para ${this.formatDateRangeName(dateRange)}.`,
        )
      }
      case 'reservations.list': {
        const reservations = await SharedQueryService.getReservations(venueId, dateRange, {
          limit: this.limit(step, 10),
          status: typeof step.args.status === 'string' ? step.args.status : undefined,
          search: typeof step.args.search === 'string' ? step.args.search : undefined,
        })
        const list = reservations.reservations
          .map(reservation => {
            const name = reservation.guestName || reservation.customerName || 'Sin nombre'
            const service = reservation.productName ? `, ${reservation.productName}` : ''
            const table = reservation.tableNumber ? `, mesa ${reservation.tableNumber}` : ''
            const staff = reservation.assignedStaffName ? `, atiende ${reservation.assignedStaffName}` : ''
            return `- ${this.formatDateTime(reservation.startsAt)}: ${name}, ${reservation.partySize} pax, ${reservation.status}${service}${table}${staff} (${reservation.confirmationCode}).`
          })
          .join('\n')
        const more =
          reservations.total > reservations.reservations.length ? `\nHay ${reservations.total - reservations.reservations.length} más.` : ''
        return this.queryResult(
          step.tool,
          reservations,
          reservations.reservations.length > 0
            ? `Reservaciones de ${this.formatDateRangeName(dateRange)}:\n${list}${more}`
            : `No encontré reservaciones para ${this.formatDateRangeName(dateRange)}.`,
          reservations.reservations.length,
        )
      }
      case 'customers.summary': {
        const customers = await SharedQueryService.getCustomerSummary(venueId)
        const topSpenders = customers.topSpenders
          .slice(0, this.limit(step, 5))
          .map(customer => `- ${customer.name}: ${this.money(customer.totalSpent)} en ${customer.totalVisits} visitas.`)
          .join('\n')
        return this.queryResult(
          step.tool,
          customers,
          `Tienes ${customers.totalCustomers} clientes: ${customers.activeCustomers} activos, ${customers.newCustomersThisMonth} nuevos este mes y ${customers.vipCustomers} VIP. LTV promedio: ${this.money(customers.averageLifetimeValue)}; visitas promedio: ${customers.averageVisitsPerCustomer.toFixed(1)}.${topSpenders ? `\nTop clientes por consumo:\n${topSpenders}` : ''}`,
          customers.topSpenders.length,
        )
      }
      case 'customers.detail': {
        const customerId = this.requiredStringArg(step, 'customerId')
        const customer = await SharedQueryService.getCustomerDetail(venueId, customerId)
        const group = customer.customerGroupName ? ` Grupo: ${customer.customerGroupName}.` : ''
        const lastVisit = customer.lastVisitAt ? ` Última visita: ${this.formatDate(customer.lastVisitAt)}.` : ''
        const orders = customer.recentOrders
          .slice(0, 3)
          .map(
            order =>
              `- ${order.orderNumber || 'Orden'}: ${this.money(order.total)}, ${order.status}, ${this.formatDateTime(order.createdAt)}.`,
          )
          .join('\n')
        const loyalty = customer.recentLoyaltyTransactions
          .slice(0, 3)
          .map(transaction => `- ${transaction.type}: ${transaction.points} puntos, ${this.formatDateTime(transaction.createdAt)}.`)
          .join('\n')
        return this.queryResult(
          step.tool,
          customer,
          `Detalle de cliente ${customer.name}: ${customer.active ? 'activo' : 'inactivo'}, ${customer.loyaltyPoints} puntos, ${customer.totalVisits} visitas, ${this.money(customer.totalSpent)} gastado, ticket promedio ${this.money(customer.averageOrderValue)}.${group}${lastVisit}${orders ? `\nÓrdenes recientes:\n${orders}` : ''}${loyalty ? `\nMovimientos de lealtad:\n${loyalty}` : ''}`,
          customer.recentOrders.length,
        )
      }
      case 'customers.search': {
        const search = typeof step.args.search === 'string' ? step.args.search : undefined
        const customers = await SharedQueryService.searchCustomers(venueId, { search, limit: this.limit(step, 5) })
        const list = customers.customers
          .map(customer => {
            const group = customer.customerGroupName ? `, grupo ${customer.customerGroupName}` : ''
            const pending = customer.pendingBalance > 0 ? `, saldo pendiente ${this.money(customer.pendingBalance)}` : ''
            return `- ${customer.name}: ${customer.active ? 'activo' : 'inactivo'}, ${customer.totalVisits} visitas, ${this.money(customer.totalSpent)} gastado, ${customer.loyaltyPoints} puntos${group}${pending}.`
          })
          .join('\n')
        return this.queryResult(
          step.tool,
          customers,
          customers.customers.length > 0
            ? `Encontré ${customers.total} cliente${customers.total === 1 ? '' : 's'}${search ? ` para "${search}"` : ''}:\n${list}`
            : `No encontré clientes${search ? ` para "${search}"` : ''}.`,
          customers.customers.length,
        )
      }
      case 'creditPacks.list': {
        const packs = await SharedQueryService.getCreditPacks(venueId, { limit: this.limit(step, 10) })
        const list = packs.packs
          .map(pack => {
            const items = pack.items.map(item => `${item.quantity} ${item.productName}`).join(', ')
            const validity = pack.validityDays ? `, vigencia ${pack.validityDays} días` : ''
            return `- ${pack.name}: ${pack.active ? 'activo' : 'inactivo'}, ${this.money(pack.price, pack.currency)}, ${pack.purchaseCount} compras${validity}${items ? `; incluye ${items}` : ''}.`
          })
          .join('\n')
        return this.queryResult(
          step.tool,
          packs,
          packs.packs.length > 0 ? `Tienes ${packs.total} paquetes de crédito:\n${list}` : 'No encontré paquetes de crédito.',
          packs.packs.length,
        )
      }
      case 'creditPacks.summary': {
        const summary = await SharedQueryService.getCreditPacksSummary(venueId)
        return this.queryResult(
          step.tool,
          summary,
          summary.totalPacks > 0
            ? `Tienes ${summary.totalPacks} paquetes de crédito: ${summary.activePacks} activos y ${summary.inactivePacks} inactivos, con ${summary.totalPurchases} compras registradas. Precio promedio: ${this.money(summary.averagePrice, summary.currency)}.`
            : 'No encontré paquetes de crédito configurados.',
        )
      }
      case 'creditPacks.balance': {
        const customerId = this.requiredStringArg(step, 'customerId')
        const credits = await SharedQueryService.getCreditPackBalance(venueId, customerId)
        const list = credits.balances
          .slice(0, this.limit(step, 10))
          .map(item => {
            const expiration = item.expiresAt ? `, vence ${this.formatDate(item.expiresAt)}` : ''
            return `- ${item.productName} (${item.packName}): ${item.remainingQuantity}/${item.initialQuantity} créditos, ${item.status}${expiration}.`
          })
          .join('\n')
        return this.queryResult(
          step.tool,
          credits,
          credits.balances.length > 0
            ? `${credits.customerName} tiene ${credits.totalRemainingCredits} créditos disponibles en ${credits.activePurchases} compras activas.${list ? `\nCréditos por producto:\n${list}` : ''}`
            : `${credits.customerName} no tiene créditos disponibles.`,
          credits.balances.length,
        )
      }
      case 'team.members': {
        const team = await SharedQueryService.getTeamMembers(venueId, {
          limit: this.limit(step, 10),
          search: typeof step.args.search === 'string' ? step.args.search : undefined,
        })
        const list = team.members
          .map(member => {
            const active = member.active ? 'activo' : 'inactivo'
            const permissionSet = member.permissionSetName ? `, permisos: ${member.permissionSetName}` : ''
            return `- ${member.name}: ${member.role}, ${active}, ${member.totalOrders} órdenes, ${this.money(member.totalSales)} en ventas${permissionSet}.`
          })
          .join('\n')
        const more = team.total > team.members.length ? `\nHay ${team.total - team.members.length} más.` : ''
        return this.queryResult(
          step.tool,
          team,
          team.members.length > 0
            ? `Tienes ${team.total} miembros en tu equipo:\n${list}${more}`
            : 'No encontré miembros de equipo para este venue.',
          team.members.length,
        )
      }
      case 'commissions.summary': {
        const commissions = await SharedQueryService.getCommissionsSummary(venueId)
        const topEarners = commissions.topEarners
          .slice(0, this.limit(step, 5))
          .map(earner => `- ${earner.staffName}: ${this.money(earner.totalEarned)} en ${earner.calculationCount} cálculos.`)
          .join('\n')
        return this.queryResult(
          step.tool,
          commissions,
          `Comisiones: ${this.money(commissions.totalPaid)} pagado, ${this.money(commissions.totalApproved)} aprobado y ${this.money(commissions.totalPending)} pendiente. ${commissions.staffWithCommissions} miembros tienen comisiones; promedio ${this.money(commissions.averageCommission)}.${topEarners ? `\nTop comisiones:\n${topEarners}` : ''}`,
          commissions.topEarners.length,
        )
      }
      case 'commissions.payouts': {
        const payouts = await SharedQueryService.getCommissionPayoutsSummary(venueId, { limit: this.limit(step, 10) })
        const list = payouts.recentPayouts
          .map(payout => `- ${payout.staffName}: ${this.money(payout.amount)}, ${payout.status}, ${payout.paymentMethod || 'sin método'}.`)
          .join('\n')
        return this.queryResult(
          step.tool,
          payouts,
          `Payouts de comisiones: ${this.money(payouts.totalPaid)} pagado, ${this.money(payouts.totalPending)} pendiente, ${payouts.payoutCount} payouts pagados, promedio ${this.money(payouts.averagePayout)}.${list ? `\nRecientes:\n${list}` : ''}`,
          payouts.recentPayouts.length,
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

  private detectResponseLanguage(message: string): ResponseLanguage {
    const normalized = message
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()

    const englishSignals =
      /\b(how|what|which|when|where|show|list|give|tell|sales|revenue|orders?|payments?|settlements?|reservations?|customers?|team|links?|today|yesterday|month|week|money|contact|sold|average|ticket)\b/.test(
        normalized,
      )
    const spanishSignals =
      /\b(cuanto|cuanta|cuantos|cuantas|como|donde|ventas?|vendi|ordenes?|pedidos?|pagos?|liquid|dispers|reservaciones?|reservas?|clientes?|equipo|hoy|ayer|mes|semana|dinero|contacto)\b/.test(
        normalized,
      )

    return englishSignals && !spanishSignals ? 'en' : 'es'
  }

  private getDateRange(step: PlannerQueryStep): DateRangeSpec {
    const customRange = this.getCustomDateRangeArg(step.args.dateRange)
    if (customRange) {
      return customRange
    }

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

  private getCustomDateRangeArg(value: unknown): DateRangeSpec | undefined {
    if (isCustomDateRangeSpec(value as DateRangeSpec)) {
      return value as DateRangeSpec
    }

    if (!value || typeof value !== 'object') {
      return undefined
    }

    const maybeRange = value as { from?: unknown; to?: unknown }
    const from = maybeRange.from instanceof Date ? maybeRange.from : typeof maybeRange.from === 'string' ? new Date(maybeRange.from) : null
    const to = maybeRange.to instanceof Date ? maybeRange.to : typeof maybeRange.to === 'string' ? new Date(maybeRange.to) : null

    if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from.getTime() > to.getTime()) {
      return undefined
    }

    return { from, to }
  }

  private limit(step: PlannerQueryStep, fallback: number): number {
    const raw = Number(step.args.limit)
    if (!Number.isFinite(raw)) return fallback
    return Math.min(Math.max(Math.trunc(raw), 1), 25)
  }

  private requiredStringArg(step: PlannerQueryStep, key: string): string {
    const value = step.args[key]
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`Missing required arg for ${step.tool}: ${key}`)
    }
    return value.trim()
  }

  private formatSales(
    sales: { totalRevenue: number; orderCount: number; averageTicket: number; currency: string },
    dateRange: DateRangeSpec,
    language: ResponseLanguage = 'es',
  ): string {
    if (language === 'en') {
      return `${this.formatDateRangeSentencePrefix(dateRange, language)}, you sold ${this.money(sales.totalRevenue, sales.currency, language)} total, with ${sales.orderCount} orders and an average ticket of ${this.money(sales.averageTicket, sales.currency, language)}.`
    }

    return `${this.formatDateRangeSentencePrefix(dateRange)} vendiste ${this.money(sales.totalRevenue, sales.currency)} en total, con ${sales.orderCount} órdenes y ticket promedio de ${this.money(sales.averageTicket, sales.currency)}.`
  }

  private formatProductSalesComparison(
    comparison: {
      leftTerm: string
      rightTerm: string
      left: { revenue: number; quantitySold: number }
      right: { revenue: number; quantitySold: number }
      totalRevenue: number
      currency: string
      filters: { weekendOnly: boolean; nightOnly: boolean }
    },
    dateRange: DateRangeSpec,
    language: ResponseLanguage = 'es',
  ): string {
    const filtersUsed = [
      this.formatDateRangeName(dateRange, language),
      comparison.filters.weekendOnly ? (language === 'en' ? 'weekends' : 'fines de semana') : null,
      comparison.filters.nightOnly ? (language === 'en' ? 'night hours (18:00-23:59)' : 'horario nocturno (18:00-23:59)') : null,
    ]
      .filter(Boolean)
      .join(', ')
    const leftShare = comparison.totalRevenue > 0 ? (comparison.left.revenue / comparison.totalRevenue) * 100 : 0
    const rightShare = comparison.totalRevenue > 0 ? (comparison.right.revenue / comparison.totalRevenue) * 100 : 0

    if (comparison.totalRevenue === 0) {
      return language === 'en'
        ? `I did not find sales to compare "${comparison.leftTerm}" vs "${comparison.rightTerm}" in ${filtersUsed}.`
        : `No encontré ventas para comparar "${comparison.leftTerm}" vs "${comparison.rightTerm}" en ${filtersUsed}.`
    }

    const leftWins = comparison.left.revenue >= comparison.right.revenue
    const winner = leftWins ? comparison.leftTerm : comparison.rightTerm
    const delta = Math.abs(comparison.left.revenue - comparison.right.revenue)

    if (language === 'en') {
      return [
        `Comparison ${comparison.leftTerm} vs ${comparison.rightTerm} in ${filtersUsed}:`,
        `• ${comparison.leftTerm}: ${this.money(comparison.left.revenue, comparison.currency, language)} (${comparison.left.quantitySold} units, ${leftShare.toFixed(1)}%)`,
        `• ${comparison.rightTerm}: ${this.money(comparison.right.revenue, comparison.currency, language)} (${comparison.right.quantitySold} units, ${rightShare.toFixed(1)}%)`,
        `• Winner: ${winner} by ${this.money(delta, comparison.currency, language)}.`,
      ].join('\n')
    }

    return [
      `Comparativo ${comparison.leftTerm} vs ${comparison.rightTerm} en ${filtersUsed}:`,
      `• ${comparison.leftTerm}: ${this.money(comparison.left.revenue, comparison.currency)} (${comparison.left.quantitySold} unidades, ${leftShare.toFixed(1)}%)`,
      `• ${comparison.rightTerm}: ${this.money(comparison.right.revenue, comparison.currency)} (${comparison.right.quantitySold} unidades, ${rightShare.toFixed(1)}%)`,
      `• Ganador: ${winner} por ${this.money(delta, comparison.currency)}.`,
    ].join('\n')
  }

  private formatReservationSummaryWithFallback(
    today: { total: number; byStatus: Record<string, number>; noShowRate: number },
    allTime: { total: number; byStatus: Record<string, number>; noShowRate: number },
    language: ResponseLanguage = 'es',
  ): string {
    const todayStatus = this.formatStatusBreakdown(today.byStatus)
    const allTimeStatus = this.formatStatusBreakdown(allTime.byStatus)

    if (language === 'en') {
      const todayText =
        today.total > 0
          ? `Today, you have ${today.total} reservations${todayStatus ? ` (${todayStatus})` : ''}.`
          : 'I did not find reservations for today.'
      const allTimeText =
        allTime.total > 0
          ? `Across all time, you have ${allTime.total} reservations${allTimeStatus ? ` (${allTimeStatus})` : ''}. No-show: ${allTime.noShowRate.toFixed(1)}%.`
          : 'I did not find historical reservations either.'
      return `${todayText} ${allTimeText}`
    }

    const todayText =
      today.total > 0
        ? `Hoy tienes ${today.total} reservaciones${todayStatus ? ` (${todayStatus})` : ''}.`
        : 'No encontré reservaciones para hoy.'
    const allTimeText =
      allTime.total > 0
        ? `En todo el historial tienes ${allTime.total} reservaciones${allTimeStatus ? ` (${allTimeStatus})` : ''}. No-show: ${allTime.noShowRate.toFixed(1)}%.`
        : 'Tampoco encontré reservaciones históricas.'
    return `${todayText} ${allTimeText}`
  }

  private formatStatusBreakdown(byStatus: Record<string, number>): string {
    return Object.entries(byStatus)
      .filter(([, count]) => Number(count) > 0)
      .map(([status, count]) => `${status}: ${count}`)
      .join(', ')
  }

  private formatUnsupported(topic: string, reason: string, language: ResponseLanguage = 'es'): string {
    if (language === 'en') {
      return `About ${topic}: ${reason} I can help with data and operations for the current venue.`
    }

    return `Sobre ${topic}: ${reason} Puedo ayudarte con datos y operaciones del venue actual.`
  }

  private violationTypeForUnsupported(topic: string, reason: string): SecurityViolationType {
    const normalized = `${topic} ${reason}`
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()

    if (/\b(otro venue|otra sucursal|another venue|other venue|venue actual|cross[- ]?venue)\b/.test(normalized)) {
      return SecurityViolationType.CROSS_VENUE_ACCESS
    }

    if (/\b(schema|esquema|tablas?|columns?|information_schema|pg_catalog|base de datos|database)\b/.test(normalized)) {
      return SecurityViolationType.SCHEMA_DISCOVERY
    }

    return SecurityViolationType.PROMPT_INJECTION
  }

  private formatDateRangeName(dateRange: DateRangeSpec, language: ResponseLanguage = 'es'): string {
    if (isCustomDateRangeSpec(dateRange)) {
      return this.formatCustomDateRangeName(dateRange, language)
    }

    const namesEs: Record<RelativeDateRange, string> = {
      today: 'hoy',
      yesterday: 'ayer',
      last7days: 'los últimos 7 días',
      last30days: 'los últimos 30 días',
      thisWeek: 'los últimos 7 días',
      thisMonth: 'los últimos 30 días',
      lastWeek: 'los 7 días anteriores',
      lastMonth: 'los 30 días anteriores',
      allTime: 'todo el historial',
    }
    const namesEn: Record<RelativeDateRange, string> = {
      today: 'today',
      yesterday: 'yesterday',
      last7days: 'the last 7 days',
      last30days: 'the last 30 days',
      thisWeek: 'the last 7 days',
      thisMonth: 'the last 30 days',
      lastWeek: 'the previous 7 days',
      lastMonth: 'the previous 30 days',
      allTime: 'all time',
    }
    const names = language === 'en' ? namesEn : namesEs
    return names[dateRange] || dateRange
  }

  private formatCustomDateRangeName(dateRange: { from: Date; to: Date }, language: ResponseLanguage = 'es'): string {
    const locale = language === 'en' ? 'en-US' : 'es-MX'
    const sameDay =
      dateRange.from.getFullYear() === dateRange.to.getFullYear() &&
      dateRange.from.getMonth() === dateRange.to.getMonth() &&
      dateRange.from.getDate() === dateRange.to.getDate()
    const from = new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'long',
      year: sameDay || dateRange.from.getFullYear() === dateRange.to.getFullYear() ? undefined : 'numeric',
      timeZone: DEFAULT_TIMEZONE,
    }).format(dateRange.from)
    const to = new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: DEFAULT_TIMEZONE,
    }).format(dateRange.to)

    if (sameDay) {
      return language === 'en' ? `on ${to}` : `el ${to}`
    }

    return language === 'en' ? `from ${from} to ${to}` : `del ${from} al ${to}`
  }

  private formatDateRangeSentencePrefix(dateRange: DateRangeSpec, language: ResponseLanguage = 'es'): string {
    if (isCustomDateRangeSpec(dateRange)) {
      const formattedRange = this.formatCustomDateRangeName(dateRange, language)
      return language === 'en' ? `In the period ${formattedRange}` : `En el período ${formattedRange}`
    }

    if (language === 'en') {
      if (dateRange === 'today') return 'Today'
      if (dateRange === 'yesterday') return 'Yesterday'
      return `In ${this.formatDateRangeName(dateRange, language)}`
    }

    if (dateRange === 'today') return 'Hoy'
    if (dateRange === 'yesterday') return 'Ayer'
    return `En ${this.formatDateRangeName(dateRange)}`
  }

  private formatDateRangeAdverbial(dateRange: DateRangeSpec, language: ResponseLanguage = 'es'): string {
    if (isCustomDateRangeSpec(dateRange)) {
      return this.formatCustomDateRangeName(dateRange, language)
    }

    if (language === 'en') {
      if (dateRange === 'today') return 'today'
      if (dateRange === 'yesterday') return 'yesterday'
      return `in ${this.formatDateRangeName(dateRange, language)}`
    }

    if (dateRange === 'today') return 'hoy'
    if (dateRange === 'yesterday') return 'ayer'
    return `en ${this.formatDateRangeName(dateRange)}`
  }

  private formatDateTime(date: Date): string {
    return new Intl.DateTimeFormat('es-MX', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date)
  }

  private money(value: number, currency = 'MXN', language: ResponseLanguage = 'es'): string {
    return new Intl.NumberFormat(language === 'en' ? 'en-US' : 'es-MX', { style: 'currency', currency }).format(value)
  }

  private formatDate(value: Date): string {
    return new Intl.DateTimeFormat('es-MX', { day: '2-digit', month: 'short', year: 'numeric' }).format(value)
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
    const primaryIntent = params.metadataSteps.find(step => step.kind === 'query' && step.status === 'executed')?.tool

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
        intent: primaryIntent,
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
