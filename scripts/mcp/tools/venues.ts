import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { prisma, text } from '../context'

export function registerVenueTools(server: McpServer) {
  server.tool(
    'list_venues',
    'List venues, optionally filtered by a name substring or organization id. Returns id, name, slug, status, organization, city. Use this first to resolve the venueId that other tools need.',
    {
      query: z.string().optional().describe('Case-insensitive substring to match against venue name'),
      organizationId: z.string().optional().describe('Filter to one organization'),
      limit: z.number().int().min(1).max(200).default(50).describe('Max venues to return'),
    },
    async ({ query, organizationId, limit }) => {
      const venues = await prisma.venue.findMany({
        where: {
          ...(organizationId ? { organizationId } : {}),
          ...(query ? { name: { contains: query, mode: 'insensitive' } } : {}),
        },
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          active: true,
          city: true,
          timezone: true,
          organization: { select: { id: true, name: true } },
        },
        orderBy: { name: 'asc' },
        take: limit,
      })
      return text({ count: venues.length, venues })
    },
  )

  server.tool(
    'list_orgs',
    'List organizations, optionally filtered by a name substring. Returns id, name, slug, plus venue count. Use to resolve an organizationId.',
    {
      query: z.string().optional().describe('Case-insensitive substring to match against org name'),
      limit: z.number().int().min(1).max(200).default(50).describe('Max orgs to return'),
    },
    async ({ query, limit }) => {
      const orgs = await prisma.organization.findMany({
        where: query ? { name: { contains: query, mode: 'insensitive' } } : {},
        select: {
          id: true,
          name: true,
          slug: true,
          _count: { select: { venues: true } },
        },
        orderBy: { name: 'asc' },
        take: limit,
      })
      return text({ count: orgs.length, orgs })
    },
  )
}
