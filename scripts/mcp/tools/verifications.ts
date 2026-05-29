import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { prisma, text } from '../context'
import { resolveActor, confirmGuard } from '../writes'
import { reopenOrgSaleVerification } from '@/services/dashboard/sale-verification.org.dashboard.service'

export function registerVerificationTools(server: McpServer) {
  server.tool(
    'find_verifications',
    'Search sale verifications for a venue (optionally by status). Returns id, status, paymentId, staffId, photo count, createdAt. Use this to get the saleVerificationId for reopen_verification.',
    {
      venueId: z.string().describe('Venue id (use list_venues to resolve)'),
      status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'SKIPPED']).optional().describe('Filter by status'),
      limit: z.number().int().min(1).max(100).default(25).describe('Max rows'),
    },
    async ({ venueId, status, limit }) => {
      const rows = await prisma.saleVerification.findMany({
        where: { venueId, ...(status ? { status } : {}) },
        select: { id: true, status: true, paymentId: true, staffId: true, photos: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })
      return text({
        count: rows.length,
        verifications: rows.map(r => ({ ...r, photoCount: r.photos.length, photos: undefined })),
      })
    },
  )

  server.tool(
    'reopen_verification',
    'Reopen a COMPLETED sale verification (sets it back to PENDING) for re-review. Wraps the safe service: it does NOT touch Payment/Order/SerializedItem, requires a reason, and only works on COMPLETED verifications whose venue org has SERIALIZED_INVENTORY. PREVIEW unless confirm:true.',
    {
      saleVerificationId: z.string().describe('Verification id (from find_verifications)'),
      reason: z.string().min(5).describe('Why you are reopening (min 5 chars; recorded for audit)'),
      performedBy: z.string().optional().describe('Acting staff id; defaults to MCP_ADMIN_STAFF_ID'),
      confirm: z.boolean().default(false).describe('false = preview only; true = execute'),
    },
    async ({ saleVerificationId, reason, performedBy, confirm }) => {
      const actor = resolveActor(performedBy)
      const existing = await prisma.saleVerification.findUnique({
        where: { id: saleVerificationId },
        select: {
          id: true,
          status: true,
          venueId: true,
          paymentId: true,
          venue: { select: { name: true, organizationId: true } },
        },
      })
      if (!existing) return text({ error: `Sale verification ${saleVerificationId} not found` })
      const orgId = existing.venue?.organizationId
      if (!orgId) return text({ error: `Verification ${saleVerificationId} has no organization` })

      return confirmGuard({
        tool: 'reopen_verification',
        actor,
        confirm,
        args: { saleVerificationId, reason },
        preview: {
          verification: saleVerificationId,
          venue: existing.venue?.name,
          paymentId: existing.paymentId,
          statusChange: `${existing.status} → PENDING`,
          guard: 'service rejects unless current status is COMPLETED and the venue org has SERIALIZED_INVENTORY',
        },
        execute: () => reopenOrgSaleVerification(orgId, { saleVerificationId, reopenedById: actor, reason }),
      })
    },
  )
}
