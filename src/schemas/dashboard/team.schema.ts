import { z } from 'zod'
import { StaffRole } from '@prisma/client'
import { PIN_ERROR_MESSAGE, PIN_REGEX, optionalClearablePinSchema } from '../common/pin.schema'

// Helper: Accept CUID, CUID2, and UUID formats (for legacy data compatibility)
// CUID: starts with 'c', 25 chars total
// CUID2: starts with 'c', variable length (typically 21-25 chars)
// UUID: standard format with dashes
const cuidOrUuid = z
  .string()
  .refine(val => /^c[a-z0-9]{19,}$/.test(val) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val), {
    message: 'El ID no es válido',
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
    positionId: z.string().cuid('Puesto inválido').optional(),
  }),
})

// Body schemas
export const InviteTeamMemberSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
  }),
  body: z
    .object({
      email: z.string().email('El correo no es válido').optional(),
      firstName: z.string().min(1, 'El nombre es obligatorio').max(50, 'El nombre admite hasta 50 caracteres'),
      lastName: z.string().min(1, 'El apellido es obligatorio').max(50, 'El apellido admite hasta 50 caracteres'),
      role: z.nativeEnum(StaffRole).refine(role => role !== StaffRole.SUPERADMIN, 'No puedes invitar a alguien como superadministrador'),
      message: z.string().max(500, 'El mensaje admite hasta 500 caracteres').optional(),
      type: z.enum(['email', 'tpv-only']).optional().default('email'),
      pin: z.string().regex(PIN_REGEX, PIN_ERROR_MESSAGE).optional(),
      // When true and role is OWNER, creates StaffVenue for all organization venues
      inviteToAllVenues: z.boolean().optional(),
      // When true, PIN is required when accepting the invitation
      requirePin: z.boolean().optional(),
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
        message: 'Para invitar por correo escribe el correo, y para una invitación sólo de TPV escribe el PIN',
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
        .refine(role => role !== StaffRole.SUPERADMIN, 'No puedes asignar el rol de superadministrador')
        .optional(),
      active: z.boolean().optional(),
      // Rango compartido: ver src/schemas/common/pin.schema.ts. Aquí decía 4-6
      // mientras el resto ya era 4-10, así que esta pantalla —la que los venues
      // usan para alargar el PIN de su gerente— rechazaba los códigos largos.
      pin: optionalClearablePinSchema,
    })
    .refine(data => Object.keys(data).length > 0, 'Cambia al menos un dato del miembro del equipo'),
})

// Type exports for TypeScript usage
export type InviteTeamMemberDTO = z.infer<typeof InviteTeamMemberSchema>['body']
export type UpdateTeamMemberDTO = z.infer<typeof UpdateTeamMemberSchema>['body']
export type TeamMembersQueryDTO = z.infer<typeof TeamMembersQuerySchema>['query']
