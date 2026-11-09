import { z } from 'zod'

export const generarCodigosSchema = z.object({
  body: z.union([
    z.object({ staffIds: z.array(z.string().min(1)).min(1).max(100) }).strict(),
    z.object({ todosLosSinCelular: z.literal(true) }).strict(),
  ]),
})

export const ESTADOS_DEL_RETENIDO = ['PENDIENTE', 'APLICANDO', 'APLICADO', 'DESCARTADO'] as const

/** GET …/retenidos — `estado` es uno o varios separados por coma (`PENDIENTE,APLICANDO` = sin resolver). */
export const listarRetenidosSchema = z.object({
  query: z
    .object({
      staffId: z.string().min(1).max(50).optional(),
      venueId: z.string().min(1).max(50).optional(),
      estado: z
        .string()
        .optional()
        .transform(s => (s === undefined ? undefined : s.split(',').map(x => x.trim())))
        .pipe(z.array(z.enum(ESTADOS_DEL_RETENIDO)).min(1).optional()),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(50),
    })
    .strict(),
})

/** POST …/retenidos/:retenidoId/resolver */
export const resolverRetenidoSchema = z.object({
  body: z.object({ accion: z.enum(['APLICAR', 'DESCARTAR']), nota: z.string().max(500).optional() }).strict(),
})
