import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { prisma, text } from '../context'
import { resolveActor, confirmGuard } from '../writes'
import { bulkCreateVenues } from '@/services/superadmin/bulkVenueCreation.service'
import { createMerchantAccount } from '@/services/superadmin/merchantAccount.service'
import { generateAPIKeys } from '@/middlewares/sdk-auth.middleware'

export function registerCreateTools(server: McpServer) {
  // ── helper read: resolve a payment provider id ───────────────────────────
  server.tool(
    'list_payment_providers',
    'List payment providers (id, code, name, active). Use to resolve the providerId needed by create_merchant_account and create_ecommerce_merchant.',
    {},
    async () => {
      const providers = await prisma.paymentProvider.findMany({
        select: { id: true, code: true, name: true, active: true },
        orderBy: { code: 'asc' },
      })
      return text({ count: providers.length, providers })
    },
  )

  // ── create_venue (with KYC pre-approved) ──────────────────────────────────
  server.tool(
    'create_venue',
    'Create a venue in an organization. With kycApproved (default true) it is created already KYC-VERIFIED and status ACTIVE in one step (wraps bulkCreateVenues). Most fields inherit org defaults. PREVIEW unless confirm:true.',
    {
      organizationId: z.string().describe('Organization id (use list_orgs)'),
      name: z.string().min(1).describe('Venue name'),
      type: z.string().optional().describe('VenueType (e.g. RESTAURANT, RETAIL); defaults to org default'),
      city: z.string().optional(),
      state: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      rfc: z.string().optional().describe('Tax id (RFC)'),
      legalName: z.string().optional().describe('Razón social'),
      kycApproved: z.boolean().default(true).describe('true = create already VERIFIED + ACTIVE'),
      performedBy: z.string().optional().describe('Acting staff id; defaults to MCP_ADMIN_STAFF_ID'),
      confirm: z.boolean().default(false).describe('false = preview only; true = execute'),
    },
    async ({ organizationId, name, type, city, state, email, phone, rfc, legalName, kycApproved, performedBy, confirm }) => {
      const actor = resolveActor(performedBy)
      const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } })
      if (!org) return text({ error: `Organization ${organizationId} not found (use list_orgs)` })

      const venueInput: Record<string, unknown> = { name, kycApproved }
      if (type) venueInput.type = type
      if (city) venueInput.city = city
      if (state) venueInput.state = state
      if (email) venueInput.email = email
      if (phone) venueInput.phone = phone
      if (rfc) venueInput.rfc = rfc
      if (legalName) venueInput.legalName = legalName

      return confirmGuard({
        tool: 'create_venue',
        actor,
        confirm,
        args: { organizationId, name, kycApproved },
        preview: {
          organization: org.name,
          venue: name,
          kyc: kycApproved ? 'will be created VERIFIED + status ACTIVE' : 'will be created in ONBOARDING (no KYC)',
          fields: venueInput,
        },
        execute: () => bulkCreateVenues({ organizationId, superadminStaffId: actor, venues: [venueInput as never] }),
      })
    },
  )

  // ── create_merchant_account (payment-routing merchant used by terminals) ──
  server.tool(
    'create_merchant_account',
    'Create a MerchantAccount (the payment-routing merchant terminals use: Blumon/Stripe/MercadoPago/AngelPay). Wraps createMerchantAccount, which enforces provider-specific rules (e.g. AngelPay needs an active account; Blumon serial). PREVIEW unless confirm:true.',
    {
      providerId: z.string().describe('Payment provider id (use list_payment_providers)'),
      externalMerchantId: z.string().describe("The provider's merchant id"),
      alias: z.string().optional(),
      displayName: z.string().optional(),
      venueId: z.string().optional().describe('Scope to a venue (required for AngelPay; enables device-compat check)'),
      blumonSerialNumber: z.string().optional(),
      blumonEnvironment: z.string().optional(),
      clabeNumber: z.string().optional().describe('Bank CLABE'),
      bankName: z.string().optional(),
      accountHolder: z.string().optional(),
      performedBy: z.string().optional().describe('Acting staff id; defaults to MCP_ADMIN_STAFF_ID'),
      confirm: z.boolean().default(false).describe('false = preview only; true = execute'),
    },
    async ({
      providerId,
      externalMerchantId,
      alias,
      displayName,
      venueId,
      blumonSerialNumber,
      blumonEnvironment,
      clabeNumber,
      bankName,
      accountHolder,
      performedBy,
      confirm,
    }) => {
      const actor = resolveActor(performedBy)
      const provider = await prisma.paymentProvider.findUnique({ where: { id: providerId }, select: { code: true, name: true } })
      if (!provider) return text({ error: `Provider ${providerId} not found (use list_payment_providers)` })

      const data = {
        providerId,
        externalMerchantId,
        alias,
        displayName,
        venueId,
        blumonSerialNumber,
        blumonEnvironment,
        clabeNumber,
        bankName,
        accountHolder,
      }

      return confirmGuard({
        tool: 'create_merchant_account',
        actor,
        confirm,
        args: { providerId, provider: provider.code, externalMerchantId, venueId },
        preview: {
          provider: `${provider.name} (${provider.code})`,
          externalMerchantId,
          scope: venueId ?? 'global (no venue)',
          note: 'service validates provider-specific rules (AngelPay active account, Blumon serial, device compatibility)',
        },
        execute: () => createMerchantAccount(data as never),
      })
    },
  )

  // ── create_ecommerce_merchant (SDK client with pk_/sk_ API keys) ──────────
  server.tool(
    'create_ecommerce_merchant',
    'Create an EcommerceMerchant (SDK / online-checkout client) for a venue and generate its API keys. The SECRET key (sk_) is returned ONCE and never retrievable again. Mirrors onboard-external-merchant.ts. PREVIEW unless confirm:true.',
    {
      venueId: z.string().describe('Venue id (use list_venues)'),
      businessName: z.string().min(1),
      contactEmail: z.string().describe('Must be unique across e-commerce merchants'),
      providerId: z.string().describe('Payment provider id (use list_payment_providers)'),
      channelName: z.string().optional().describe('Channel label (unique per venue)'),
      rfc: z.string().optional(),
      contactPhone: z.string().optional(),
      website: z.string().optional(),
      sandboxMode: z.boolean().default(true).describe('true = test keys (pk_test/sk_test); false = LIVE keys'),
      performedBy: z.string().optional().describe('Acting staff id; defaults to MCP_ADMIN_STAFF_ID'),
      confirm: z.boolean().default(false).describe('false = preview only; true = execute'),
    },
    async ({
      venueId,
      businessName,
      contactEmail,
      providerId,
      channelName,
      rfc,
      contactPhone,
      website,
      sandboxMode,
      performedBy,
      confirm,
    }) => {
      const actor = resolveActor(performedBy)
      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { name: true } })
      if (!venue) return text({ error: `Venue ${venueId} not found (use list_venues)` })
      const provider = await prisma.paymentProvider.findUnique({ where: { id: providerId }, select: { code: true, name: true } })
      if (!provider) return text({ error: `Provider ${providerId} not found (use list_payment_providers)` })

      return confirmGuard({
        tool: 'create_ecommerce_merchant',
        actor,
        confirm,
        args: { venueId, businessName, contactEmail, providerId, sandboxMode },
        // The secret key is masked in the audit log; the caller still receives it once.
        redact: r => ({ ...(r as object), secretKey: '*** (shown once in the tool result, never logged)' }),
        preview: {
          venue: venue.name,
          businessName,
          contactEmail,
          provider: provider.code,
          mode: sandboxMode ? 'test' : 'LIVE',
          note: 'generates pk_/sk_ API keys; the secret key is shown ONCE in the result and cannot be retrieved again',
        },
        execute: async () => {
          const keys = generateAPIKeys(sandboxMode)
          const merchant = await prisma.ecommerceMerchant.create({
            data: {
              venueId,
              channelName: channelName ?? null,
              businessName,
              rfc: rfc ?? null,
              contactEmail,
              contactPhone: contactPhone ?? null,
              website: website ?? null,
              publicKey: keys.publicKey,
              secretKeyHash: keys.secretKeyHash,
              providerId,
              providerCredentials: {},
              webhookEvents: ['payment.completed', 'payment.failed'],
              active: true,
              sandboxMode,
            },
            select: { id: true, businessName: true, publicKey: true, sandboxMode: true },
          })
          return {
            merchantId: merchant.id,
            businessName: merchant.businessName,
            publicKey: merchant.publicKey,
            secretKey: keys.secretKey,
            sandboxMode: merchant.sandboxMode,
            warning: 'Save the secretKey now — it is stored only as a hash and cannot be retrieved again.',
          }
        },
      })
    },
  )
}
