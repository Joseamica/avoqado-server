import { VenueType } from '@prisma/client'
import { z } from 'zod'
import { BadRequestError } from '../../errors/AppError'
import { selectionSchema, validationMessage } from './venueLinks.service'

const text = z
  .string({ invalid_type_error: 'Escribe un texto válido', required_error: 'Este campo es obligatorio' })
  .max(500, 'Texto demasiado largo')
const number = z.number({ invalid_type_error: 'Escribe un número válido' }).finite('Escribe un número finito')
const identifier = text.regex(/^c[a-z0-9]{24}$/, 'Identificador inválido')
const staff = z.object({ email: text.email('Correo inválido'), firstName: text, lastName: text, role: text.optional() })
/** Only the new, linked flow opts into this schema. Legacy wizard callers retain their current contract. */
const linkedWizardSchema = z.object({
  documentRequest: selectionSchema,
  organization: z.object({
    mode: z.enum(['existing', 'new'], { errorMap: () => ({ message: 'Selecciona una organización' }) }),
    id: identifier.optional(),
    name: text.optional(),
    email: text.optional(),
    phone: text.optional(),
  }),
  venue: z.object({
    name: text.min(1, 'Escribe el nombre del negocio'),
    slug: text.optional(),
    venueType: z.nativeEnum(VenueType, { errorMap: () => ({ message: 'Selecciona un giro válido' }) }),
    timezone: text.optional(),
    currency: text.optional(),
    address: text.optional(),
    city: text.optional(),
    state: text.optional(),
    zipCode: text.optional(),
    latitude: number.optional(),
    longitude: number.optional(),
    phone: text.optional(),
    email: text.optional(),
    website: text.optional(),
    entityType: z
      .enum(['PERSONA_FISICA', 'PERSONA_MORAL'], { errorMap: () => ({ message: 'Selecciona un tipo de persona válido' }) })
      .optional(),
    rfc: text.optional(),
    legalName: text.optional(),
    zoneId: identifier.nullable().optional(),
  }),
  pricing: z
    .object({
      debitRate: number,
      creditRate: number,
      amexRate: number,
      internationalRate: number,
      fixedFeePerTransaction: number.optional(),
      monthlyServiceFee: number.optional(),
      useOrgConfig: z.boolean().optional(),
      merchantAccountId: identifier.optional(),
      createOrgConfig: z
        .object({
          primaryAccountId: identifier,
          secondaryAccountId: identifier.optional(),
          tertiaryAccountId: identifier.optional(),
          preferredProcessor: text.optional(),
        })
        .optional(),
    })
    .optional(),
  terminal: z
    .object({
      serialNumber: text,
      brand: text,
      model: text,
      name: text.optional(),
      environment: z.enum(['SANDBOX', 'PRODUCTION'], { errorMap: () => ({ message: 'Selecciona un ambiente válido' }) }),
    })
    .optional(),
  settlement: z
    .object({
      debitDays: number.optional(),
      creditDays: number.optional(),
      amexDays: number.optional(),
      internationalDays: number.optional(),
      otherDays: number.optional(),
      dayType: z
        .enum(['BUSINESS_DAYS', 'CALENDAR_DAYS'], { errorMap: () => ({ message: 'Selecciona días hábiles o naturales' }) })
        .optional(),
      cutoffTime: text.optional(),
      cutoffTimezone: text.optional(),
    })
    .optional(),
  team: z
    .object({
      owner: staff,
      additionalStaff: z
        .array(staff.extend({ role: text }))
        .max(100, 'Máximo 100 personas')
        .optional(),
    })
    .optional(),
  features: z.array(text).max(100, 'Máximo 100 funciones').optional(),
  modules: z
    .array(z.object({ code: text, config: z.record(z.unknown()).optional(), preset: text.optional() }))
    .max(100, 'Máximo 100 módulos')
    .optional(),
  activateImmediately: z.boolean({ invalid_type_error: 'Confirma explícitamente la aprobación manual' }).optional(),
})
export function parseLinkedWizard(value: unknown) {
  const result = linkedWizardSchema.safeParse(value)
  if (!result.success) throw new BadRequestError('Revisa los datos del alta: ' + result.error.issues.map(validationMessage).join('. '))
  return result.data
}
