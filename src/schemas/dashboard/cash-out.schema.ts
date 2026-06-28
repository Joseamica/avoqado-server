import { z } from 'zod'

/**
 * Cash Out (PlayTelecom) dashboard request schemas. Spanish messages — shown
 * raw to the user by the validation middleware. Amounts are PESOS (1:1), never
 * cents. Shape/format only; the ladder's business rules live in validateRateTable.
 */

const rateTierSchema = z.object({
  saleType: z.enum(['LINEA_NUEVA', 'PORTABILIDAD'], {
    errorMap: () => ({ message: 'El tipo de venta debe ser LINEA_NUEVA o PORTABILIDAD.' }),
  }),
  minCount: z
    .number({ invalid_type_error: 'El inicio del tramo debe ser un número.' })
    .int('Debe ser entero.')
    .min(1, 'El inicio del tramo debe ser ≥ 1.'),
  maxCount: z.number().int('Debe ser entero.').min(1, 'El máximo debe ser ≥ 1.').nullable(),
  amount: z.number({ invalid_type_error: 'La comisión debe ser un número (en pesos).' }).min(0, 'La comisión no puede ser negativa.'),
})

export const replaceCommissionRatesSchema = z.object({
  body: z.object({
    rates: z.array(rateTierSchema).min(1, 'Debes enviar al menos un tramo de comisión.'),
  }),
})

export const setActiveDaysSchema = z.object({
  body: z.object({
    days: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Cada día debe tener formato YYYY-MM-DD.')),
  }),
})

export const listActiveDaysSchema = z.object({
  query: z.object({
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'El parámetro "from" debe ser YYYY-MM-DD.')
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'El parámetro "to" debe ser YYYY-MM-DD.')
      .optional(),
  }),
})

export const generateReportSchema = z.object({
  body: z.object({
    businessDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, '"businessDate" debe ser YYYY-MM-DD.')
      .optional(),
  }),
})

export const listWithdrawalsSchema = z.object({
  query: z.object({
    businessDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, '"businessDate" debe ser YYYY-MM-DD.')
      .optional(),
    status: z.enum(['REQUESTED', 'REPORTED', 'PAID', 'FAILED']).optional(),
  }),
})
