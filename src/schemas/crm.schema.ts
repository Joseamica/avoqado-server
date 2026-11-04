/**
 * Zod schemas for `/api/v1/crm/*` (spec 2026-10-30). Messages ALWAYS in Spanish; shape and format only — the business
 * rules (which keys go together, who may give which key, who owns what) live in the services.
 */
import { StaffRole } from '@prisma/client'
import { z } from 'zod'
import { bloquesCampanaSchema } from '../services/marketing/campaignBlocks'
import { canonicalPhoneE164 } from '../utils/phone'
import { EXISTING_ID_REGEX } from './common/existingId.schema'

const scope = z.enum(['propios', 'todos'], { errorMap: () => ({ message: 'El alcance es «propios» o «todos»' }) }).nullable()
const flag = z.boolean({ required_error: 'Falta una llave', invalid_type_error: 'Cada llave es sí o no' })
const cuid = z.string({ required_error: 'Falta el id' }).cuid('El id no es válido')
const name = (missing: string) =>
  z.string({ required_error: missing, invalid_type_error: missing }).trim().min(1, missing).max(100, 'Máximo 100 caracteres')

/**
 * A person's 13 CRM keys (plan 2026-11-04), all of them every time: the screen sends the whole set, never a partial one.
 * Sin `campanas` ni `admin`: sólo los manda la pantalla vieja, y la rechaza `assertFormaNuevaDeLlaves` (409) antes de este
 * esquema (L10).
 */
export const crmKeysSchema = z.object(
  {
    ver: scope,
    editar: scope,
    cerrar: flag,
    contactar: flag,
    exportar: flag,
    ventas: flag,
    bajas: flag,
    plantillas: flag,
    preparar: flag,
    mandar: flag,
    verCampanas: flag,
    equipo: flag,
    configurar: flag,
  },
  { required_error: 'Faltan las llaves', invalid_type_error: 'Faltan las llaves' },
)

export type CrmKeysInput = z.infer<typeof crmKeysSchema>

/** GET /crm/team. The page size has no upper bound here: the service caps it. */
export const listTeamSchema = z.object({
  query: z.object({
    page: z.coerce
      .number({ invalid_type_error: 'La página es un número' })
      .int('La página es un número entero')
      .min(1, 'La página empieza en 1')
      .optional(),
    pageSize: z.coerce
      .number({ invalid_type_error: 'El tamaño de página es un número' })
      .int('El tamaño de página es un número entero')
      .min(1, 'El tamaño de página es al menos 1')
      .optional(),
  }),
})

/** POST /crm/team. The email is stored and looked up in lowercase (ruling 8). */
export const addTeamMemberSchema = z.object({
  body: z.object({
    email: z
      .string({ required_error: 'El correo es obligatorio', invalid_type_error: 'El correo es obligatorio' })
      .trim()
      .toLowerCase()
      .email('El correo no es válido')
      .max(254, 'El correo es demasiado largo'),
    firstName: name('El nombre es obligatorio'),
    lastName: name('El apellido es obligatorio'),
    keys: crmKeysSchema,
  }),
})

/** PATCH /crm/team/:id — `expectedKeys`: the keys the screen saw (ruling 60); if they changed since, nothing is written. */
export const updateTeamMemberSchema = z.object({
  params: z.object({ id: cuid }),
  body: z.object({ keys: crmKeysSchema, expectedKeys: crmKeysSchema.optional() }),
})

/**
 * DELETE /crm/team/:id — without `reasignarA`, their open accounts stay «Sin dueño». `reasignarA` is a Staff id, and not
 * every one is a cuid (accepted invitations can create UUIDs): the service checks the person is on the team.
 */
export const removeTeamMemberSchema = z.object({
  params: z.object({ id: cuid }),
  body: z
    .object({
      reasignarA: z
        .string({ invalid_type_error: 'El id de la persona no es válido' })
        .trim()
        .min(1, 'Falta a quién pasarle los negocios')
        .max(100, 'El id de la persona no es válido')
        .nullish(),
    })
    .default({}),
})

