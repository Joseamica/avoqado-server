import { z } from 'zod'
import { BadRequestError } from '@/errors/AppError'

export const MAX_SERVICE_COURSES = 32
export const MAX_SERVICE_COURSE_LABEL = 60

const labelSchema = z
  .string()
  .refine(
    value => Array.from(value).every(character => character.charCodeAt(0) > 0x1f && character.charCodeAt(0) !== 0x7f),
    'El nombre no puede contener saltos de línea ni caracteres de control',
  )
  .transform(value => value.normalize('NFKC').trim().replace(/\s+/gu, ' '))
  .pipe(z.string().min(1, 'Escribe un nombre para el tiempo').max(MAX_SERVICE_COURSE_LABEL, 'El nombre admite hasta 60 caracteres'))

/** A historical choice, never resolved again against today's catalog during replay. */
const courseDefinition = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9_-]+$/, 'El identificador del tiempo no es válido'),
    label: labelSchema,
    kind: z.enum(['IMMEDIATE', 'STANDARD']),
  })
  .strict()

function preserveImmediate(course: { id: string; kind: string }, ctx: z.RefinementCtx) {
  if ((course.id === 'immediate') !== (course.kind === 'IMMEDIATE')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'El tiempo inmediato conserva su identidad y comportamiento', path: ['kind'] })
  }
}

export const serviceCourseSnapshotSchema = courseDefinition
  .extend({
    preparationVersion: z.literal(1).optional(),
    sortOrder: z
      .number()
      .int()
      .min(0)
      .max(MAX_SERVICE_COURSES - 1)
      .optional(),
  })
  .superRefine(preserveImmediate)

export type ServiceCourseSnapshot = z.infer<typeof serviceCourseSnapshotSchema>

export function parseServiceCourseSnapshot(value: unknown): ServiceCourseSnapshot | null {
  if (value == null) return null
  const parsed = serviceCourseSnapshotSchema.safeParse(value)
  if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message, 'SERVICE_COURSE_INVALID')
  return parsed.data
}

export const serviceCourseCatalogSchema = z
  .array(courseDefinition.superRefine(preserveImmediate))
  .min(1, 'Conserva el tiempo inmediato')
  .max(MAX_SERVICE_COURSES, 'Puedes configurar hasta 32 tiempos de servicio')
  .superRefine((courses, ctx) => {
    if (courses[0]?.kind !== 'IMMEDIATE' || courses.slice(1).some(course => course.kind === 'IMMEDIATE')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'El tiempo inmediato debe ser el primero y aparecer una sola vez' })
    }
    const ids = new Set<string>()
    const labels = new Set<string>()
    courses.forEach((course, index) => {
      if (ids.has(course.id))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Los identificadores no pueden repetirse', path: [index, 'id'] })
      const folded = course.label.toLocaleLowerCase('es')
      if (labels.has(folded))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Los nombres de los tiempos no pueden repetirse', path: [index, 'label'] })
      ids.add(course.id)
      labels.add(folded)
    })
  })

export const DEFAULT_SERVICE_COURSES: ServiceCourseSnapshot[] = [
  { id: 'immediate', label: 'Inmediato', kind: 'IMMEDIATE' },
  { id: 'appetizers', label: 'Aperitivos', kind: 'STANDARD' },
  { id: 'mains', label: 'Principales', kind: 'STANDARD' },
  { id: 'desserts', label: 'Postres', kind: 'STANDARD' },
]

export function legacyCourseForSnapshot(course: ServiceCourseSnapshot): string | null {
  return course.kind === 'IMMEDIATE' ? null : course.label
}

type SavedCatalog = { serviceCourses: unknown; serviceCoursesRevision: number }

export function resolveServiceCourses(organization: SavedCatalog | null, venueSettings: SavedCatalog | null) {
  const organizationRevision = organization?.serviceCoursesRevision ?? 0
  const venueRevision = venueSettings?.serviceCoursesRevision ?? 0
  const own = venueSettings?.serviceCourses != null
  const inherited = organization?.serviceCourses != null
  const source = own ? 'VENUE' : inherited ? 'ORGANIZATION' : 'DEFAULT'
  return {
    source,
    revision: own ? `v:${venueRevision}` : `o:${organizationRevision}:v:${venueRevision}`,
    organizationRevision,
    venueRevision,
    hasOwnConfiguration: own,
    courses: serviceCourseCatalogSchema.parse(
      own ? venueSettings!.serviceCourses : inherited ? organization!.serviceCourses : DEFAULT_SERVICE_COURSES,
    ),
    limits: { maxCourses: MAX_SERVICE_COURSES, maxLabelLength: MAX_SERVICE_COURSE_LABEL },
  }
}
