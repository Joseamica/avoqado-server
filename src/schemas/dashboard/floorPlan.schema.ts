import { z } from 'zod'
import { FLOOR_PLAN_LIMITS } from '../../services/dashboard/floorPlan/floorPlan.types'

// Mensajes en español a propósito: el middleware de validación los muestra tal cual (regla de la casa).
const venueParams = z.object({ venueId: z.string().min(1, 'El venue es requerido') }).passthrough()

/**
 * Frases de un campo numérico. `campo` va en minúsculas y con su artículo («la posición», «las personas»): de ahí
 * salen «Falta la posición» / «Faltan las personas» y «La posición debe…» / «Las personas deben…».
 */
const frases = (campo: string) => {
  const plural = /^(los|las) /.test(campo)
  const sujeto = campo.charAt(0).toUpperCase() + campo.slice(1)
  return {
    falta: `${plural ? 'Faltan' : 'Falta'} ${campo}`,
    debe: `${sujeto} ${plural ? 'deben' : 'debe'}`,
    puede: `${sujeto} no ${plural ? 'pueden' : 'puede'}`,
  }
}
const num = (campo: string) => {
  const f = frases(campo)
  return z.number({ required_error: f.falta, invalid_type_error: `${f.debe} ser un número` })
}
const coord = (campo: string) => {
  const fuera = `${frases(campo).debe} estar dentro del plano`
  return num(campo).min(0, fuera).max(1, fuera)
}
const size = (campo: string) => {
  const f = frases(campo)
  return num(campo).gt(0, `${f.debe} ser mayor a cero`).max(1, `${f.puede} salirse del plano`)
}
const rotation = num('el giro')
  .int('El giro debe ser un número entero')
  .min(0, 'El giro debe estar entre 0 y 359 grados')
  .max(359, 'El giro debe estar entre 0 y 359 grados')
const key = z
  .string({ required_error: 'Falta la clave', invalid_type_error: 'Clave no válida' })
  .min(1, 'Clave vacía')
  .max(64, 'Clave demasiado larga')

const idOrClientId = (v: { id?: string; clientId?: string }, ctx: z.RefinementCtx) => {
  if (!!v.id === !!v.clientId)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Cada área y cada mesa necesita id o clientId (sólo uno)' })
}

const areaSchema = z
  .object(
    {
      id: key.optional(),
      clientId: key.optional(),
      name: z
        .string({ required_error: 'El área necesita un nombre', invalid_type_error: 'El nombre del área no es válido' })
        .trim()
        .min(1, 'El área necesita un nombre')
        .max(60, 'El nombre del área es muy largo'),
      floorShape: z.enum(['WIDE', 'SQUARE', 'TALL'], { errorMap: () => ({ message: 'Forma de área no válida' }) }),
      sortOrder: num('el orden').int('El orden debe ser entero').min(0, 'Orden no válido').max(999, 'Orden no válido'),
    },
    { invalid_type_error: 'Cada área debe ser un objeto' },
  )
  .strict('El área trae un campo no permitido')
  .superRefine(idOrClientId)

const tableSchema = z
  .object(
    {
      id: key.optional(),
      clientId: key.optional(),
      number: z
        .string({ required_error: 'La mesa necesita un número', invalid_type_error: 'El número de mesa debe ser texto' })
        .trim()
        .min(1, 'La mesa necesita un número')
        .max(20, 'El número de mesa es muy largo'),
      // 0 = «sin dato» (la sincronización de SoftRestaurant crea mesas así); el editor nunca lo ofrece al capturar.
      capacity: num('las personas')
        .int('Las personas deben ser un número entero')
        .min(0, 'Las personas no pueden ser negativas')
        .max(99, 'Máximo 99 personas por mesa'),
      shape: z.enum(['SQUARE', 'ROUND', 'RECTANGLE'], { errorMap: () => ({ message: 'Forma de mesa no válida' }) }),
      rotation,
      positionX: coord('la posición').nullable(),
      positionY: coord('la posición').nullable(),
      areaRef: key.nullable(),
    },
    { invalid_type_error: 'Cada mesa debe ser un objeto' },
  )
  .strict('La mesa trae un campo no permitido')
  .superRefine((v, ctx) => {
    idOrClientId(v, ctx)
    if ((v.positionX === null) !== (v.positionY === null))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'La mesa necesita ambas coordenadas o ninguna' })
  })

const elementSchema = z
  .object(
    {
      id: key.optional(),
      clientId: key.optional(),
      type: z.enum(['WALL', 'BAR_COUNTER', 'SERVICE_AREA', 'LABEL', 'DOOR'], {
        errorMap: () => ({ message: 'Tipo de elemento no válido' }),
      }),
      areaRef: key,
      positionX: coord('la posición'),
      positionY: coord('la posición'),
      width: size('el ancho').nullable().optional(),
      height: size('el alto').nullable().optional(),
      rotation,
      endX: coord('el final de la pared').nullable().optional(),
      endY: coord('el final de la pared').nullable().optional(),
      label: z.string({ invalid_type_error: 'El texto no es válido' }).trim().max(40, 'El texto es muy largo').nullable().optional(),
      color: z
        .string({ invalid_type_error: 'Color no válido' })
        .regex(/^#[0-9a-fA-F]{6}$/, 'Color no válido')
        .nullable()
        .optional(),
    },
    { invalid_type_error: 'Cada elemento debe ser un objeto' },
  )
  .strict('El elemento trae un campo no permitido')

export const getFloorPlanSchema = z.object({ params: venueParams })

export const publishFloorPlanSchema = z.object({
  params: venueParams,
  body: z
    .object(
      {
        saveId: z
          .string({ required_error: 'Falta el folio de guardado', invalid_type_error: 'Folio de guardado inválido' })
          .uuid('Folio de guardado inválido'),
        baseFingerprint: z
          .string({ required_error: 'Falta la huella del plano', invalid_type_error: 'Huella del plano inválida' })
          .regex(/^[0-9a-f]{16}$/, 'Huella del plano inválida'),
        areas: z
          .array(areaSchema, { required_error: 'Faltan las áreas', invalid_type_error: 'Las áreas deben ser una lista' })
          .max(FLOOR_PLAN_LIMITS.areas, `Máximo ${FLOOR_PLAN_LIMITS.areas} áreas por sucursal`),
        tables: z
          .array(tableSchema, { required_error: 'Faltan las mesas', invalid_type_error: 'Las mesas deben ser una lista' })
          .max(FLOOR_PLAN_LIMITS.tables, `Máximo ${FLOOR_PLAN_LIMITS.tables} mesas por sucursal`),
        elements: z
          .array(elementSchema, { required_error: 'Faltan los elementos', invalid_type_error: 'Los elementos deben ser una lista' })
          .max(FLOOR_PLAN_LIMITS.elements, `Máximo ${FLOOR_PLAN_LIMITS.elements} elementos en el plano`),
      },
      { invalid_type_error: 'El plano no es válido' },
    )
    .strict('El plano trae un campo no permitido'),
})

export type PublishFloorPlanBody = z.infer<typeof publishFloorPlanSchema>['body']