// ── Accounts, activities and the pipeline (task 4) ────────────────────────────────────────────────────────────────────

/** Where an account came from. Strings validated here, never a Postgres enum (see the comment on the CRM models). */
export const ACCOUNT_SOURCES = ['LANDING', 'WHATSAPP', 'MANUAL', 'IMPORTACION', 'REFERIDO', 'OTRO'] as const
/** What a seller can pick when adding one by hand; the rest arrive through their own channel. */
export const MANUAL_SOURCES = ['MANUAL', 'REFERIDO', 'OTRO'] as const
export const ACTIVITY_TYPES = ['LLAMADA', 'WHATSAPP', 'CORREO', 'REUNION', 'DEMO', 'TAREA'] as const
export const SEMAFOROS = ['rojo', 'verde', 'gris', 'amarillo'] as const
export type Semaforo = (typeof SEMAFOROS)[number]

/** An id of a Staff or an Organization that already exists: not always a cuid (accepted invitations create UUIDs). */
const existing = (message: string, missing = message) =>
  z.string({ required_error: missing, invalid_type_error: message }).regex(EXISTING_ID_REGEX, message)
const text = (max: number, missing: string) =>
  z.string({ required_error: missing, invalid_type_error: missing }).trim().min(1, missing).max(max, `Máximo ${max} caracteres`)
const optionalText = (max: number) =>
  z.string({ invalid_type_error: 'Debe ser texto' }).trim().max(max, `Máximo ${max} caracteres`).optional()
/** A form's empty field is a field that was not filled. */
const blankIsAbsent = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value)
const flagQuery = z
  .enum(['true', 'false'], { errorMap: () => ({ message: 'Usa «true» o «false»' }) })
  .transform(value => value === 'true')
  .optional()
const byId = z.object({ id: cuid })

/** Any route of one account, or of one activity, by its id. */
export const accountIdSchema = z.object({ params: byId })

/** GET /crm/accounts. The page size has no upper bound here: the service caps it at 100. */
export const listAccountsSchema = z.object({
  query: z.object({
    stageId: cuid.optional(),
    ownerStaffId: existing('El id del dueño no es válido').optional(),
    source: z.enum(ACCOUNT_SOURCES, { errorMap: () => ({ message: 'Esa fuente no existe' }) }).optional(),
    semaforo: z.enum(SEMAFOROS, { errorMap: () => ({ message: 'El semáforo es rojo, verde, gris o amarillo' }) }).optional(),
    sinDueno: flagQuery,
    estancados: flagQuery,
    q: z
      .string({ invalid_type_error: 'La búsqueda es texto' })
      .trim()
      .max(100, 'Máximo 100 caracteres')
      .optional()
      .transform(value => value || undefined),
    cursor: cuid.optional(),
    limit: z.coerce
      .number({ invalid_type_error: 'El límite es un número' })
      .int('El límite es un número entero')
      .min(1, 'El límite es al menos 1')
      .optional(),
  }),
})

const contactSchema = z.object({
  name: text(200, 'El nombre de la persona es obligatorio'),
  phone: z.preprocess(
    blankIsAbsent,
    z
      .string({ invalid_type_error: 'El teléfono no es válido' })
      .trim()
      .max(30, 'El teléfono no es válido')
      .refine(value => canonicalPhoneE164(value) !== null, 'El teléfono no es válido')
      .optional(),
  ),
  email: z.preprocess(
    blankIsAbsent,
    z
      .string({ invalid_type_error: 'El correo no es válido' })
      .trim()
      .toLowerCase()
      .email('El correo no es válido')
      .max(254, 'El correo es demasiado largo')
      .optional(),
  ),
  role: optionalText(100),
})

