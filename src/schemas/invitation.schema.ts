import { z } from 'zod'

// Schema for validating invitation token in URL params
export const InvitationTokenParamsSchema = z.object({
  params: z.object({
    token: z.string().cuid('Invalid invitation token format'),
  }),
})

// Schema for accepting an invitation
export const AcceptInvitationSchema = z.object({
  params: z.object({
    token: z.string().cuid('Invalid invitation token format'),
  }),
  body: z.object({
    firstName: z
      .string()
      .min(1, 'First name is required')
      .max(50, 'First name must be at most 50 characters'),
    lastName: z
      .string()
      .min(1, 'Last name is required')
      .max(50, 'Last name must be at most 50 characters'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
        'Password must contain at least one lowercase letter, one uppercase letter, and one number'
      ),
    pin: z
      .string()
      .regex(/^\d{4}$/, 'PIN must be exactly 4 digits')
      .optional()
      .nullable(),
  }),
})

export type InvitationTokenParams = z.infer<typeof InvitationTokenParamsSchema>
export type AcceptInvitationRequest = z.infer<typeof AcceptInvitationSchema>