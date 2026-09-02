import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { getActiveCommercialCatalog } from '@/services/commercial/commercialRead.service'
import type { CommercialCatalogPriceV1, CommercialCatalogSnapshotV1 } from '@/types/commercial'
import type { CommercialQuoteV1 } from '@/types/commercialQuote'
import { commercialQuoteAuthorityService } from '@/services/commercial/commercialQuoteAuthority.service'
import { CommercialCatalogAuthorityError, readVerifiedActiveCatalog } from '@/services/commercial/commercialCatalogAuthority.service'
import { CommercialArtifactCodecError } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { CommercialCatalogFallbackError } from '@/services/commercial/commercialCatalogFallback.service'
import { getCommercialManualSpeiCase, listCommercialManualSpeiCases } from '@/services/commercial/billing/manualSpeiRead.service'
import {
  getCommercialBillingDashboardOverview,
  listCommercialBillingDashboardReceipts,
} from '@/services/commercial/billing/commercialBillingDashboardRead.service'

export type CommercialMcpActiveVersion = 'MISSING' | 'ACTIVE_V1' | 'ACTIVE_V2' | 'UNSUPPORTED'

export interface CommercialMcpDependencies {
  getActiveCatalog: typeof getActiveCommercialCatalog
  previewQuote: typeof commercialQuoteAuthorityService.previewQuote
  resolveActiveVersion(): Promise<CommercialMcpActiveVersion>
  listManualSpeiCases: typeof listCommercialManualSpeiCases
  getManualSpeiCase: typeof getCommercialManualSpeiCase
  getBillingOverview: typeof getCommercialBillingDashboardOverview
  listBillingReceipts: typeof listCommercialBillingDashboardReceipts
}

export async function resolveCommercialMcpActiveVersion(): Promise<CommercialMcpActiveVersion> {
  try {
    const decision = await readVerifiedActiveCatalog()
    if (!decision) return 'MISSING'
    if (decision.fallback) return 'UNSUPPORTED'
    return decision.catalog.schemaVersion === 1 ? 'ACTIVE_V1' : 'ACTIVE_V2'
  } catch (error) {
    if (
      error instanceof CommercialCatalogAuthorityError ||
      error instanceof CommercialArtifactCodecError ||
      error instanceof CommercialCatalogFallbackError
    ) {
      return 'UNSUPPORTED'
    }
    throw error
  }
}

const commercialMcpDependencies: CommercialMcpDependencies = {
  getActiveCatalog: () => getActiveCommercialCatalog(),
  previewQuote: input => commercialQuoteAuthorityService.previewQuote(input),
  resolveActiveVersion: resolveCommercialMcpActiveVersion,
  listManualSpeiCases: input => listCommercialManualSpeiCases(input),
  getManualSpeiCase: caseId => getCommercialManualSpeiCase(caseId),
  getBillingOverview: input => getCommercialBillingDashboardOverview(input),
  listBillingReceipts: input => listCommercialBillingDashboardReceipts(input),
}

function isKnownCommercialAuthorityError(error: unknown): boolean {
  return (
    error instanceof CommercialCatalogAuthorityError ||
    error instanceof CommercialArtifactCodecError ||
    error instanceof CommercialCatalogFallbackError
  )
}

function commercialMcpCatalogDisabled() {
  return text({
    ok: false,
    code: 'COMMERCIAL_MCP_V2_NOT_ENABLED',
    message: 'El catálogo comercial del MCP todavía no está habilitado para esta versión.',
  })
}

function projectPriceToMajorMxn(price: CommercialCatalogPriceV1) {
  const { amountMinor, ...safePrice } = price
  return { ...safePrice, amountMxn: amountMinor / 100 }
}

/** The REST contract stores integer minor units; every customer-MCP response uses major pesos. */
export function projectCommercialCatalogForMcp(snapshot: CommercialCatalogSnapshotV1) {
  return {
    ...snapshot,
    products: snapshot.products.map(product => ({
      ...product,
      prices: product.prices.map(projectPriceToMajorMxn),
    })),
    bundles: snapshot.bundles.map(bundle => ({
      ...bundle,
      prices: bundle.prices.map(projectPriceToMajorMxn),
    })),
  }
}