/** POST /crm/accounts — «Nuevo prospecto». `confirmarOtroNegocio` = «sí, es otro negocio» after the duplicates warning. */
export const createAccountSchema = z.object({
  body: z.object({
    name: text(200, 'El nombre del negocio es obligatorio'),
    giro: optionalText(100),
    ventasRango: optionalText(60),
    sucursales: z
      .number({ invalid_type_error: 'Las sucursales son un número' })
      .int('Las sucursales son un número entero')
      .min(0, 'Las sucursales no pueden ser negativas')
      .max(10000, 'Máximo 10,000 sucursales')
      .optional(),
    source: z
      .enum(MANUAL_SOURCES, { errorMap: () => ({ message: 'A mano, la fuente es «MANUAL», «REFERIDO» u «OTRO»' }) })
      .default('MANUAL'),
    referidoPor: optionalText(200),
    contact: contactSchema.optional(),
    confirmarOtroNegocio: z.boolean({ invalid_type_error: 'Confirmar es sí o no' }).optional(),
  }),
})

/** POST /crm/accounts/:id/reassign. `staffId: null` leaves it «Sin dueño». */
export const reassignAccountSchema = z.object({
  params: byId,
  body: z.object({
    staffId: existing('El id de la persona no es válido', 'Di a quién se lo pasas, o null para dejarlo sin dueño').nullable(),
  }),
})

/** POST /crm/accounts/:id/stage */
export const moveStageSchema = z.object({
  params: byId,
  body: z.object({ stageId: z.string({ required_error: 'Elige la etapa' }).cuid('El id de la etapa no es válido') }),
})

/** POST /crm/accounts/:id/lose. Without a reason the service answers 422, so the screen says why. */
export const loseAccountSchema = z.object({
  params: byId,
  body: z.object({ lostReasonId: cuid.optional(), note: optionalText(1000) }),
})

/** POST /crm/accounts/:id/win. Without `organizationId`, the one it is already linked to (it came from the landing). */
export const winAccountSchema = z.object({
  params: byId,
  body: z.object({ organizationId: existing('El id de la cuenta de Avoqado no es válido').optional() }).default({}),
})

/** POST /crm/accounts/:id/notes */
export const addNoteSchema = z.object({
  params: byId,
  body: z.object({ text: text(5000, 'Escribe la nota') }),
})

/** POST /crm/accounts/:id/delete — the account's name, typed, so a wrong click deletes nothing (D7). */
export const deleteAccountSchema = z.object({
  params: byId,
  // No maximum of its own: a writer may keep a name of any length, and it has to be typed whole (Codex r3 H3). The body
  // parser's limit bounds it.
  body: z.object({
    confirmName: z
      .string({ required_error: 'Escribe el nombre del negocio', invalid_type_error: 'Escribe el nombre del negocio' })
      .trim()
      .min(1, 'Escribe el nombre del negocio'),
  }),
})

/** An activity's moment: an ISO 8601 instant with its offset (the screen sends UTC). */
const dueAt = z
  .string({ required_error: 'Di para cuándo', invalid_type_error: 'La fecha no es válida' })
  .datetime({ offset: true, message: 'La fecha no es válida' })
  .transform(value => new Date(value))

/** POST /crm/accounts/:id/activities */
export const addActivitySchema = z.object({
  params: byId,
  body: z.object({
    type: z.enum(ACTIVITY_TYPES, { errorMap: () => ({ message: 'El tipo es llamada, WhatsApp, correo, reunión, demo o tarea' }) }),
    title: text(200, 'Escribe qué hay que hacer'),
    dueAt,
  }),
})

/** POST /crm/activities/:id/reschedule (ruling 55): the new moment. */
export const rescheduleActivitySchema = z.object({
  params: byId,
  body: z.object({ dueAt }),
})

/** POST /crm/activities/:id/done */
export const completeActivitySchema = z.object({
  params: byId,
  body: z.object({ result: optionalText(1000) }).default({}),
})

