/**
 * D24 (5-nov-2026): los mensajes por default de Zod, en español, para todo el proceso.
 *
 * `validateRequest` (y varios controladores y el MCP) enseñan el mensaje de Zod tal cual. Cuando un esquema no
 * escribió el suyo (un tipo equivocado: `marketingConsent: "false"`, `tags: "VIP"`, `phone: 42`), salía el de Zod en
 * inglés («Expected boolean, received string»). Este errorMap global sólo llena ESE hueco: en Zod 3 el mensaje del
 * check (`.min(1, '…')`), el `errorMap`/`invalid_type_error`/`required_error` del esquema y el del `parse` ganan
 * siempre sobre el global. Se instala al importar este archivo (lo importan `app.ts` y `validation.ts`).
 */
import { z, ZodIssueCode, ZodParsedType } from 'zod'

const TIPOS: Partial<Record<string, string>> = {
  [ZodParsedType.string]: 'texto',
  [ZodParsedType.number]: 'un número',
  [ZodParsedType.integer]: 'un número entero',
  [ZodParsedType.float]: 'un número',
  [ZodParsedType.bigint]: 'un número entero',
  [ZodParsedType.nan]: 'algo que no es número',
  [ZodParsedType.boolean]: 'sí o no',
  [ZodParsedType.date]: 'una fecha',
  [ZodParsedType.array]: 'una lista',
  [ZodParsedType.object]: 'un objeto',
  [ZodParsedType.null]: 'vacío',
  [ZodParsedType.undefined]: 'nada',
  [ZodParsedType.function]: 'una función',
  [ZodParsedType.map]: 'un mapa',
  [ZodParsedType.set]: 'un conjunto',
  [ZodParsedType.symbol]: 'un símbolo',
  [ZodParsedType.promise]: 'una promesa',
}
const tipo = (t: string) => TIPOS[t] ?? 'otro tipo de dato'

const FORMATOS: Partial<Record<string, string>> = {
  email: 'El correo no es válido',
  url: 'La dirección web no es válida',
  emoji: 'Sólo se aceptan emojis',
  uuid: 'El identificador no es válido',
  nanoid: 'El identificador no es válido',
  cuid: 'El identificador no es válido',
  cuid2: 'El identificador no es válido',
  ulid: 'El identificador no es válido',
  datetime: 'La fecha y hora no son válidas',
  date: 'La fecha no es válida',
  time: 'La hora no es válida',
  duration: 'La duración no es válida',
  ip: 'La dirección IP no es válida',
  cidr: 'El rango de IP no es válido',
  base64: 'El texto en base64 no es válido',
  base64url: 'El texto en base64 no es válido',
  jwt: 'El token no es válido',
  regex: 'El formato no es válido',
}

const fecha = (v: number | bigint) => new Date(Number(v)).toLocaleDateString('es-MX')

/** Mínimo o máximo, en palabras, según de qué se trate. */
function limite(
  lado: 'min' | 'max',
  type: 'string' | 'number' | 'array' | 'set' | 'date' | 'bigint',
  n: number | bigint,
  inclusive: boolean,
  exact?: boolean,
) {
  if (type === 'string' || type === 'array' || type === 'set') {
    const unidad = type === 'string' ? (n === 1 ? 'carácter' : 'caracteres') : n === 1 ? 'elemento' : 'elementos'
    if (type === 'string' && lado === 'min' && n === 1 && !exact) return 'No puede quedar vacío'
    if (exact) return `Debe tener exactamente ${n} ${unidad}`
    if (lado === 'min') return inclusive ? `Debe tener al menos ${n} ${unidad}` : `Debe tener más de ${n} ${unidad}`
    return inclusive ? `Debe tener como máximo ${n} ${unidad}` : `Debe tener menos de ${n} ${unidad}`
  }
  if (type === 'date') {
    if (exact) return `La fecha debe ser el ${fecha(n)}`
    if (lado === 'min') return inclusive ? `La fecha debe ser el ${fecha(n)} o después` : `La fecha debe ser después del ${fecha(n)}`
    return inclusive ? `La fecha debe ser el ${fecha(n)} o antes` : `La fecha debe ser antes del ${fecha(n)}`
  }
  if (exact) return `Debe ser exactamente ${n}`
  if (lado === 'min') return inclusive ? `Debe ser mayor o igual a ${n}` : `Debe ser mayor a ${n}`
  return inclusive ? `Debe ser menor o igual a ${n}` : `Debe ser menor a ${n}`
}

