import { z } from 'zod'

/**
 * Schema para generar código de activación (Dashboard endpoint)
 * POST /dashboard/venues/:venueId/terminals/:terminalId/activation-code
 */
export const generateActivationCodeSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
    terminalId: z.string().refine(
      val => {
        // Accept CUID, CUID2 (variable length 20-25 chars), and UUID (legacy terminals)
        const isCuid = /^c[a-z0-9]{19,}$/.test(val)
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)
        return isCuid || isUuid
      },
      { message: 'El ID del terminal debe ser un CUID o UUID válido.' },
    ),
  }),
})

/**
 * Schema para activar terminal (TPV endpoint)
 * POST /tpv/activate
 *
 * Activation Code Format:
 * - 6 caracteres alfanuméricos (case-insensitive)
 * - Ejemplo: A3F9K2, XJ7P8M
 * - Security: 2.1 billion combinations (36^6)
 *
 * Serial Number Format:
 * - Formato: AVQD-{12 chars alphanumeric}
 * - Ejemplo: AVQD-1A2B3C4D5E6F
 * - Obtenido automáticamente del dispositivo Android
 */
export const activateTerminalSchema = z.object({
  body: z.object({
    serialNumber: z
      .string()
      .min(1, { message: 'El número de serie es requerido.' })
      .regex(/^[A-Z0-9-]+$/i, {
        message: 'El número de serie debe contener solo letras, números y guiones.',
      }),
    activationCode: z
      .string()
      .length(6, { message: 'El código de activación debe tener exactamente 6 caracteres.' })
      .regex(/^[A-Z0-9]{6}$/i, {
        message: 'El código de activación debe contener solo letras y números (6 caracteres).',
      })
      .transform(val => val.toUpperCase()), // Normalizar a mayúsculas para comparación case-insensitive
  }),
})

/**
 * Type exports para TypeScript
 */
export type GenerateActivationCodeParams = z.infer<typeof generateActivationCodeSchema>['params']
export type ActivateTerminalBody = z.infer<typeof activateTerminalSchema>['body']
