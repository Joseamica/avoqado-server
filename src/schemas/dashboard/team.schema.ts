import { z } from 'zod'
import { StaffRole } from '@prisma/client'

// Parameter schemas
export const VenueIdParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
  }),
})

export const TeamMemberParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    teamMemberId: z.string().cuid(),
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
  body: z.object({
    email: z.string().email('Invalid email format'),
    firstName: z.string().min(1, 'First name is required').max(50, 'First name too long'),
    lastName: z.string().min(1, 'Last name is required').max(50, 'Last name too long'),
    role: z.nativeEnum(StaffRole).refine(role => role !== StaffRole.SUPERADMIN, 'Cannot invite SUPERADMIN role'),
    message: z.string().max(500, 'Message too long').optional(),
  }),
})

export const UpdateTeamMemberSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    teamMemberId: z.string().cuid(),
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
