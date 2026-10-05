import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from './scope'
import { ScopeError } from './errors'
import { text } from './respond'
import { CONFIRMATION_TTL, issueConfirmation, validConfirmation } from './confirmation'
import { DIRECTORY_TOOLS, type McpProfile } from './directory/catalog'
import { DIRECTORY_DESCRIPTIONS } from './directory/descriptions'
import { redactDirectoryResult } from './directory/redact'
import { directoryInputSchema } from './directory/input'

/** Explicit effects, never guessed from a name or permission suffix. New tools must declare one. */
export const TOOL_EFFECTS: Record<string, 'read' | 'write'> = {
  accept_hybrid_purchase: 'write',
  account_ledger: 'read',
  account_mapping: 'read',
  accounting_banks_summary: 'read',
  accounting_business_summary: 'read',
  accounting_income_statement: 'read',
  accounting_iva_cashflow: 'read',
  accounting_period_locks: 'read',
  accounting_reports: 'read',
  accounts_payable: 'read',
  add_customer_note: 'write',
  add_employee: 'write',
  add_journal_entry: 'write',
  add_ledger_account: 'write',
  add_to_waitlist: 'write',
  adjust_loyalty_points: 'write',
  adjust_raw_material_stock: 'write',
  adjust_stock: 'write',
  apply_service_charge: 'write',
  approve_inter_venue_transfer: 'write',
  approve_overtime: 'write',
  area_ticket_reconciliation_queue: 'read',
  area_ticket_status: 'read',
  assign_table_check: 'write',
  attendance_heatmap: 'read',
  attendance_payroll_summary: 'read',
  audit_terminals: 'read',
  available_balance: 'read',
  avoqado_help: 'read',
  avoqado_internal_docs: 'read',
  bank_reconciliation_summary: 'read',
  birthday_automation_status: 'read',
  cancel_hybrid_contract: 'write',
  cancel_hybrid_purchase: 'write',
  cancel_inter_venue_transfer: 'write',
  cancel_reservation: 'write',
  cancel_stock_count: 'write',
  cash_closeout: 'read',
  cash_out_org_active_days: 'read',
  cash_out_org_commission_rates: 'read',
  cash_out_org_saldos: 'read',
  cash_out_org_withdrawals: 'read',
  cash_out_saldo: 'read',
  cash_out_withdrawals: 'read',
  category_mix: 'read',
  cfdi_status: 'read',
  change_sim_category: 'write',
  channel_mix: 'read',
  chart_of_accounts: 'read',
  class_session_detail: 'read',
  close_accounting_period: 'write',
  commission_payouts: 'read',
  comp_table_check: 'write',
  configure_auto_reorder: 'write',
  configure_loyalty: 'write',
  configure_receipt_layout: 'write',
  configure_referral: 'write',
  configure_reservations: 'write',
  configure_wallet_card: 'write',
  confirm_catalog_import: 'write',
  confirm_catalog_publication: 'write',
  confirm_order_price_contract: 'write',
  create_category: 'write',
  create_coupon: 'write',
  create_customer: 'write',
  create_discount: 'write',
  create_inter_venue_transfer: 'write',
  create_launch_campaign: 'write',
  create_modifier_group: 'write',
  create_payment_link: 'write',
  create_percent_promotion: 'write',
  create_product: 'write',
  create_promotion: 'write',
  create_raw_material: 'write',
  create_recipe: 'write',
  create_supplier: 'write',
  enable_recipe_inventory: 'write',
  update_raw_material: 'write',
  create_reservation: 'write',
  customer_credit_balance: 'read',
  customer_group_detail: 'read',
  customer_history: 'read',
  customers_awaiting_approval: 'read',
  daily_sales: 'read',
  decide_customer_approval: 'write',
  delivery_activation_requests: 'read',
  delivery_channels: 'read',
  delivery_courier: 'read',
  delivery_line_actions: 'read',
  diot: 'read',
  dispatch_inter_venue_transfer: 'write',
  dispose_fixed_asset: 'write',
  downgrade_venue_to_free: 'write',
  edit_sale_verification: 'write',
  electronic_accounting_balance: 'read',
  electronic_accounting_catalog: 'read',
  electronic_accounting_polizas: 'read',
  emit_refund_credit_note: 'write',
  employees: 'read',
  expenses: 'read',
  export_sales_summary: 'read',
  feature_catalog: 'read',
  find_customer: 'read',
  find_order: 'read',
  fiscal_readiness: 'read',
  generate_depreciation: 'write',
  generate_expense_policies: 'write',
  generate_journal_entries: 'write',
  get_activity_log: 'read',
  get_announcement: 'read',
  get_cash_drawer_status: 'read',
  get_catalog_item: 'read',
  get_hybrid_campaign: 'read',
  get_inventory_movements: 'read',
  get_launch_campaign: 'read',
  get_recipe: 'read',
  get_venue_downgrade_preview: 'read',
  get_venue_plan_status: 'read',
  get_venue_seat_status: 'read',
  hybrid_campaign_redemptions: 'read',
  hybrid_contracts: 'read',
  hybrid_current_purchase: 'read',
  hybrid_offers: 'read',
  hybrid_purchase_status: 'read',
  hybrid_replacement_options: 'read',
  import_expense_xml: 'write',
  inter_venue_transfer_detail: 'read',
  inventory_by_responsible: 'read',
  inventory_postings: 'read',
  invite_staff: 'write',
  isr_provisional: 'read',
  issue_refund: 'write',
  journal_entries: 'read',
  landing_leads: 'read',
  list_announcements: 'read',
  list_areas: 'read',
  list_asset_types: 'read',
  list_cash_drawer_sessions: 'read',
  list_catalog_items: 'read',
  list_class_sessions: 'read',
  list_commission_goals: 'read',
  list_commission_schemes: 'read',
  list_credit_packs: 'read',
  list_customer_campaigns: 'read',
  list_customer_groups: 'read',
  list_devices: 'read',
  list_discounts: 'read',
  list_fixed_assets: 'read',
  list_hybrid_campaigns: 'read',
  list_inter_venue_transfers: 'read',
  list_kitchen_tickets: 'read',
  list_launch_campaigns: 'read',
  list_menu: 'read',
  list_merchant_routing_rules: 'read',
  list_my_organizations: 'read',
  list_my_venues: 'read',
  list_payment_effects: 'read',
  list_payment_links: 'read',
  list_payments: 'read',
  list_prices: 'read',
  list_print_stations: 'read',
  list_printers: 'read',
  list_promotions: 'read',
  list_purchase_orders: 'read',
  list_raw_materials: 'read',
  list_product_recipes: 'read',
  list_refunds: 'read',
  list_reviews: 'read',
  list_sale_verifications: 'read',
  list_serialized_items: 'read',
  list_shifts: 'read',
  list_staff: 'read',
  list_suppliers: 'read',
  list_tender_types: 'read',
  list_waitlist: 'read',
  list_waste_reports: 'read',
  log_waste: 'write',
  low_stock: 'read',
  loyalty_status: 'read',
  mark_expense_paid: 'write',
  mark_serialized_item: 'write',
  menu_categories: 'read',
  menu_item_detail: 'read',
  merge_table_check: 'write',
  move_table_check: 'write',
  my_class_now: 'read',
  open_orders: 'read',
  org_confirmed_sales_report: 'read',
  org_insights: 'read',
  org_structure: 'read',
  payroll_run: 'write',
  peak_hours: 'read',
  pending_area_ticket_deliveries: 'read',
  pending_external_confirmations: 'read',
  pos_sync_status: 'read',
  preview_catalog_import: 'write',
  preview_catalog_publication: 'write',
  preview_hybrid_offer: 'read',
  preview_merchant_eligibility: 'read',
  preview_percent_promotion: 'read',
  price_gap_report: 'read',
  print_routing_preview: 'read',
  product_sales: 'read',
  promoter_deposits: 'read',
  promoter_detail: 'read',
  promoter_location: 'read',
  promoters_live_locations: 'read',
  promotion_sales: 'read',
  promotion_status: 'read',
  publish_hybrid_campaign: 'write',
  purchase_order_detail: 'read',
  quarantine_batch: 'write',
  quote_hybrid_purchase: 'write',
  raw_material_presentations: 'read',
  reassign_sim_promoter: 'write',
  reassign_sim_supervisor: 'write',
  receipt_layout: 'read',
  receive_inter_venue_transfer: 'write',
  recent_orders: 'read',
  record_manual_payment: 'write',
  record_serialized_sale: 'write',
  redeem_credit: 'write',
  redeem_loyalty_on_check: 'write',
  redeem_stamp_reward: 'write',
  referral_status: 'read',
  refund_card_on_terminal: 'write',
  register_expense: 'write',
  register_fixed_asset: 'write',
  reject_inter_venue_transfer: 'write',
  release_terminal_payment: 'write',
  reopen_accounting_period: 'write',
  reopen_sale_verification: 'write',
  reorder_suggestions: 'read',
  request_catalog_override: 'write',
  reschedule_reservation: 'write',
  reservation_detail: 'read',
  reservation_settings: 'read',
  reservations: 'read',
  resolve_inter_venue_transfer_variance: 'write',
  respond_to_review: 'write',
  resume_hybrid_purchase: 'write',
  revenue_by_venue: 'read',
  review_sale_verification: 'write',
  sales_by_payment_method: 'read',
  sales_comparison: 'read',
  sales_vs_target: 'read',
  save_hybrid_campaign: 'write',
  schedule_hybrid_selection: 'write',
  search_orders: 'read',
  seed_chart_of_accounts: 'write',
  sell_credit_pack: 'write',
  send_cfdi_email: 'write',
  serialized_inventory: 'read',
  serialized_low_stock: 'read',
  serialized_sales_by_promoter: 'read',
  serialized_stock_by_category: 'read',
  serialized_stock_metrics: 'read',
  serialized_stock_movements: 'read',
  serialized_stock_trend: 'read',
  service_charges: 'read',
  service_staff: 'read',
  set_account_mapping: 'write',
  set_birthday_automation: 'write',
  set_customer_tags: 'write',
  set_feature_list_price: 'write',
  set_fiscal_loss: 'write',
  set_hybrid_campaign_status: 'write',
  set_launch_campaign_featured: 'write',
  set_launch_campaign_status: 'write',
  set_menu_item_active: 'write',
  set_menu_item_price: 'write',
  set_merchant_routing_rule: 'write',
  set_print_station_kitchen_display: 'write',
  set_promotion_group_status: 'write',
  set_raw_material_presentations: 'write',
  set_reservation_status: 'write',
  set_sales_retention: 'write',
  set_service_staff: 'write',
  set_staff_schedule: 'write',
  set_table_check_details: 'write',
  set_table_status: 'write',
  set_terminal_payment_strict_mode: 'write',
  settlement_calendar: 'read',
  settlement_week: 'read',
  sim_custody: 'read',
  sim_pending_approvals: 'read',
  split_table_check: 'write',
  split_table_check_by_seat: 'write',
  staff_attendance: 'read',
  staff_commission: 'read',
  staff_detail: 'read',
  staff_documents: 'read',
  staff_online: 'read',
  staff_ranking: 'read',
  staff_schedule: 'read',
  staff_tips: 'read',
  stamp_card_status: 'read',
  stamp_payroll_receipts: 'write',
  stock_batches: 'read',
  stock_counts: 'read',
  stock_value: 'read',
  store_anomalies: 'read',
  store_sales_trend: 'read',
  subscription_status: 'read',
  supplier_invoices: 'read',
  tables_status: 'read',
  tender_commissions: 'read',
  terminal_checkout_screens: 'read',
  terminal_location: 'read',
  terminal_payment_requests: 'read',
  tips_over_time: 'read',
  today_overview: 'read',
  top_products: 'read',
  trial_balance: 'read',
  undo_check_in: 'write',
  update_fixed_asset: 'write',
  update_reservation: 'write',
  update_staff_member: 'write',
  upsell_status: 'read',
  venue_attendance: 'read',
  venue_entitlements: 'read',
  venue_feature_grid: 'read',
  venue_features: 'read',
  venue_profile: 'read',
  wallet_card_design: 'read',
  who_is_late_now: 'read',
  work_shifts: 'read',
}

