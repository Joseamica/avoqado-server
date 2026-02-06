import { z } from 'zod'

// Schema for validating invitation token in URL params
export const InvitationTokenParamsSchema = z.object({
  params: z.object({
    token: z.string().cuid('Formato de token de invitación inválido'),
  }),
})

// Schema for accepting an invitation
export const AcceptInvitationSchema = z.object({
  params: z.object({
    token: z.string().cuid('Formato de token de invitación inválido'),
  }),
  body: z.object({
    // Optional for existing users (already have account); required for new users (validated in service)
    firstName: z.string().min(1).max(50, 'El nombre debe tener máximo 50 caracteres').optional(),
    lastName: z.string().min(1).max(50, 'El apellido debe tener máximo 50 caracteres').optional(),
    // Password format is validated in the service layer only for NEW accounts.
    // Existing users send their current password for verification (bcrypt compare),
    // so we must not enforce format rules here — their legacy password may not comply.
    password: z.string().min(1, 'La contraseña es requerida').optional(),
    pin: z
      .string()
      .regex(/^\d{4,10}$/, 'El PIN debe tener entre 4 y 10 dígitos')
      .optional()
      .nullable(),
  }),
})

export type InvitationTokenParams = z.infer<typeof InvitationTokenParamsSchema>
export type AcceptInvitationRequest = z.infer<typeof AcceptInvitationSchema>
