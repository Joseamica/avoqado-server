import { z } from 'zod'

/**
 * SDK propio, fase 1 (Tarea 9): el permiso para reversar no lleva datos — la terminal sale del token y el intento de la ruta.
 * Estricto: una llave de más (p. ej. un serial en el cuerpo) es 400, nunca se ignora.
 */
export const intencionDeReversoSchema = z.object({ body: z.object({}).strict() })

/**
 * Tarea 10: cómo le fue al reverso con Blumon. Estricto; al menos `descripcion` o `codigo` (sin ninguno no se sabe qué pasó).
 * `reversadoEn` es la hora del reverso en la terminal (ISO 8601).
 */
export const resultadoDeReversoSchema = z.object({
  body: z
    .object({
      descripcion: z.string().max(64).optional(),
      codigo: z.string().max(16).optional(),
      operationNumber: z.union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.string().max(32)]).optional(),
      reversadoEn: z.string().datetime({ offset: true }),
    })
    .strict()
    .refine(b => Boolean(b.descripcion?.trim() || b.codigo?.trim()), { message: 'Falta descripcion o codigo del reverso' }),
})
