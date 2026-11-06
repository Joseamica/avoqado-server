/**
 * D24 (5-nov): cuando un dato llega con el tipo equivocado, el SERVIDOR contestaba en inglés
 * («Expected boolean, received string»). Un errorMap global de Zod en español cubre los mensajes que ningún esquema
 * escribió. Los mensajes propios de cada esquema siguen ganando.
 */
import { z } from 'zod'
import '@/utils/zodEnEspanol'

// Las frases por default de Zod 3: si alguna sale, el errorMap no cubrió ese código.
const INGLES =
  /\b(Required|Expected|received|Invalid|must|contain|character|element|greater|less|than|Unrecognized|key\(s\)|multiple|Number|String|Array|input|literal|value)\b/

const primerMensaje = (schema: z.ZodTypeAny, valor: unknown) => {
  const r = schema.safeParse(valor)
  if (r.success) throw new Error(`se esperaba un rechazo para ${JSON.stringify(valor)}`)
  return r.error.issues[0].message
}

describe('errorMap global de Zod en español', () => {
  const casos: Array<[string, z.ZodTypeAny, unknown, RegExp]> = [
    ['invalid_type (boolean con texto)', z.boolean(), 'false', /Se esperaba sí o no y llegó texto/],
    ['invalid_type (lista con texto)', z.array(z.string()), 'VIP', /Se esperaba una lista y llegó texto/],
    ['invalid_type (texto con número)', z.string(), 42, /Se esperaba texto y llegó un número/],
    ['invalid_type (texto con null)', z.string(), null, /Se esperaba texto y llegó vacío/],
    ['invalid_type: falta el campo', z.object({ a: z.string() }), {}, /obligatorio/],
    ['too_small texto', z.string().min(3), 'ab', /al menos 3 caracteres/],
    ['too_small texto vacío', z.string().min(1), '', /No puede quedar vacío/],
    ['too_small número', z.number().min(5), 1, /mayor o igual a 5/],
    ['too_small número estricto', z.number().positive(), 0, /mayor a 0/],
    ['too_small lista', z.array(z.string()).min(2), ['a'], /al menos 2 elementos/],
    ['too_big texto', z.string().max(2), 'abc', /como máximo 2 caracteres/],
    ['too_big número', z.number().max(10), 11, /menor o igual a 10/],
    ['too_big lista', z.array(z.string()).max(1), ['a', 'b'], /como máximo 1 elemento/],
    ['too_small exacto', z.string().length(4), 'abc', /exactamente 4 caracteres/],
    ['invalid_string email', z.string().email(), 'x', /correo/],
    ['invalid_string url', z.string().url(), 'x', /dirección web/],
    ['invalid_string uuid', z.string().uuid(), 'x', /identificador/],
    ['invalid_string cuid', z.string().cuid(), 'x', /identificador/],
    ['invalid_string datetime', z.string().datetime(), 'x', /fecha y hora/],
    ['invalid_string regex', z.string().regex(/^a$/), 'b', /formato/],
    ['invalid_string startsWith', z.string().startsWith('ab'), 'x', /Debe empezar con «ab»/],
    ['invalid_enum_value', z.enum(['A', 'B']), 'C', /Opción no válida.*A, B/],
    ['invalid_enum_value (nativeEnum)', z.nativeEnum({ X: 'X', Y: 'Y' } as const), 'Z', /Opción no válida/],
    ['invalid_literal', z.literal(true), false, /Se esperaba el valor true/],
    ['unrecognized_keys', z.object({ a: z.string() }).strict(), { a: 'x', b: 1 }, /no se aceptan: b/],
    ['not_multiple_of', z.number().multipleOf(5), 7, /múltiplo de 5/],
    ['invalid_date', z.date(), new Date('no'), /fecha no es válida/],
    ['custom (refine sin mensaje)', z.string().refine(() => false), 'x', /no es válido/],
    ['invalid_union', z.union([z.string(), z.number()]), true, /no es válido/],
    ['número entero', z.number().int(), 1.5, /número entero/],
  ]

  it.each(casos)('%s sale en español', (_n, schema, valor, esperado) => {
    const mensaje = primerMensaje(schema, valor)
    expect(mensaje).toMatch(esperado)
    expect(mensaje).not.toMatch(INGLES)
  })

  describe('los mensajes propios del esquema siguen ganando', () => {
    it('mensaje en el check', () => {
      expect(primerMensaje(z.string().min(3, 'Muy corto'), 'a')).toBe('Muy corto')
    })
    it('errorMap del esquema', () => {
      expect(primerMensaje(z.enum(['A'], { errorMap: () => ({ message: 'Género no válido' }) }), 'B')).toBe('Género no válido')
    })
    it('invalid_type_error y required_error', () => {
      const s = z.string({ invalid_type_error: 'Debe ser texto', required_error: 'Falta el nombre' })
      expect(primerMensaje(s, 42)).toBe('Debe ser texto')
      expect(primerMensaje(z.object({ n: s }), {})).toBe('Falta el nombre')
    })
    it('refine con mensaje y strict con mensaje', () => {
      expect(
        primerMensaje(
          z.string().refine(() => false, 'Nope propio'),
          'x',
        ),
      ).toBe('Nope propio')
      expect(primerMensaje(z.object({}).strict('Sólo nombre'), { b: 1 })).toBe('Sólo nombre')
    })
    it('el errorMap pasado al parse gana sobre el global', () => {
      const r = z.string().safeParse(1, { errorMap: () => ({ message: 'del contexto' }) })
      expect(!r.success && r.error.issues[0].message).toBe('del contexto')
    })
  })
})
