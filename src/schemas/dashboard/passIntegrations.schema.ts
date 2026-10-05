/**
 * Conector de pases (TotalPass/Wellhub) — forma de las peticiones del dashboard. Sólo forma y formato; las reglas del
 * negocio (conexión activa, clases ligadas, tope de reglas, fechas imposibles) viven en los servicios.
 * Todos los mensajes van en español: `validateRequest` los muestra tal cual.
 */
import { z } from 'zod'

const DIA = /^\d{4}-\d{2}-\d{2}$/
const CAMPO_DE_MAS = 'Hay un campo que no se esperaba'

const venueParams = z.object({ venueId: z.string().min(1, 'Falta el negocio') }).passthrough()
const providerParams = venueParams.extend({
  provider: z.enum(['totalpass', 'wellhub'], { errorMap: () => ({ message: 'Proveedor no reconocido' }) }),
})
const spots = z
  .number({ required_error: 'Indica los lugares', invalid_type_error: 'Los lugares deben ser un número' })
  .int('Los lugares deben ser un número entero')
  .min(0, 'Mínimo 0')
  .max(500, 'Máximo 500')
/** `de` lleva su artículo («la clase», «la regla», «la visita») ⇒ «Falta la clase», «El id de la clase no es válido.». */
const idDe = (de: string) =>
  z.string({ required_error: `Falta ${de}`, invalid_type_error: `El id de ${de} no es válido.` }).min(1, `Falta ${de}`)

export const overviewSchema = z.object({ params: venueParams, body: z.any().optional(), query: z.any().optional() })

export const connectTotalPassSchema = z.object({
  params: venueParams,
  body: z
    .object({
      placeApiKey: z
        .string({ required_error: 'Pega la llave de tu sucursal', invalid_type_error: 'La llave debe ser texto' })
        .trim()
        .min(8, 'Pega la llave completa de tu sucursal')
        .max(200, 'La llave es demasiado larga'),
    })
    .strict(CAMPO_DE_MAS),
  query: z.any().optional(),
})

export const confirmModeSchema = z.object({
  params: providerParams,
  body: z
    .object({ confirmMode: z.enum(['AUTO', 'ON_VENUE_CHECKIN'], { errorMap: () => ({ message: 'Modo de confirmación no reconocido' }) }) })
    .strict(CAMPO_DE_MAS),
  query: z.any().optional(),
})

export const productLinksSchema = z.object({
  params: providerParams,
  body: z
    .object({
      links: z
        .array(
          z
            .object({
              productId: idDe('la clase'),
              externalPlanId: z
                .string({ required_error: 'Falta el plan del proveedor', invalid_type_error: 'El plan del proveedor no es válido' })
                .trim()
                .min(1, 'Falta el plan del proveedor')
                .max(50, 'El plan del proveedor es demasiado largo'),
            })
            .strict(CAMPO_DE_MAS),
          { required_error: 'Faltan las clases', invalid_type_error: 'Las clases deben ser una lista' },
        )
        .max(200, 'Máximo 200 clases')
        .refine(ls => new Set(ls.map(l => l.productId)).size === ls.length, 'Hay una clase repetida'),
    })
    .strict(CAMPO_DE_MAS),
  query: z.any().optional(),
})

export const providerOnlySchema = z.object({ params: providerParams, body: z.any().optional(), query: z.any().optional() })

export const defaultCapSchema = z.object({
  params: venueParams,
  body: z.object({ maxSpots: spots.nullable() }).strict(CAMPO_DE_MAS),
  query: z.any().optional(),
})

export const weeklyCapSchema = z.object({
  params: venueParams,
  body: z
    .object({
      weekday: z
        .number({ required_error: 'Falta el día', invalid_type_error: 'Día inválido' })
        .int('Día inválido')
        .min(0, 'Día inválido')
        .max(6, 'Día inválido'),
      startMinute: z
        .number({ required_error: 'Falta la hora (o null para todo el día)', invalid_type_error: 'Hora inválida' })
        .int('Hora inválida')
        .min(0, 'Hora inválida')
        .max(1439, 'Hora inválida')
        .nullable(),
      maxSpots: spots,
    })
    .strict(CAMPO_DE_MAS),
  query: z.any().optional(),
})

export const deleteRuleSchema = z.object({
  params: venueParams.extend({ ruleId: idDe('la regla') }),
  body: z.any().optional(),
  query: z.any().optional(),
})

export const sessionCapSchema = z.object({
  params: venueParams.extend({ classSessionId: idDe('la clase') }),
  body: z.object({ maxSpots: spots.nullable() }).strict(CAMPO_DE_MAS),
  query: z.any().optional(),
})

export const listVisitsSchema = z.object({
  params: venueParams,
  body: z.any().optional(),
  query: z.object({
    status: z
      .enum(['PENDING', 'CONFIRMED', 'ALREADY_CONFIRMED', 'EXPIRED', 'REJECTED'], { errorMap: () => ({ message: 'Estado no reconocido' }) })
      .optional(),
    provider: z.enum(['TOTALPASS', 'WELLHUB'], { errorMap: () => ({ message: 'Proveedor no reconocido' }) }).optional(),
    from: z.string().regex(DIA, 'La fecha va como AAAA-MM-DD').optional(),
    to: z.string().regex(DIA, 'La fecha va como AAAA-MM-DD').optional(),
    limit: z.coerce
      .number({ invalid_type_error: 'El límite debe ser un número' })
      .int('El límite debe ser un número entero')
      .min(1, 'El límite mínimo es 1')
      .transform(n => Math.min(n, 100))
      .optional(),
    offset: z.coerce
      .number({ invalid_type_error: 'El desplazamiento debe ser un número' })
      .int('El desplazamiento debe ser un número entero')
      .min(0, 'El desplazamiento mínimo es 0')
      .optional(),
  }),
})

export const visitsSummarySchema = z.object({
  params: venueParams,
  body: z.any().optional(),
  query: z.object({
    month: z.string({ required_error: 'Falta el mes (AAAA-MM)' }).regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'El mes va como AAAA-MM'),
  }),
})

export const visitActionSchema = z.object({
  params: venueParams.extend({ visitId: idDe('la visita') }),
  body: z.any().optional(),
  query: z.any().optional(),
})