/** REST/contract money is minor units; customer MCP always emits major MXN. */
export function projectCommercialQuoteForMcp(quote: CommercialQuoteV1) {
  const mxn = (minor: number) => minor / 100
  return {
    ...quote,
    lines: quote.lines.map(line => {
      const {
        unitAmountMinor,
        listSubtotalMinor,
        discountMinor,
        subtotalMinor,
        taxMinor,
        totalMinor,
        renewalSubtotalMinor,
        renewalTaxMinor,
        renewalTotalMinor,
        ...safeLine
      } = line
      return {
        ...safeLine,
        adjustments: line.adjustments.map(adjustment => {
          const { beforeMinor, afterMinor, discountMinor: adjustmentDiscountMinor, ...safeAdjustment } = adjustment
          return {
            ...safeAdjustment,
            beforeMxn: mxn(beforeMinor),
            afterMxn: mxn(afterMinor),
            discountMxn: mxn(adjustmentDiscountMinor),
          }
        }),
        unitAmountMxn: mxn(unitAmountMinor),
        listSubtotalMxn: mxn(listSubtotalMinor),
        discountMxn: mxn(discountMinor),
        subtotalMxn: mxn(subtotalMinor),
        taxMxn: mxn(taxMinor),
        totalMxn: mxn(totalMinor),
        renewalSubtotalMxn: mxn(renewalSubtotalMinor),
        renewalTaxMxn: mxn(renewalTaxMinor),
        renewalTotalMxn: mxn(renewalTotalMinor),
      }
    }),
    totals: {
      listSubtotalMxn: mxn(quote.totals.listSubtotalMinor),
      discountMxn: mxn(quote.totals.discountMinor),
      subtotalMxn: mxn(quote.totals.subtotalMinor),
      taxMxn: mxn(quote.totals.taxMinor),
      totalMxn: mxn(quote.totals.totalMinor),
    },
    renewal: {
      subtotalMxn: mxn(quote.renewal.subtotalMinor),
      taxMxn: mxn(quote.renewal.taxMinor),
      totalMxn: mxn(quote.renewal.totalMinor),
    },
  }
}

function projectManualSpeiMoneyForMcp<T extends { observedAmountMinor: string }>(row: T) {
  const { observedAmountMinor, ...safeRow } = row
  const minor = BigInt(observedAmountMinor)
  return {
    ...safeRow,
    observedAmountMxn: `${minor / 100n}.${(minor % 100n).toString().padStart(2, '0')}`,
  }
}

function exactMinorToMajorMxn(value: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('COMMERCIAL_MCP_MONEY_INVALID')
  const minor = BigInt(value)
  return `${minor / 100n}.${(minor % 100n).toString().padStart(2, '0')}`
}

/** Preserve arbitrary-size commercial money without crossing JavaScript's Number boundary. */
export function projectCommercialBillingMoneyForMcp(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectCommercialBillingMoneyForMcp)
  if (value instanceof Date || value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (key.endsWith('Minor')) {
        if (typeof item !== 'string') throw new Error('COMMERCIAL_MCP_MONEY_INVALID')
        return [`${key.slice(0, -'Minor'.length)}Mxn`, exactMinorToMajorMxn(item)]
      }
      return [key, projectCommercialBillingMoneyForMcp(item)]
    }),
  )
}

/**
 * Public-safe, read-only description of Avoqado's current SaaS offer. It has no
 * venue filter because it represents the same publication exposed publicly.
 * REST keeps integer minor units for its cross-platform contract; MCP projects
 * those amounts to major MXN units, as required by the customer-MCP invariant.
 */