/** GET /crm/organizations/search?q= — what «Ganar» links to. */
export const searchOrganizationsSchema = z.object({
  query: z.object({
    q: z
      .string({ required_error: 'Escribe al menos 3 letras', invalid_type_error: 'Escribe al menos 3 letras' })
      .trim()
      .min(3, 'Escribe al menos 3 letras')
      .max(100, 'Máximo 100 caracteres'),
  }),
})

// Stages and lost reasons (`crm:configurar`). The kind of a stage never changes, and a new one is always an open stage: there
// is one «Ganado» and one «Perdido». Nothing is deleted in phase 1 — a stage is renamed, a reason is turned off.
const stageName = text(60, 'El nombre de la etapa es obligatorio')
const stageOrder = z
  .number({ required_error: 'Falta el orden', invalid_type_error: 'El orden es un número' })
  .int('El orden es un número entero')
  .min(0, 'El orden empieza en 0')
  .max(1000, 'Máximo 1000')
const staleDays = z
  .number({ invalid_type_error: 'Los días son un número' })
  .int('Los días son un número entero')
  .min(1, 'Al menos 1 día')
  .max(365, 'Máximo 365 días')
  .nullable()
const somethingToChange = (body: object) => Object.keys(body).length > 0

/** POST /crm/stages */
export const createStageSchema = z.object({
  body: z
    .object({ name: stageName, order: stageOrder, staleDays: staleDays.optional() })
    .strict({ message: 'Una etapa nueva siempre es abierta: lleva nombre, orden y días para «estancado»' }),
})

/** PATCH /crm/stages/:id */
export const updateStageSchema = z.object({
  params: byId,
  body: z
    .object({ name: stageName.optional(), order: stageOrder.optional(), staleDays: staleDays.optional() })
    .strict({ message: 'Sólo se cambian el nombre, el orden y los días para «estancado»' })
    .refine(somethingToChange, 'No hay nada que cambiar'),
})

/** POST /crm/lost-reasons */
export const createLostReasonSchema = z.object({
  body: z.object({ name: text(100, 'El motivo es obligatorio') }).strict({ message: 'Un motivo nuevo sólo lleva su nombre' }),
})

/** PATCH /crm/lost-reasons/:id */
export const updateLostReasonSchema = z.object({
  params: byId,
  body: z
    .object({
      name: text(100, 'El motivo es obligatorio').optional(),
      active: z.boolean({ invalid_type_error: 'Activo es sí o no' }).optional(),
    })
    .strict({ message: 'Sólo se cambian el nombre y si está activo' })
    .refine(somethingToChange, 'No hay nada que cambiar'),
})

// «Importar lo de HubSpot» (`crm:configurar`, plan task 8). The two CSVs arrive as multipart; multer already capped them at
// 5 MB each and leaves them in `req.files`, which `validateRequest` does not read: the controller parses it with this.
const hubspotFile = (label: string) =>
  z
    .array(z.object({ buffer: z.instanceof(Buffer) }), {
      required_error: `Falta el archivo de ${label}`,
      invalid_type_error: `Falta el archivo de ${label}`,
    })
    .min(1, `Falta el archivo de ${label}`)

/** POST /crm/import/hubspot/preview y /apply: el CSV de contactos y el de negocios de la exportación de HubSpot. */
export const hubspotImportFilesSchema = z.object(
  { contactos: hubspotFile('contactos'), negocios: hubspotFile('negocios') },
  {
    required_error: 'Sube los dos archivos de HubSpot: contactos y negocios',
    invalid_type_error: 'Sube los dos archivos de HubSpot: contactos y negocios',
  },
)

// ── Clients, live data, reports and export (plan task 9) ──────────────────────────────────────────────────────────────

const listQuery = listAccountsSchema.shape.query.shape

/**
 * GET /crm/clients. The cursor is an Organization id (not always a cuid); the service caps the page at 100. `ocultos=true`
 * lists only the hidden organizations, and the service honors it only for «Administrar» (ruling 39).
 */
