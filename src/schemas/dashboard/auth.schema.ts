import { z } from 'zod'

export const loginSchema = z.object({
  body: z.object({
    email: z.string({ required_error: 'El email es requerido.' }).email({ message: 'Email inválido.' }),
    password: z
      .string({ required_error: 'La contraseña es requerida.' })
      .min(4, { message: 'La contraseña debe tener al menos 4 caracteres.' }),
    venueId: z
      .string({ required_error: 'El ID del establecimiento (venue) es requerido.' })
      .cuid({ message: 'El ID del venue debe ser un CUID válido.' })
      .optional(),
    // fcmToken es opcional, lo manejaremos en el servicio si es necesario
    fcmToken: z.string().optional(),
  }),
})

export const switchVenueSchema = z.object({
  body: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue es requerido y debe ser un CUID válido.' }),
  }),
})

export const updateAccountSchema = z.object({
  body: z
    .object({
      id: z.string().cuid().optional(),
      firstName: z.string().min(1, { message: 'El nombre es requerido.' }).optional(),
      lastName: z.string().min(1, { message: 'El apellido es requerido.' }).optional(),
      email: z.string().email({ message: 'Email inválido.' }).optional(),
      phone: z.string().optional(), // Phone is completely optional
      old_password: z.string().optional(),
      password: z.string().optional(),
    })
    .refine(
      data => {
        // Only validate password fields if either is provided
        if (data.password || data.old_password) {
          // If trying to change password, both fields are required
          if (data.password && !data.old_password) {
            return false
          }
          if (data.old_password && !data.password) {
            return false
          }
          // Validate minimum lengths only when changing password
          if (data.password && data.password.length < 4) {
            return false
          }
          if (data.old_password && data.old_password.length < 4) {
            return false
          }
        }
        return true
      },
      {
        message: 'Para cambiar la contraseña, ambos campos son requeridos y deben tener al menos 4 caracteres.',
        path: ['password'],
      },
    ),
})

export const requestPasswordResetSchema = z.object({
  body: z.object({
    email: z.string({ required_error: 'El email es requerido.' }).email({ message: 'Email inválido.' }),
  }),
})

export const resetPasswordSchema = z.object({
  body: z.object({
    token: z.string({ required_error: 'El token es requerido.' }).min(32, { message: 'Token inválido.' }),
    newPassword: z
      .string({ required_error: 'La nueva contraseña es requerida.' })
      .min(8, { message: 'La contraseña debe tener al menos 8 caracteres.' })
      .regex(/[A-Z]/, { message: 'La contraseña debe contener al menos una letra mayúscula.' })
      .regex(/[a-z]/, { message: 'La contraseña debe contener al menos una letra minúscula.' })
      .regex(/[0-9]/, { message: 'La contraseña debe contener al menos un número.' })
      .regex(/[^A-Za-z0-9]/, {
        message: 'La contraseña debe contener al menos un carácter especial.',
      }),
  }),
})

// Inferimos el tipo para usarlo en el controlador y servicio
export type LoginDto = z.infer<typeof loginSchema.shape.body>
export type SwitchVenueDto = z.infer<typeof switchVenueSchema.shape.body>
export type UpdateAccountDto = z.infer<typeof updateAccountSchema.shape.body>
export type RequestPasswordResetDto = z.infer<typeof requestPasswordResetSchema.shape.body>
export type ResetPasswordDto = z.infer<typeof resetPasswordSchema.shape.body>
