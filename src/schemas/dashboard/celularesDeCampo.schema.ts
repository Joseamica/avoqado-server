import { z } from 'zod'

export const generarCodigosSchema = z.object({
  body: z.union([
    z.object({ staffIds: z.array(z.string().min(1)).min(1).max(100) }).strict(),
    z.object({ todosLosSinCelular: z.literal(true) }).strict(),
  ]),
})