const outputSchema = {
  status: z.enum(['success', 'needs_input', 'not_found', 'error']),
  data: z.unknown().describe('Resultado de la herramienta; conserva sus campos de dominio'),
}

/** Common machine-readable envelope; the original text remains compatible with existing clients. */
export function structureToolResult(result: unknown) {
  const r = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
  const first = r?.content?.find(c => c.type === 'text')?.text
  let data: unknown = first ?? null
  if (first) {
    try {
      data = JSON.parse(first)
    } catch {
      /* prose is valid content */
    }
  }
  const d = data as Record<string, unknown> | null
  const status = r.isError
    ? 'error'
    : d?.needsInput === true || d?.requiresConfirmation === true || d?.ambiguous === true
      ? 'needs_input'
      : d?.ok === false
        ? 'error'
        : d?.found === false
          ? 'not_found'
          : 'success'
  return { ...r, structuredContent: { status, data }, ...(status === 'error' ? { isError: true } : {}) }
}

/** Uses the SDK's disabled-tool gate for BOTH discovery and direct tools/call requests. */
export function configureToolCatalog(server: McpServer, scope: McpScope, profile: McpProfile = 'manual'): void {
  const host = server as unknown as Record<string, (...args: any[]) => any>
  const register = host.registerTool.bind(server)
  const registerCatalogTool = (name: string, config: Record<string, any>, callback: (...args: any[]) => any) => {
    const effect = TOOL_EFFECTS[name]
    if (!effect) throw new Error(`MCP tool needs an explicit effect declaration: ${name}`)
    const readOnly = effect === 'read'
    const title = config.title ?? name.replace(/_/g, ' ').replace(/^./, (c: string) => c.toUpperCase())
    // Existing durable catalog/waste workflows already bind a preview in their own service.
    const needsPreview = !readOnly && config.inputSchema?.confirm && !config.inputSchema?.previewToken && !config.inputSchema?.previewDigest
    const baseInput = profile === 'directory' ? directoryInputSchema(name, config.inputSchema) : config.inputSchema
    const inputSchema = needsPreview
      ? {
          ...baseInput,
          confirmationToken: z
            .string()
            .max(2048)
            .optional()
            .describe('Token de la vista previa de ESTA operación. Confirma sólo después de la autorización humana.'),
        }
      : baseInput
    const included = profile === 'manual' || DIRECTORY_TOOLS.has(name)
    // Directory answers drop fiscal and third-party integration identifiers (see directory/redact.ts).
    const run = profile === 'directory' ? async (...a: any[]) => redactDirectoryResult(await callback(...a)) : callback
    const granted = () => included && (scope.scopes ?? ['mcp:read']).includes(readOnly ? 'mcp:read' : 'mcp:write')
    const tool = register(
      name,
      {
        ...config,
        // The directory publishes its own descriptions: the manual ones mention tools it does not expose.
        ...(profile === 'directory' && DIRECTORY_DESCRIPTIONS[name] ? { description: DIRECTORY_DESCRIPTIONS[name] } : {}),
        title,
        inputSchema,
        outputSchema,
        annotations: {
          title,
          readOnlyHint: readOnly,
          // Conservative for writes: do not promise harmlessness or safe retries without a service guarantee.
          destructiveHint: !readOnly,
          openWorldHint: !readOnly,
          idempotentHint: readOnly,
        },
      },
      async (...args: any[]) => {
        if (!included) throw new ScopeError('Esta operación no está disponible en el catálogo de publicación de Avoqado.')
        if (!granted())
          throw new ScopeError(
            `Esta conexión requiere autorizar ${readOnly ? 'mcp:read' : 'mcp:write'}. Vuelve a conectar con ese permiso.`,
          )
        if (!needsPreview) return structureToolResult(await run(...args))
        const { confirmationToken, ...input } = args[0]
        const { confirm: _confirm, ...intent } = input
        if (input.confirm === true && !validConfirmation(confirmationToken, scope, name, intent)) {
          return structureToolResult(
            text({
              ok: false,
              needsInput: true,
              field: 'confirmationToken',
              question:
                'Solicita una vista previa vigente llamando sin confirm:true. Muéstrala al usuario y pide confirmar la operación antes de ejecutar.',
            }),
          )
        }
        const result = structureToolResult(await run(input, ...args.slice(1)))
        const data = result.structuredContent.data as Record<string, unknown> | null
        if (data?.requiresConfirmation === true && input.confirm !== true) {
          // Existing previews can supply concurrency fields that were unknown on the first call.
          // Bind those exact values as well, rather than invalidating an otherwise correct confirmation.
          const confirmationArguments = { ...intent }
          for (const field of ['expectedSourceFingerprint', 'expectedUpdatedAt', 'resolvedProductId', 'resolvedStaffVenueId']) {
            if (config.inputSchema?.[field] && data[field] != null) confirmationArguments[field] = data[field]
          }
          return structureToolResult(
            text({
              ...data,
              confirmationArguments,
              confirmationToken: issueConfirmation(scope, name, confirmationArguments),
              expiresInSeconds: CONFIRMATION_TTL,
              confirmationInstruction:
                'Muestra el venue y el cambio al usuario. Sólo tras su autorización, usa confirmationArguments con confirm:true y este confirmationToken. No cambies los valores.',
            }),
          )
        }
        return result
      },
    )
    if (!granted()) tool.disable()
    return tool
  }
  host.registerTool = registerCatalogTool
  // All current modules use tool(name, description, rawZodShape, callback). Keep that API while
  // registering through the modern SDK API, which supports outputSchema and annotations.
  host.tool = (name: string, ...args: any[]) => {
    const description = typeof args[0] === 'string' ? args.shift() : undefined
    const callback = args.pop()
    const inputSchema = args[0] ?? {}
    return registerCatalogTool(name, { description, inputSchema }, callback)
  }
}
