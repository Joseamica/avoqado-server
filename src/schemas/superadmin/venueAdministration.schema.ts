import { EntityType, VenueStatus } from '@prisma/client'
import { z } from 'zod'
import { createVenueSchema, convertDemoVenueSchema } from '@/schemas/dashboard/venue.schema'

const venueFields = createVenueSchema.shape.body.shape
const legalFields = convertDemoVenueSchema.shape.body.innerType().shape
const string = () => z.string({ required_error: 'El valor es requerido.', invalid_type_error: 'El valor debe ser texto.' }).trim()
const nullableText = (schema: z.ZodType<string>) =>
  z.preprocess(value => (typeof value === 'string' ? value.trim() || null : value), schema.nullable().optional())
const email = string().email('Formato de email inválido.')
const phone = string().pipe(venueFields.phone.unwrap().unwrap())
const revision = string().datetime({ offset: true, message: 'La fecha de actualización debe ser una fecha ISO válida.' })
// Existing venues include UUID identities; only newly generated ids require cuid v1.
const id = string().min(1, 'El ID es requerido.').max(128, 'El ID no puede exceder 128 caracteres.')
const nonempty = (changes: Record<string, unknown>) => Object.values(changes).some(value => value !== undefined)
const strictMessage = 'Hay campos no permitidos en la solicitud.'

export const venueAdministrationParams = z.object({ venueId: id }).strict(strictMessage)

export const updateVenueProfileBody = z
  .object({
    expectedUpdatedAt: revision,
    confirmSlugChange: z.boolean({ invalid_type_error: 'La confirmación debe ser verdadera o falsa.' }).optional(),
    changes: z
      .object({
        name: string().pipe(venueFields.name).optional(),
        slug: string().pipe(venueFields.slug.unwrap()).optional(),
        type: venueFields.type.removeDefault().optional(),
        address: nullableText(string().pipe(venueFields.address.unwrap().unwrap())),
        city: nullableText(string().pipe(venueFields.city.unwrap().unwrap())),
        state: nullableText(string().pipe(venueFields.state.unwrap().unwrap())),
        country: nullableText(
          string()
            .length(2, 'El país debe tener 2 letras.')
            .regex(/^[A-Z]{2}$/, 'El país debe usar dos letras mayúsculas.'),
        ),
        zipCode: nullableText(string().pipe(venueFields.zipCode.unwrap().unwrap())),
        phone: nullableText(phone),
        email: nullableText(email),
        website: nullableText(
          string()
            .url('Formato de URL de sitio web inválido.')
            .regex(/^https?:\/\//i, 'El sitio web debe usar http o https.'),
        ),
        latitude: z
          .number({ invalid_type_error: 'La latitud debe ser un número.' })
          .finite('La latitud debe ser finita.')
          .min(-90, 'La latitud mínima es -90.')
          .max(90, 'La latitud máxima es 90.')
          .nullable()
          .optional(),
        longitude: z
          .number({ invalid_type_error: 'La longitud debe ser un número.' })
          .finite('La longitud debe ser finita.')
          .min(-180, 'La longitud mínima es -180.')
          .max(180, 'La longitud máxima es 180.')
          .nullable()
          .optional(),
        language: z.enum(['es', 'en'], { errorMap: () => ({ message: 'El idioma debe ser español o inglés.' }) }).optional(),
        entityType: z
          .nativeEnum(EntityType, { errorMap: () => ({ message: 'Tipo de persona inválido.' }) })
          .nullable()
          .optional(),
        rfc: nullableText(string().pipe(legalFields.rfc.unwrap().unwrap())),
        legalName: nullableText(
          string().min(3, 'La razón social debe tener al menos 3 caracteres.').max(300, 'La razón social no puede exceder 300 caracteres.'),
        ),
        fiscalRegime: nullableText(string().regex(/^\d{3}$/, 'El régimen fiscal debe ser una clave de 3 dígitos.')),
      })
      .strict(strictMessage)
      .refine(nonempty, 'Envía al menos un campo para actualizar.'),
  })
  .strict(strictMessage)

export const updateVenueOrganizationBody = z
  .object({
    expectedUpdatedAt: revision,
    expectedOrganizationId: id,
    confirmShared: z.literal(true, { errorMap: () => ({ message: 'Confirma que el cambio afecta a toda la organización.' }) }),
    changes: z
      .object({
        name: string()
          .min(2, 'El nombre debe tener al menos 2 caracteres.')
          .max(100, 'El nombre no puede exceder 100 caracteres.')
          .optional(),
        email: email.optional(),
        phone: phone.optional(),
        taxId: nullableText(string().pipe(legalFields.rfc.unwrap().unwrap())),
        billingEmail: nullableText(email),
      })
      .strict(strictMessage)
      .refine(nonempty, 'Envía al menos un campo para actualizar.'),
  })
  .strict(strictMessage)

export const updateVenueOwnerBody = z
  .object({
    expectedUpdatedAt: revision,
    expectedOwnerId: id,
    confirmShared: z.literal(true, {
      errorMap: () => ({ message: 'Confirma que el cambio afecta a todas las sucursales del responsable.' }),
    }),
    changes: z
      .object({
        firstName: string().min(1, 'El nombre es requerido.').max(100, 'El nombre no puede exceder 100 caracteres.').optional(),
        lastName: string().min(1, 'Los apellidos son requeridos.').max(100, 'Los apellidos no pueden exceder 100 caracteres.').optional(),
        phone: nullableText(phone),
      })
      .strict(strictMessage)
      .refine(nonempty, 'Envía al menos un campo para actualizar.'),
  })
  .strict(strictMessage)

export const updateVenueStatusBody = z
  .object({
    expectedUpdatedAt: revision,
    status: z.nativeEnum(VenueStatus, { errorMap: () => ({ message: 'Estado del negocio inválido.' }) }),
    reason: string().max(1000, 'El motivo no puede exceder 1000 caracteres.').optional(),
  })
  .strict(strictMessage)

export type UpdateVenueProfileInput = z.infer<typeof updateVenueProfileBody>
export type UpdateVenueOrganizationInput = z.infer<typeof updateVenueOrganizationBody>
export type UpdateVenueOwnerInput = z.infer<typeof updateVenueOwnerBody>
export type UpdateVenueStatusInput = z.infer<typeof updateVenueStatusBody>
