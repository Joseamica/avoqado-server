import { z } from 'zod'

/**
 * SDK propio, fase 1 (Tarea 9): el permiso para reversar no lleva datos — la terminal sale del token y el intento de la ruta.
 * Estricto: una llave de más (p. ej. un serial en el cuerpo) es 400, nunca se ignora.
 */
export const intencionDeReversoSchema = z.object({ body: z.object({}).strict() })