export function registerCommercialTools(server: McpServer, scope: McpScope, overrides: Partial<CommercialMcpDependencies> = {}): void {
  const dependencies = { ...commercialMcpDependencies, ...overrides }
  const guard = createGuard(scope)
  server.tool(
    'commercial_catalog',
    'Read Avoqado’s active Mexico software catalog: packages, POS, modules, billing units, prices before IVA and capability codes. This tool is read-only and never publishes, activates, discounts or starts checkout.',
    {},
    async () => {
      const activeVersion = await dependencies.resolveActiveVersion()
      if (activeVersion === 'MISSING') {
        return text({
          active: false,
          code: 'COMMERCIAL_CATALOG_NOT_ACTIVE',
          message: 'El catálogo comercial todavía no está activo.',
        })
      }
      if (activeVersion !== 'ACTIVE_V1') {
        return commercialMcpCatalogDisabled()
      }
      let catalog: Awaited<ReturnType<CommercialMcpDependencies['getActiveCatalog']>>
      try {
        catalog = await dependencies.getActiveCatalog()
      } catch (error) {
        if (isKnownCommercialAuthorityError(error)) return commercialMcpCatalogDisabled()
        throw error
      }
      if (!catalog) {
        return text({
          active: false,
          code: 'COMMERCIAL_CATALOG_NOT_ACTIVE',
          message: 'El catálogo comercial todavía no está activo.',
        })
      }
      if (catalog.snapshot.schemaVersion !== 1) {
        return commercialMcpCatalogDisabled()
      }
      return text({ active: true, etag: catalog.etag, catalog: projectCommercialCatalogForMcp(catalog.snapshot) })
    },
  )

  server.tool(
    'commercial_quote_preview',
    'Preview an exact Avoqado SaaS quote in MXN before IVA, IVA, total today, promotional duration and renewal. It is read-only: it never accepts a quote or starts Stripe. Campaign pricing is honored only through an opaque acquisitionToken previously issued by Server; campaign codes, UTMs and browser amounts cannot authorize a discount.',
    {
      acquisitionToken: z
        .string()
        .min(43)
        .max(128)
        .optional()
        .describe('Opaque Server-issued acquisition token, when the customer came from a valid campaign'),
      lines: z
        .array(
          z.object({
            targetType: z.enum(['PRODUCT', 'BUNDLE']),
            targetCode: z.string(),
            priceCode: z.string(),
            quantity: z.number().int().min(1).max(1000),
          }),
        )
        .min(1)
        .max(50),
    },
    async ({ acquisitionToken, lines }) => {
      const activeVersion = await dependencies.resolveActiveVersion()
      if (activeVersion === 'MISSING') {
        return text({
          ok: false,
          code: 'COMMERCIAL_CATALOG_NOT_ACTIVE',
          message: 'El catálogo comercial todavía no está activo.',
        })
      }
      if (activeVersion !== 'ACTIVE_V1') {
        return text({
          ok: false,
          code: 'COMMERCIAL_MCP_V2_NOT_ENABLED',
          message: 'La vista previa comercial del MCP todavía no está habilitada para esta versión del catálogo.',
        })
      }
      const result = await dependencies.previewQuote({
        market: 'MX',
        currency: 'MXN',
        ...(acquisitionToken ? { acquisitionToken } : {}),
        lines,
      })
      return text({ quote: projectCommercialQuoteForMcp(result.quote) })
    },
  )

  server.tool(
    'commercial_billing_overview',
    'Read the accepted Avoqado commercial subscription, exact current and renewal totals, collection state, outstanding obligations and recent receipts for one venue. Read-only: it cannot accept offers, retry payments, upload evidence or alter a subscription.',
    {
      venueId: z.string().min(1).max(128).describe('Venue to read; it must belong to this connection and allow subscription billing reads'),
    },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('billing:subscriptions:read', venueId)
      const organizationId = scope.perVenueAccess.get(venueId)?.organizationId
      if (!organizationId) throw new Error('COMMERCIAL_MCP_ORGANIZATION_SCOPE_MISSING')
      const result = await dependencies.getBillingOverview({ organizationId, venueId })
      return text(projectCommercialBillingMoneyForMcp(result))
    },
  )

  server.tool(
    'commercial_billing_receipts',
    'List a bounded page of reconciled commercial subscription receipts for one venue, newest first. Read-only and cursor-paginated; it never exposes bank evidence or payment credentials.',
    {
      venueId: z.string().min(1).max(128).describe('Venue to read; it must belong to this connection and allow billing history reads'),
      cursor: z.string().min(1).max(191).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async ({ venueId, cursor, limit }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('billing:history:read', venueId)
      const organizationId = scope.perVenueAccess.get(venueId)?.organizationId
      if (!organizationId) throw new Error('COMMERCIAL_MCP_ORGANIZATION_SCOPE_MISSING')
      const result = await dependencies.listBillingReceipts({
        organizationId,
        venueId,
        ...(cursor ? { cursor } : {}),
        ...(limit ? { limit } : {}),
      })
      return text(projectCommercialBillingMoneyForMcp(result))
    },
  )

  if (scope.isSuperAdmin) {
    server.tool(
      'commercial_manual_spei_cases',
      'Lista casos de conciliación SPEI manual para revisión de plataforma. Solo lectura: no acepta evidencia, no aprueba depósitos y no crea recibos de efectivo.',
      {
        organizationId: z.string().min(1).max(128).optional(),
        venueId: z.string().min(1).max(128).optional(),
        status: z.enum(['PENDING_REVIEW', 'AWAITING_APPROVAL', 'READY_TO_RECONCILE', 'RECONCILED', 'REJECTED']).optional(),
        cursor: z.string().min(1).max(128).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      async input => {
        const result = await dependencies.listManualSpeiCases(input)
        return text({
          items: result.items.map(projectManualSpeiMoneyForMcp),
          nextCursor: result.nextCursor,
        })
      },
    )

    server.tool(
      'commercial_manual_spei_case',
      'Lee el expediente y las firmas de un caso SPEI manual. No entrega la ruta privada del comprobante y no puede modificar ni conciliar dinero.',
      { caseId: z.string().min(1).max(128) },
      async ({ caseId }) => {
        const result = await dependencies.getManualSpeiCase(caseId)
        if (!result) {
          return text({ ok: false, code: 'COMMERCIAL_MANUAL_SPEI_CASE_NOT_FOUND' })
        }
        return text({ ok: true, case: projectManualSpeiMoneyForMcp(result) })
      },
    )
  }
}
