import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { hasPermission } from '@/services/access/access.service'
import type { McpScope } from '../scope'
import { ScopeError } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { createOneManualSale } from '@/services/dashboard/manualSale.service'
import type { ManualSaleRowInput } from '@/schemas/dashboard/manualSale.schema'

/**
 * record_serialized_sale — single-row version of "Subir ventas fuera de TPV"
 * (Task 4's `createOneManualSale`), exposed through the customer MCP so an
 * operator can record ONE external SIM sale (already documentation-approved
 * offline — PlayTelecom / Walmart) by conversation, without the bulk upload
 * flow. Confirm-gated like every money/inventory-affecting MCP write: it
 * both creates a paid Order + Payment AND flips a SerializedItem to SOLD.
 *
 * ORG-level write, not per-venue: the caller does not pre-select a venueId —
 * `createOneManualSale` resolves `storeName` against the org's own venues
 * internally (see `manualSale.resolvers.ts`). So this mirrors
 * `saleVerifications.ts`'s `requireReviewAccess()` pattern (any venue in the
 * connected staff's ACTIVE org that grants the permission) rather than
 * `guard.venueFilter(venueId)` + `guard.requirePermission(perm, venueId)`,
 * which both assume a single pre-known venue.
 */
export function registerManualSaleTools(server: McpServer, scope: McpScope) {
  /** Same shape as saleVerifications.ts's requireReviewAccess: gate on the ACTIVE org, any venue. */
  function requireManualSaleAccess(): void {
    for (const access of scope.perVenueAccess.values()) {
      if (access.organizationId === scope.activeOrg && hasPermission(access, 'manual-sales:create')) return
    }
    throw new ScopeError('Missing permission manual-sales:create in this organization')
  }

  server.tool(
    'record_serialized_sale',
    'Record ONE SIM sale made OUTSIDE the TPV (PlayTelecom / Walmart external sale, already documentation-approved offline) — creates a paid order + payment and flips the SIM (by ICCID) to SOLD in a single step. This is the single-sale sibling of the dashboard\'s bulk "Subir ventas fuera de TPV" upload. Identify the SIM by iccid, the seller by promoterCode OR promoterName (at least one), and the store by storeName (must match a venue in your org). saleDate is the venue-local calendar day (YYYY-MM-DD). amount is in PESOS (e.g. 250.00), never cents. By DEFAULT this only PREVIEWS the sale; call again with confirm:true to actually record it. This WRITES — requires manual-sales:create in your organization.',
    {
      iccid: z.string().min(5).describe('ICCID printed/encoded on the SIM being sold'),
      promoterCode: z.string().optional().describe("Seller's employee code. Provide this OR promoterName (at least one)"),
      promoterName: z.string().optional().describe("Seller's full name, used when promoterCode is not known"),
      storeName: z.string().min(1).describe('Store name — must match a venue in your organization (e.g. "BAE Unidad Pavón (898)")'),
      saleDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (usa AAAA-MM-DD)')
        .describe('Venue-local calendar day the sale happened, YYYY-MM-DD'),
      saleType: z.string().min(1).describe('Sale type, e.g. "Línea nueva" or "Portabilidad"'),
      paymentForm: z.string().min(1).describe('How it was paid, e.g. "Efectivo", "Tarjeta", "No aplica"'),
      amount: z.union([z.number(), z.string()]).describe('Sale amount in PESOS (major units), e.g. 250.00 — never cents'),
      simType: z.string().optional().describe("SIM type/category label; falls back to the SIM's existing category if omitted"),
      confirm: z.boolean().optional().describe('Must be true to actually record the sale; without it you get a preview'),
    },
    async ({ iccid, promoterCode, promoterName, storeName, saleDate, saleType, paymentForm, amount, simType, confirm }) => {
      requireManualSaleAccess() // throws ScopeError if no venue in the active org grants manual-sales:create

      if (!promoterCode && !promoterName) {
        return text({ ok: false, error: 'Necesito promoterCode o promoterName para identificar al vendedor.' })
      }

      const seller = promoterName ?? promoterCode
      const amountLabel = typeof amount === 'number' ? amount.toFixed(2) : amount

      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          change: { iccid, seller, storeName, saleDate, amount: amountLabel },
          message: `Voy a registrar la venta del SIM ${iccid} de ${seller} en ${storeName} por $${amountLabel}. Vuelve a llamar con confirm:true para confirmar.`,
        })
      }

      const row: ManualSaleRowInput = {
        iccid,
        promoterCode,
        promoterName,
        storeName,
        saleDate,
        saleType,
        paymentForm,
        amount,
        simType,
      }

      const result = await createOneManualSale(scope.activeOrg, scope.staffId, row)
      if (!result.ok) {
        return text({ ok: false, error: result.error })
      }

      await auditMcpWrite(scope, {
        action: 'MANUAL_SALE_RECORDED_VIA_MCP',
        entity: 'Order',
        entityId: result.orderId,
        venueId: result.venueId,
        data: { iccid, seller, storeName, saleDate, amount: amountLabel },
      })

      return text({
        ok: true,
        orderId: result.orderId,
        verificationId: result.verificationId,
        venueId: result.venueId,
        message: `Venta registrada: SIM ${iccid} vendido por ${seller} en ${storeName}.`,
      })
    },
  )
}
