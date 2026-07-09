import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { hasPermission } from '@/services/access/access.service'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { ScopeError } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import {
  getOrgSalesSummary,
  getSalesByMonth,
  getSalesByCity,
  getSalesByStore,
  getSalesBySupervisor,
  getSalesByPromoter,
  getSalesByPromoterDaily,
  getSalesByPromoterWeekly,
  getSalesBySaleTypeWeekly,
  getSalesBySimTypeWeekly,
  getOrgStructure,
  listOrgSaleVerifications,
  parseRange,
  reviewOrgSaleVerification,
  reopenOrgSaleVerification,
  editOrgSaleVerification,
} from '@/services/dashboard/sale-verification.org.dashboard.service'

/**
 * Org-level CONFIRMED-sales reporting (PlayTelecom / serialized-inventory
 * back-office). Mirrors the dashboard "Ventas" executive view: every grouping
 * counts only SaleVerification.status=COMPLETED ("ventas confirmadas") — sales
 * still under review never inflate these numbers.
 */
export function registerSaleVerificationTools(server: McpServer, scope: McpScope) {
  /** Same gate as the dashboard routes: `sale-verifications:review` on at least one venue of the active org. */
  function requireReviewAccess(): void {
    for (const access of scope.perVenueAccess.values()) {
      if (access.organizationId === scope.activeOrg && hasPermission(access, 'sale-verifications:review')) return
    }
    throw new ScopeError('Missing permission sale-verifications:review in this organization')
  }

  server.tool(
    'org_confirmed_sales_report',
    'CONFIRMED sales report for the connected organization (serialized-inventory / PlayTelecom back-office). Only counts sales whose back-office verification is COMPLETED ("venta correcta") — sales "en revisión" or without evidence are EXCLUDED from every figure. groupBy: "summary" (KPIs incl. confirmedRevenue + pending/failed/rejected counters), "month", "city", "store", "supervisor" (the venue MANAGER responsible), "promoter" (the staff who sold, monthly), or "promoterDaily" (CURRENT MONTH only — per promoter per day, plus a `toReview` count of FAILED sales the promoter must fix on the TPV, which are NOT in the total). Answers "¿cuántas ventas confirmadas llevamos por ciudad/tienda/promotor? ¿cuáles tiene que corregir cada promotor?". Optional fromDate/toDate (YYYY-MM-DD) limit the window (ignored for promoterDaily); omit for full history. New: "saleTypeWeekly" and "simTypeWeekly" give week-by-week breakdowns whose totals reconcile with the weekly figures. "promoterWeekly" (por promotor × semana, ya atribuido a su tienda y supervisor — úsalo para análisis por supervisor sin cruzar datos).',
    {
      groupBy: z
        .enum([
          'summary',
          'month',
          'city',
          'store',
          'supervisor',
          'promoter',
          'promoterDaily',
          'saleTypeWeekly',
          'simTypeWeekly',
          'promoterWeekly',
        ])
        .describe(
          'Aggregation: summary KPIs; confirmed sales by month / city / store / supervisor / promoter / promoterDaily; WEEKLY tables saleTypeWeekly (Líneas Nuevas vs Portabilidades) and simTypeWeekly (SIM de Intercambio / $100 de Promotor / SIM de Evento / e-SIM / Otros SIMs); or promoterWeekly (per promoter × week, attributed to store + supervisor)',
        ),
      fromDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Window start (YYYY-MM-DD, venue timezone). Omit for full history'),
      toDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Window end (YYYY-MM-DD, venue timezone). Omit for full history'),
    },
    async ({ groupBy, fromDate, toDate }) => {
      requireReviewAccess()
      const orgId = scope.activeOrg
      const range = parseRange(fromDate, toDate)

      switch (groupBy) {
        case 'summary':
          return text(await getOrgSalesSummary(orgId, range))
        case 'month':
          return text(await getSalesByMonth(orgId, range))
        case 'city':
          return text(await getSalesByCity(orgId, range))
        case 'store':
          return text(await getSalesByStore(orgId, range))
        case 'supervisor':
          return text(await getSalesBySupervisor(orgId, range))
        case 'promoter':
          return text(await getSalesByPromoter(orgId, range))
        case 'promoterDaily':
          return text(await getSalesByPromoterDaily(orgId))
        case 'saleTypeWeekly':
          return text(await getSalesBySaleTypeWeekly(orgId, range))
        case 'simTypeWeekly':
          return text(await getSalesBySimTypeWeekly(orgId, range))
        case 'promoterWeekly':
          return text({ promoters: await getSalesByPromoterWeekly(orgId, range) })
      }
    },
  )

  server.tool(
    'org_structure',
    'The organization roster: each supervisor (the store MANAGER) → their stores → the promoters (CASHIER/WAITER staff) working there. Includes stores with ZERO sales and stores with no assigned supervisor (unassignedStores). Answers "¿qué tiendas y promotores tiene cada supervisor? ¿qué promotores hay en la tienda X?". Serialized-inventory / PlayTelecom org back-office. No arguments — uses your active organization.',
    {},
    async () => {
      requireReviewAccess()
      return text(await getOrgStructure(scope.activeOrg))
    },
  )

  server.tool(
    'list_sale_verifications',
    'List INDIVIDUAL sale verifications (the back-office approval queue) for your organization — the per-sale detail behind the confirmed-sales counters. Each row is one sale with its status (PENDING/COMPLETED/FAILED/REJECTED), the promoter, the store, the SIM(s), and — when not approved — WHY. Filter by status (e.g. FAILED = las que el promotor debe corregir; REJECTED = rechazadas), by promoter (staffId), by portabilidad, or free `search` (ICCID / promoter name). Answers "muéstrame las ventas en revisión / rechazadas y por qué", "¿qué tiene pendiente de corregir el promotor X?". Paginated. Serialized-inventory / PlayTelecom back-office.',
    {
      status: z.enum(['PENDING', 'COMPLETED', 'FAILED', 'REJECTED']).optional().describe('Filter by verification status'),
      staffId: z.string().optional().describe('Only sales by this promoter (staffId)'),
      isPortabilidad: z.boolean().optional().describe('true = only portabilidades; false = only líneas nuevas'),
      search: z.string().optional().describe('Free text: ICCID or promoter name'),
      pageSize: z.number().int().positive().max(100).optional().describe('Rows per page (default 20)'),
      pageNumber: z.number().int().positive().optional().describe('1-based page (default 1)'),
    },
    async ({ status, staffId, isPortabilidad, search, pageSize, pageNumber }) => {
      requireReviewAccess()
      const res = await listOrgSaleVerifications(scope.activeOrg, {
        status: status as never,
        staffId,
        isPortabilidad,
        search,
        pageSize: pageSize ?? 20,
        pageNumber: pageNumber ?? 1,
      })
      return text(res)
    },
  )

  // generic org-permission gate (requireReviewAccess already does this for sale-verifications:review)
  function requireOrgPermission(permission: string): void {
    for (const access of scope.perVenueAccess.values()) {
      if (access.organizationId === scope.activeOrg && hasPermission(access, permission)) return
    }
    throw new ScopeError(`Missing permission ${permission} in this organization`)
  }
  async function fetchSaleForPreview(saleVerificationId: string) {
    return prisma.saleVerification.findFirst({
      where: { id: saleVerificationId, venue: { organizationId: scope.activeOrg } },
      select: {
        id: true,
        status: true,
        isPortabilidad: true,
        venueId: true,
        staff: { select: { firstName: true, lastName: true } },
        venue: { select: { name: true } },
        payment: { select: { amount: true } },
      },
    })
  }
  const DECISION_MAP = { approve: 'APPROVE', reject: 'REJECT', reject_final: 'REJECT_FINAL' } as const

  server.tool(
    'review_sale_verification',
    'Approve or reject ONE PENDING sale verification (back-office documentation review — approving is what makes Walmart pay PlayTelecom for a sale). decision: "approve" → COMPLETED ("venta correcta"); "reject" → FAILED (the promoter re-uploads/corrects it on the TPV); "reject_final" → REJECTED (terminal loss). Only PENDING sales can be reviewed — if it is already COMPLETED, reopen it first; to fix data use edit_sale_verification. For "reject" you MUST give a rejectionReasons value or reviewNotes. Find the id with list_sale_verifications (it searches by ICCID / promoter). By DEFAULT this only PREVIEWS; call again with confirm:true. This WRITES — requires sale-verifications:review.',
    {
      saleVerificationId: z.string().min(1).describe('The verification id (from list_sale_verifications)'),
      decision: z
        .enum(['approve', 'reject', 'reject_final'])
        .describe('approve → COMPLETED; reject → FAILED (promoter fixes on TPV); reject_final → REJECTED (terminal)'),
      rejectionReasons: z
        .array(
          z.enum([
            'REVIEW_PORTABILIDAD',
            'REVIEW_DUPLICATE_VINCULACION',
            'REVIEW_ILLEGIBLE_IMAGES',
            'REVIEW_MISSING_LINKING_IMAGE',
            'OTHER',
          ]),
        )
        .optional()
        .describe(
          'Why it was rejected (required for "reject" unless you give reviewNotes). REVIEW_MISSING_LINKING_IMAGE = falta imagen de vinculación; REVIEW_PORTABILIDAD = falta imagen de portabilidad; REVIEW_DUPLICATE_VINCULACION = # de vinculación duplicada; REVIEW_ILLEGIBLE_IMAGES = imágenes ilegibles.',
        ),
      reviewNotes: z.string().optional().describe('Optional free-text note'),
      confirm: z.boolean().optional().describe('Must be true to actually apply; without it you get a preview'),
    },
    async ({ saleVerificationId, decision, rejectionReasons, reviewNotes, confirm }) => {
      requireOrgPermission('sale-verifications:review')
      const sale = await fetchSaleForPreview(saleVerificationId)
      if (!sale) return text({ ok: false, error: 'No encontré esa venta en tu organización.' })
      if (sale.status !== 'PENDING') {
        return text({
          ok: false,
          error: `Esta venta está en estado ${sale.status}, no PENDING. Solo se pueden aprobar/rechazar ventas PENDING. Si ya está COMPLETED y quieres re-evaluarla usa reopen_sale_verification; para corregir datos usa edit_sale_verification.`,
        })
      }
      if (decision === 'reject' && (!rejectionReasons || rejectionReasons.length === 0) && !reviewNotes?.trim()) {
        return text({ ok: false, error: 'Para rechazar (reject) indica al menos una razón en rejectionReasons o una nota en reviewNotes.' })
      }
      const who = sale.staff ? `${sale.staff.firstName} ${sale.staff.lastName}`.trim() : 'sin promotor'
      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          change: {
            saleVerificationId,
            from: 'PENDING',
            decision,
            promoter: who,
            store: sale.venue?.name ?? null,
            amount: sale.payment ? Number(sale.payment.amount) : null,
          },
          message: `Vas a ${decision === 'approve' ? 'APROBAR (→ COMPLETED, "venta correcta")' : decision === 'reject' ? 'RECHAZAR para corrección (→ FAILED, el promotor la corrige en el TPV)' : 'RECHAZAR DEFINITIVAMENTE (→ REJECTED, pérdida terminal)'} la venta de ${who}${sale.venue?.name ? ` en ${sale.venue.name}` : ''}. Confirma con el operador; luego vuelve a llamar con confirm:true.`,
        })
      }
      try {
        const result = await reviewOrgSaleVerification(scope.activeOrg, {
          saleVerificationId,
          reviewedById: scope.staffId,
          decision: DECISION_MAP[decision],
          rejectionReasons,
          reviewNotes,
        })
        await auditMcpWrite(scope, {
          action: 'SALE_VERIFICATION_REVIEWED_VIA_MCP',
          entity: 'SaleVerification',
          entityId: saleVerificationId,
          venueId: sale.venueId,
          data: { decision: DECISION_MAP[decision], rejectionReasons: rejectionReasons ?? [], reviewNotes: reviewNotes ?? null },
        })
        return text({
          ok: true,
          saleVerificationId,
          decision: DECISION_MAP[decision],
          status: (result as { status?: string })?.status ?? null,
        })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'reopen_sale_verification',
    'Reopen an APPROVED (COMPLETED) sale verification — revert it to PENDING so the back-office can re-evaluate it. Only COMPLETED sales can be reopened. The SIM stays SOLD and no money moves — this only changes the documentation-review state. reason is mandatory (≥5 chars). By DEFAULT this only PREVIEWS; call again with confirm:true. This WRITES — OWNER-only (requires sale-verifications:reopen).',
    {
      saleVerificationId: z.string().min(1).describe('The verification id (must currently be COMPLETED)'),
      reason: z.string().min(5).describe('Why you are reopening it (min 5 chars) — recorded in the audit log'),
      confirm: z.boolean().optional().describe('Must be true to actually apply; without it you get a preview'),
    },
    async ({ saleVerificationId, reason, confirm }) => {
      requireOrgPermission('sale-verifications:reopen')
      const sale = await fetchSaleForPreview(saleVerificationId)
      if (!sale) return text({ ok: false, error: 'No encontré esa venta en tu organización.' })
      if (sale.status !== 'COMPLETED') {
        return text({ ok: false, error: `Solo se pueden reabrir ventas COMPLETED (esta está en estado ${sale.status}).` })
      }
      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          change: { saleVerificationId, from: 'COMPLETED', to: 'PENDING' },
          message: `Vas a REABRIR (→ PENDING) la venta ${saleVerificationId}. El SIM sigue vendido y no se mueve dinero. Confirma con el operador; luego vuelve a llamar con confirm:true.`,
        })
      }
      try {
        const result = await reopenOrgSaleVerification(scope.activeOrg, { saleVerificationId, reopenedById: scope.staffId, reason })
        await auditMcpWrite(scope, {
          action: 'SALE_VERIFICATION_REOPENED_VIA_MCP',
          entity: 'SaleVerification',
          entityId: saleVerificationId,
          venueId: sale.venueId,
          data: { reason },
        })
        return text({ ok: true, saleVerificationId, status: (result as { status?: string })?.status ?? 'PENDING' })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'edit_sale_verification',
    "Correct a sale verification (OWNER back-office fix): amount (PESOS), paymentForm (CASH/CARD/OTHER), isPortabilidad, and/or status (PENDING/COMPLETED/FAILED/REJECTED). reason is mandatory (≥5 chars). Does NOT recompute commissions. ⚠️ Changing status AWAY from COMPLETED can claw back the promoter's Cash Out commission on the next reconciliation. By DEFAULT this only PREVIEWS; call again with confirm:true. This WRITES — OWNER-only (requires sale-verifications:edit).",
    {
      saleVerificationId: z.string().min(1).describe('The verification id'),
      amount: z.number().min(0).optional().describe('New amount in PESOS (major units), e.g. 250'),
      paymentForm: z.enum(['CASH', 'CARD', 'OTHER']).optional().describe('Forma de pago'),
      isPortabilidad: z.boolean().optional().describe('true = portabilidad; false = línea nueva'),
      status: z.enum(['PENDING', 'COMPLETED', 'FAILED', 'REJECTED']).optional().describe('New verification status'),
      reason: z.string().min(5).describe('Why (min 5 chars) — recorded in the activity log'),
      confirm: z.boolean().optional().describe('Must be true to actually apply; without it you get a preview'),
    },
    async ({ saleVerificationId, amount, paymentForm, isPortabilidad, status, reason, confirm }) => {
      requireOrgPermission('sale-verifications:edit')
      const sale = await fetchSaleForPreview(saleVerificationId)
      if (!sale) return text({ ok: false, error: 'No encontré esa venta en tu organización.' })
      if (amount === undefined && paymentForm === undefined && isPortabilidad === undefined && status === undefined) {
        return text({ ok: false, error: 'Indica al menos un campo a cambiar (amount, paymentForm, isPortabilidad o status).' })
      }
      if (!confirm) {
        const willClawback = status != null && status !== 'COMPLETED' && sale.status === 'COMPLETED'
        return text({
          ok: false,
          requiresConfirmation: true,
          change: {
            saleVerificationId,
            from: { status: sale.status, isPortabilidad: sale.isPortabilidad, amount: sale.payment ? Number(sale.payment.amount) : null },
            to: { amount, paymentForm, isPortabilidad, status },
          },
          message: `Vas a EDITAR la venta ${saleVerificationId}.${willClawback ? ' ⚠️ Cambiar el estado fuera de COMPLETED hará clawback de la comisión Cash Out del promotor en la próxima reconciliación.' : ''} Confirma con el operador; luego vuelve a llamar con confirm:true.`,
        })
      }
      try {
        const result = await editOrgSaleVerification(scope.activeOrg, {
          saleVerificationId,
          editedById: scope.staffId,
          amount,
          paymentForm,
          isPortabilidad,
          status,
          reason,
        })
        await auditMcpWrite(scope, {
          action: 'SALE_VERIFICATION_EDITED_VIA_MCP',
          entity: 'SaleVerification',
          entityId: saleVerificationId,
          venueId: sale.venueId,
          data: { amount, paymentForm, isPortabilidad, status, reason },
        })
        return text({
          ok: true,
          saleVerificationId,
          updated: { amount, paymentForm, isPortabilidad, status },
          status: (result as { status?: string })?.status ?? null,
        })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}