export const listClientsSchema = z.object({
  query: z.object({
    q: listQuery.q,
    cursor: existing('El cursor no es válido').optional(),
    limit: listQuery.limit,
    ocultos: flagQuery,
  }),
})

/**
 * POST /crm/clients/:organizationId/hide y /unhide, and GET /crm/clients/:organizationId/live (ruling 47) — an
 * Organization id, not always a cuid.
 */
export const hideClientSchema = z.object({
  params: z.object({ organizationId: existing('El id de la organización no es válido', 'Falta la organización') }),
})

/** A calendar day that exists: «2026-02-30» has the shape and is not one. */
const isRealDay = (value: string) => {
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}
const day = (label: string) =>
  z
    .string({ required_error: `Falta la fecha ${label}`, invalid_type_error: `La fecha ${label} no es válida` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, `La fecha ${label} va como AAAA-MM-DD`)
    .refine(isRealDay, `La fecha ${label} no existe`)

/** GET /crm/reports?desde=&hasta= — days on Mexico City's calendar. Their order and the one-year cap are the service's. */
export const reportsSchema = z.object({ query: z.object({ desde: day('inicial'), hasta: day('final') }) })

/** GET /crm/export.csv — the list's own filters, without its paging: the service walks the pages. */
export const exportAccountsSchema = z.object({ query: listAccountsSchema.shape.query.omit({ cursor: true, limit: true }) })

// ── Email templates, preview, test and images (phase 2, plan task 2) ──────────────────────────────────────────────────

const MAX_BLOCKS = 50
/** A template is a handful of paragraphs; this cap only stops a body that wants to be a file. */
const MAX_BLOCKS_BYTES = 100_000

/** The first thing wrong with the blocks, in Spanish: the catalog's own messages are the library's English. */
function blocksMessage(error: z.ZodError): string {
  const issue = error.issues[0]
  const index = typeof issue.path[0] === 'number' ? issue.path[0] + 1 : null
  if (index === null) return 'Agrega al menos un bloque al correo'
  const field = issue.path[1]
  if (field === 'url') return `El bloque ${index} necesita una dirección válida que empiece con http:// o https://`
  if (field === 'text' || field === 'label' || field === 'alt') return `El bloque ${index} no puede quedar vacío`
  return `El bloque ${index} no es válido: elige un tipo de bloque que exista`
}

/**
 * The blocks of an email, through the SAME catalog the businesses' campaigns use (`bloqueCampanaSchema`): nobody writes
 * HTML, the server renders it, and a `javascript:` link never gets saved. Shape only; the variables are the service's.
 */
const emailBlocks = z.unknown().transform((value, ctx) => {
  if (!Array.isArray(value)) {
    ctx.addIssue({ code: 'custom', message: 'El contenido del correo debe ser una lista de bloques' })
    return z.NEVER
  }
  if (value.length > MAX_BLOCKS) {
    ctx.addIssue({ code: 'custom', message: `Máximo ${MAX_BLOCKS} bloques por correo` })
    return z.NEVER
  }
  const parsed = bloquesCampanaSchema.safeParse(value)
  if (!parsed.success) {
    ctx.addIssue({ code: 'custom', message: blocksMessage(parsed.error) })
    return z.NEVER
  }
  if (JSON.stringify(parsed.data).length > MAX_BLOCKS_BYTES) {
    ctx.addIssue({ code: 'custom', message: 'El correo es demasiado largo' })
    return z.NEVER
  }
  return parsed.data
})
const emailSubject = text(200, 'El asunto es obligatorio')
const templateName = text(120, 'El nombre de la plantilla es obligatorio')

/** GET /crm/templates. The page size has no upper bound here: the service caps it at 100. `archivadas=true` lists only those. */
export const listTemplatesSchema = z.object({
  query: z.object({
    cursor: cuid.optional(),
    limit: listAccountsSchema.shape.query.shape.limit,
    archivadas: flagQuery,
  }),
})

/** GET /crm/templates/:id, POST /crm/templates/:id/archive y /unarchive */
export const templateIdSchema = z.object({ params: byId })

/** POST /crm/templates */
export const createTemplateSchema = z.object({
  body: z.object({ name: templateName, subject: emailSubject, blocks: emailBlocks }),
})

/** PATCH /crm/templates/:id — only what changes. */
export const updateTemplateSchema = z.object({
  params: byId,
  body: z
    .object({ name: templateName.optional(), subject: emailSubject.optional(), blocks: emailBlocks.optional() })
    .refine(somethingToChange, 'No hay nada que cambiar'),
})

/**
 * POST /crm/templates/preview. With `contexto`, the real data of that account (and of one of its contacts); without it, the
 * example data. The service answers 404 for an account outside the caller's scope.
 */
export const previewTemplateSchema = z.object({
  body: z.object({
    subject: emailSubject,
    blocks: emailBlocks,
    contexto: z.object({ accountId: cuid, contactId: cuid.optional() }).optional(),
  }),
})

/** POST /crm/templates/test — «Envíame una prueba». */
export const sendTemplateTestSchema = z.object({ body: z.object({ subject: emailSubject, blocks: emailBlocks }) })

/**
 * POST /crm/accounts/:id/emails — «Mandar correo» desde el Gmail del vendedor. `clientRequestId` lo genera el diálogo al
 * abrirse (un UUID): dos clics con el mismo son UN correo.
 */
export const sendAccountEmailSchema = z.object({
  params: byId,
  body: z.object({
    contactId: cuid,
    subject: emailSubject,
    blocks: emailBlocks,
    clientRequestId: z
      .string({ required_error: 'Falta el identificador del envío', invalid_type_error: 'El identificador del envío no es válido' })
      .regex(/^[A-Za-z0-9_-]{8,100}$/, 'El identificador del envío no es válido'),
  }),
})

/** POST /crm/opt-outs — «Dar de baja este correo» (la oposición). El correo se guarda en minúsculas, como el del equipo. */
export const createOptOutSchema = z.object({
  body: z.object({
    email: z
      .string({ required_error: 'El correo es obligatorio', invalid_type_error: 'El correo es obligatorio' })
      .trim()
      .toLowerCase()
      .email('El correo no es válido')
      .max(254, 'El correo es demasiado largo'),
  }),
})

// ── Audiences of the mass-email campaigns (phase 2, plan task 4) ───────────────────────────────────────────────────────

/** A filter is a handful of values; this only stops a body that wants to turn the SQL into a book. */
const MAX_FILTER_VALUES = 50

/** `giros` and `ciudades`: a list of short texts. Shape only; an unknown giro simply matches nobody. */
const textFilter = (singular: string, plural: string) =>
  z
    .array(
      z
        .string({ invalid_type_error: `Cada ${singular} es un texto con letras` })
        .trim()
        .min(1, `Cada ${singular} es un texto con letras`)
        .max(100, 'Máximo 100 caracteres'),
      { invalid_type_error: `Los ${plural} van en una lista` },
    )
    .max(MAX_FILTER_VALUES, `Máximo ${MAX_FILTER_VALUES} ${plural}`)
    .optional()

const audienceRoles = z
  .array(z.nativeEnum(StaffRole, { errorMap: () => ({ message: 'Ese rol no existe' }) }), {
    required_error: 'Elige al menos un rol',
    invalid_type_error: 'Elige al menos un rol',
  })
  .min(1, 'Elige al menos un rol')
  .max(Object.keys(StaffRole).length, 'Hay roles repetidos')

/**
 * One public of a campaign. PROSPECTOS has no «source» filter on purpose: consent is born only in the landing today, so it
 * would be a filter that filters nothing. `etapas` are CrmStage ids.
 */
const audienceSegmentSchema = z.discriminatedUnion(
  'tipo',
  [
    z.object({
      tipo: z.literal('PROSPECTOS'),
      etapas: z
        .array(z.string({ invalid_type_error: 'El id de la etapa no es válido' }).cuid('El id de la etapa no es válido'))
        .max(MAX_FILTER_VALUES, `Máximo ${MAX_FILTER_VALUES} etapas`)
        .optional(),
    }),
    z.object({
      tipo: z.literal('CLIENTES'),
      giros: textFilter('giro', 'giros'),
      ciudades: textFilter('ciudad', 'ciudades'),
      planes: z
        .array(z.enum(['GRATIS', 'PRO', 'PREMIUM'], { errorMap: () => ({ message: 'Ese plan no existe' }) }))
        .max(3, 'Hay planes repetidos')
        .optional(),
    }),
    z.object({
      tipo: z.literal('USUARIOS'),
      roles: audienceRoles,
      giros: textFilter('giro', 'giros'),
      ciudades: textFilter('ciudad', 'ciudades'),
      soloClientes: z.boolean({ invalid_type_error: 'Solo clientes es sí o no' }).optional(),
    }),
  ],
  { errorMap: () => ({ message: 'Ese público no existe' }) },
)

/** Who a campaign goes to: 1 to 3 publics, ONE of each type. Who actually receives it is the service's, in SQL. */
export const audienciaSchema = z
  .object({
    segmentos: z
      .array(audienceSegmentSchema, { required_error: 'Elige a quién le mandas', invalid_type_error: 'Elige a quién le mandas' })
      .min(1, 'Elige al menos un público')
      .max(3, 'Máximo 3 públicos'),
  })
  .superRefine((audience, ctx) => {
    const seen = new Set<string>()
    audience.segmentos.forEach((segment, i) => {
      if (seen.has(segment.tipo))
        ctx.addIssue({ code: 'custom', path: ['segmentos', i, 'tipo'], message: 'Ese público ya está en la lista' })
      seen.add(segment.tipo)
    })
  })

export type Audiencia = z.infer<typeof audienciaSchema>
export type Segmento = Audiencia['segmentos'][number]

// ── Mass-email campaigns (phase 2, plan task 5) ────────────────────────────────────────────────────────────────────────

const campaignName = text(120, 'El nombre de la campaña es obligatorio')

/** GET /crm/campaigns. The page size has no upper bound here: the service caps it at 100. */
export const listCampaignsSchema = z.object({
  query: z.object({
    cursor: cuid.optional(),
    limit: listAccountsSchema.shape.query.shape.limit,
    status: z.enum(['BORRADOR', 'ENVIANDO', 'ENVIADA', 'CANCELADA'], { errorMap: () => ({ message: 'Ese estado no existe' }) }).optional(),
  }),
})

/** GET /crm/campaigns/:id and POST /crm/campaigns/:id/preview, /test and /cancel */
export const campaignIdSchema = z.object({ params: byId })

/** POST /crm/campaigns — from a template: its subject and blocks are copied. */
export const createCampaignSchema = z.object({
  body: z.object({ name: campaignName, templateId: z.string({ required_error: 'Elige una plantilla' }).cuid('La plantilla no es válida') }),
})

/** PATCH /crm/campaigns/:id — only what changes, only while it is a draft (the service answers 409 otherwise). */
export const updateCampaignSchema = z.object({
  params: byId,
  body: z
    .object({
      name: campaignName.optional(),
      subject: emailSubject.optional(),
      blocks: emailBlocks.optional(),
      audience: audienciaSchema.optional(),
    })
    .refine(somethingToChange, 'No hay nada que cambiar'),
})

/** POST /crm/campaigns/:id/send — the token the preview gave, which ties what was seen to what is sent. */
export const sendCampaignSchema = z.object({
  params: byId,
  body: z.object({
    token: z
      .string({ required_error: 'Falta la confirmación', invalid_type_error: 'Falta la confirmación' })
      .min(1, 'Falta la confirmación')
      .max(2000, 'La confirmación no es válida'),
  }),
})
