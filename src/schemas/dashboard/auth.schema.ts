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

// Inferimos el tipo para usarlo en el controlador y servicio
export type LoginDto = z.infer<typeof loginSchema.shape.body>
export type SwitchVenueDto = z.infer<typeof switchVenueSchema.shape.body>