export const zodEnEspanol: z.ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        // Sin el campo delante (validateRequest ya no lo pone), «obligatorio» a secas no decía QUÉ falta (credit-packs,
        // 6-nov). Se nombra el último segmento de la ruta; un esquema que quiera un texto propio usa `required_error`.
        const campo = [...issue.path].reverse().find(p => typeof p === 'string')
        return { message: campo ? `Falta el dato «${campo}»` : 'Falta un dato obligatorio' }
      }
      return { message: `Se esperaba ${tipo(issue.expected)} y llegó ${tipo(issue.received)}` }
    case ZodIssueCode.invalid_literal:
      return {
        message: `Se esperaba el valor ${typeof issue.expected === 'bigint' ? `${issue.expected}` : JSON.stringify(issue.expected)}`,
      }
    case ZodIssueCode.unrecognized_keys:
      return { message: `Estos datos no se aceptan: ${issue.keys.join(', ')}` }
    case ZodIssueCode.invalid_union:
      return { message: 'El dato no es válido' }
    case ZodIssueCode.invalid_union_discriminator:
      return { message: `Tipo no válido. Opciones: ${issue.options.map(o => String(o)).join(', ')}` }
    case ZodIssueCode.invalid_enum_value:
      return { message: `Opción no válida. Opciones: ${issue.options.map(o => String(o)).join(', ')}` }
    case ZodIssueCode.invalid_arguments:
      return { message: 'Los argumentos no son válidos' }
    case ZodIssueCode.invalid_return_type:
      return { message: 'La respuesta no es válida' }
    case ZodIssueCode.invalid_date:
      return { message: 'La fecha no es válida' }
    case ZodIssueCode.invalid_string: {
      const v = issue.validation
      if (typeof v === 'object') {
        if ('includes' in v) return { message: `Debe incluir «${v.includes}»` }
        if ('startsWith' in v) return { message: `Debe empezar con «${v.startsWith}»` }
        if ('endsWith' in v) return { message: `Debe terminar con «${v.endsWith}»` }
        return { message: 'El texto no es válido' }
      }
      return { message: FORMATOS[v] ?? 'El texto no es válido' }
    }
    case ZodIssueCode.too_small:
      return { message: limite('min', issue.type, issue.minimum, issue.inclusive, issue.exact) }
    case ZodIssueCode.too_big:
      return { message: limite('max', issue.type, issue.maximum, issue.inclusive, issue.exact) }
    case ZodIssueCode.invalid_intersection_types:
      return { message: 'Los datos no son compatibles entre sí' }
    case ZodIssueCode.not_multiple_of:
      return { message: `Debe ser múltiplo de ${issue.multipleOf}` }
    case ZodIssueCode.not_finite:
      return { message: 'El número debe ser finito' }
    case ZodIssueCode.custom:
      return { message: 'El dato no es válido' }
    default:
      return { message: ctx.defaultError }
  }
}

z.setErrorMap(zodEnEspanol)

/**
 * Los motivos de Zod, legibles para quien usa el panel o la app: sin el nombre técnico del campo delante
 * («marketingConsent: …» era inglés para el usuario) y sin repetir la misma frase. El dashboard ya lo quitaba en algunas
 * pantallas (`StaffPay/rangos.ts`); ahora sale así de origen.
 */
export const motivosDeZod = (issues: z.ZodIssue[]) => [...new Set(issues.map(issue => issue.message))].join(', ')
