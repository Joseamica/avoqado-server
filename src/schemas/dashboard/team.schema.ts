import { z } from 'zod'
import { StaffRole } from '@prisma/client'

// Helper: Accept CUID, CUID2, and UUID formats (for legacy data compatibility)
// CUID: starts with 'c', 25 chars total
// CUID2: starts with 'c', variable length (typically 21-25 chars)
// UUID: standard format with dashes
const cuidOrUuid = z
  .string()
  .refine(val => /^c[a-z0-9]{19,}$/.test(val) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val), {
    message: 'Invalid id format (must be CUID, CUID2, or UUID)',
  })

// Parameter schemas
export const VenueIdParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
  }),
})

export const TeamMemberParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    teamMemberId: cuidOrUuid, // Accept both CUID and UUID for legacy compatibility
  }),
})

export const InvitationParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    invitationId: z.string().cuid(),
  }),
})

// Query schemas
export const TeamMembersQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(10),
    search: z.string().optional(),
  }),
})

// Body schemas
export const InviteTeamMemberSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
  }),
  body: z
    .object({
      email: z.string().email('Invalid email format').optional(),
      firstName: z.string().min(1, 'First name is required').max(50, 'First name too long'),
      lastName: z.string().min(1, 'Last name is required').max(50, 'Last name too long'),
      role: z.nativeEnum(StaffRole).refine(role => role !== StaffRole.SUPERADMIN, 'Cannot invite SUPERADMIN role'),
      message: z.string().max(500, 'Message too long').optional(),
      type: z.enum(['email', 'tpv-only']).optional().default('email'),
      pin: z
        .string()
        .regex(/^\d{4,10}$/, 'PIN must be 4-10 digits')
        .optional(),
      // When true and role is OWNER, creates StaffVenue for all organization venues
      inviteToAllVenues: z.boolean().optional(),
    })
    .refine(
      data => {
        // If type is 'email' (or not specified), email is required
        if (data.type === 'email' || !data.type) {
          return !!data.email
        }
        // If type is 'tpv-only', pin is required
        if (data.type === 'tpv-only') {
          return !!data.pin
        }
        return true
      },
      {
        message: 'Email is required for email invitations, PIN is required for TPV-only',
        path: ['email'],
      },
    ),
})

export const UpdateTeamMemberSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    teamMemberId: cuidOrUuid, // Accept both CUID and UUID for legacy compatibility
  }),
  body: z
    .object({
      role: z
        .nativeEnum(StaffRole)
        .refine(role => role !== StaffRole.SUPERADMIN, 'Cannot assign SUPERADMIN role')
        .optional(),
      active: z.boolean().optional(),
      pin: z.union([z.string().regex(/^\d{4,6}$/, 'PIN must be 4-6 digits'), z.literal(''), z.null()]).optional(),
    })
    .refine(data => Object.keys(data).length > 0, 'At least one field is required for update'),
})

// Type exports for TypeScript usage
export type InviteTeamMemberDTO = z.infer<typeof InviteTeamMemberSchema>['body']
export type UpdateTeamMemberDTO = z.infer<typeof UpdateTeamMemberSchema>['body']
export type TeamMembersQueryDTO = z.infer<typeof TeamMembersQuerySchema>['query']
