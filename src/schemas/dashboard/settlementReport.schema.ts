import { z } from 'zod'

const lista = (valores?: readonly string[]) =>
  z
    .string({ invalid_type_error: 'El filtro debe ser texto separado por comas.' })
    .optional()
    .transform(s =>
      s
        ? s
            .split(',')
            .map(x => x.trim())
            .filter(Boolean)
        : undefined,
    )
    .refine(v => !v || !valores || v.every(x => valores.includes(x)), { message: 'Hay un valor de filtro que no existe.' })

const ymd = z
  .string({ required_error: 'La fecha es requerida.', invalid_type_error: 'El parámetro debe ser texto.' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Las fechas deben tener el formato AAAA-MM-DD.')
  .refine(
    s => {
      const d = new Date(`${s}T00:00:00Z`)
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
    },
    s => ({ message: `La fecha ${s} no existe.` }),
  )

const filtros = {
  startDate: ymd,
  endDate: ymd,
  dateBasis: z.enum(['charge', 'deposit'], { errorMap: () => ({ message: 'La base de fecha debe ser «charge» o «deposit».' }) }),
  terminalIds: lista(),
  cardTypes: lista(['DEBIT', 'CREDIT', 'AMEX', 'INTERNATIONAL', 'OTHER', 'NONE']),
  brands: lista([
    'VISA',
    'MASTERCARD',
    'AMERICAN_EXPRESS',
    'DISCOVER',
    'DINERS_CLUB',
    'JCB',
    'MAESTRO',
    'UNIONPAY',
    'ELO',
    'HIPERCARD',
    'OTHER',
  ]),
  operations: lista(['SALE', 'REFUND', 'TIP_REFUND']),
}
const params = z.object({ venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }) })

export const settlementReportCountSchema = z.object({ params, query: z.object(filtros) })
export const settlementReportExportSchema = z.object({
  params,
  query: z.object({
    ...filtros,
    report: z.enum(['transactions', 'deposits'], { errorMap: () => ({ message: 'El reporte debe ser «transactions» o «deposits».' }) }),
    format: z.enum(['xlsx', 'csv'], { errorMap: () => ({ message: 'El formato debe ser Excel o CSV.' }) }),
    columns: lista(),
  }),
})
export const settlementReportTerminalOptionsSchema = z.object({
  params,
  query: z.object({
    search: z.string({ invalid_type_error: 'El parámetro debe ser texto.' }).max(80, 'La búsqueda es muy larga.').optional(),
    cursor: z.string({ invalid_type_error: 'El parámetro debe ser texto.' }).optional(),
    limit: z.coerce
      .number({ invalid_type_error: 'El límite debe ser un número.' })
      .int('El límite debe ser entero.')
      .min(1, 'El límite mínimo es 1.')
      .max(100, 'El límite máximo es 100.')
      .optional(),
  }),
})
