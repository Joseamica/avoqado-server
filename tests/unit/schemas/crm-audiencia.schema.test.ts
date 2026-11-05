/**
 * La forma de la audiencia de una campaña (fase 2, tarea 4): de 0 a 3 públicos, UNO de cada tipo, los filtros de cada
 * uno y las personas quitadas o agregadas a mano (plan B, tarea 4). Sólo forma y mensajes en español; qué correos salen lo
 * contesta la base (`audiencias.integration.test.ts`).
 */
import { audienciaSchema, MAX_PERSONAS_SUELTAS, updateCampaignSchema } from '@/schemas/crm.schema'

const CUID = 'cstage0000000000000000001'
const mensajes = (value: unknown) => {
  const result = audienciaSchema.safeParse(value)
  return result.success ? [] : result.error.issues.map(i => i.message)
}

describe('audienciaSchema', () => {
  it('acepta los tres públicos con todos sus filtros', () => {
    const audiencia = {
      segmentos: [
        { tipo: 'PROSPECTOS', etapas: [CUID] },
        { tipo: 'CLIENTES', giros: ['BAR'], ciudades: ['CDMX'], planes: ['GRATIS', 'PRO', 'PREMIUM'] },
        { tipo: 'USUARIOS', roles: ['OWNER', 'MANAGER'], giros: ['RESTAURANT'], ciudades: ['CDMX'], soloClientes: true },
      ],
    }
    expect(audienciaSchema.parse(audiencia)).toEqual(audiencia)
  })

  it('los filtros son opcionales', () => {
    expect(mensajes({ segmentos: [{ tipo: 'PROSPECTOS' }, { tipo: 'CLIENTES' }] })).toEqual([])
  })

  // Cambio a propósito (plan B, tarea 4): un borrador puede quedar sin públicos («Limpiar»); antes pedía de 1 a 3.
  it('un borrador puede quedar sin públicos: { segmentos: [] } pasa; más de 3 o uno repetido no', () => {
    expect(mensajes({ segmentos: [] })).toEqual([])
    expect(mensajes({ segmentos: [{ tipo: 'CLIENTES' }, { tipo: 'CLIENTES' }] })).toEqual(['Ese público ya está en la lista'])
    expect(
      mensajes({ segmentos: [{ tipo: 'CLIENTES' }, { tipo: 'PROSPECTOS' }, { tipo: 'USUARIOS', roles: ['OWNER'] }, { tipo: 'CLIENTES' }] }),
    ).toContain('Máximo 3 públicos')
    expect(mensajes({})).toEqual(['Elige a quién le mandas'])
  })

  it('un público que no existe se rechaza en español', () => {
    expect(mensajes({ segmentos: [{ tipo: 'TODOS' }] })).toEqual(['Ese público no existe'])
    expect(mensajes({ segmentos: [{}] })).toEqual(['Ese público no existe'])
  })

  it('los usuarios llevan al menos un rol que exista', () => {
    expect(mensajes({ segmentos: [{ tipo: 'USUARIOS' }] })).toEqual(['Elige al menos un rol'])
    expect(mensajes({ segmentos: [{ tipo: 'USUARIOS', roles: [] }] })).toEqual(['Elige al menos un rol'])
    expect(mensajes({ segmentos: [{ tipo: 'USUARIOS', roles: ['JEFE'] }] })).toEqual(['Ese rol no existe'])
  })

  it('los planes son GRATIS, PRO o PREMIUM y las etapas son ids', () => {
    expect(mensajes({ segmentos: [{ tipo: 'CLIENTES', planes: ['ENTERPRISE'] }] })).toEqual(['Ese plan no existe'])
    expect(mensajes({ segmentos: [{ tipo: 'PROSPECTOS', etapas: ['Nuevo'] }] })).toEqual(['El id de la etapa no es válido'])
  })

  it('acota las listas de filtros para que el SQL no crezca sin tope', () => {
    const muchos = Array.from({ length: 51 }, (_, i) => `Ciudad ${i}`)
    expect(mensajes({ segmentos: [{ tipo: 'CLIENTES', ciudades: muchos }] })).toEqual(['Máximo 50 ciudades'])
    expect(mensajes({ segmentos: [{ tipo: 'CLIENTES', giros: [''] }] })).toEqual(['Cada giro es un texto con letras'])
    expect(mensajes({ segmentos: [{ tipo: 'CLIENTES', ciudades: ['x'.repeat(101)] }] })).toEqual(['Máximo 100 caracteres'])
  })
})

// Plan B, tarea 4: las personas quitadas (`excluir`) y agregadas (`incluir`) a mano. 🔴 La pantalla compara el JSON guardado con el
// suyo para contar: si el servidor reordena o junta, la firma nunca iguala y el conteo se queda en «Contando…».
describe('audienciaSchema — excluir e incluir', () => {
  it('acepta excluir e incluir y devuelve EXACTAMENTE el mismo orden que recibió, con las llaves en el orden del esquema', () => {
    const r = audienciaSchema.parse({ incluir: ['z@x.mx', 'c@x.mx'], excluir: ['b@x.mx', 'a@x.mx'], segmentos: [] })
    expect(r.excluir).toEqual(['b@x.mx', 'a@x.mx'])
    expect(r.incluir).toEqual(['z@x.mx', 'c@x.mx'])
    expect(Object.keys(r)).toEqual(['segmentos', 'excluir', 'incluir'])
  })

  it('normaliza cada correo (espacios y mayúsculas) sin cambiar el orden', () => {
    expect(audienciaSchema.parse({ segmentos: [], excluir: ['  Ana@X.mx ', 'beto@x.mx'] }).excluir).toEqual(['ana@x.mx', 'beto@x.mx'])
  })

  it('un correo repetido en excluir o en incluir se rechaza con «Esa persona ya está en la lista» (también tras normalizar)', () => {
    expect(mensajes({ segmentos: [], excluir: ['a@x.mx', 'a@x.mx'] })).toEqual(['Esa persona ya está en la lista'])
    expect(mensajes({ segmentos: [], incluir: ['a@x.mx', ' A@X.MX'] })).toEqual(['Esa persona ya está en la lista'])
    // Estar en las dos listas no es un repetido: lo resuelve el servidor (`excluir` gana).
    expect(mensajes({ segmentos: [], excluir: ['a@x.mx'], incluir: ['a@x.mx'] })).toEqual([])
  })

  it('más de 500 se rechaza con «Máximo 500 personas»; un correo sin forma, con «El correo no es válido»', () => {
    const muchos = Array.from({ length: MAX_PERSONAS_SUELTAS + 1 }, (_, i) => `p${i}@x.mx`)
    expect(MAX_PERSONAS_SUELTAS).toBe(500)
    expect(mensajes({ segmentos: [], excluir: muchos })).toEqual(['Máximo 500 personas'])
    expect(mensajes({ segmentos: [], incluir: muchos.slice(0, 500) })).toEqual([])
    for (const malo of ['ana', 'ana@x', 'a na@x.mx', '', `${'a'.repeat(250)}@x.mx`, 7]) {
      expect(mensajes({ segmentos: [], incluir: [malo] })).toEqual(['El correo no es válido'])
    }
  })

  it('🔴 un público viejo sin las llaves nuevas sale igual, sin llaves extra', () => {
    const viejo = {
      segmentos: [
        { tipo: 'PROSPECTOS', etapas: [CUID] },
        { tipo: 'CLIENTES', planes: ['PRO'] },
      ],
    }
    expect(JSON.stringify(audienciaSchema.parse(viejo))).toBe(JSON.stringify(viejo))
  })
})

describe('updateCampaignSchema — basePublico', () => {
  const ID = 'ccampaign000000000000001'
  const body = (b: unknown) => {
    const r = updateCampaignSchema.safeParse({ params: { id: ID }, body: b })
    return r.success ? [] : r.error.issues.map(i => i.message)
  }

  it('basePublico viaja con el público; solo no cambia nada, y vacío o enorme se rechaza en español', () => {
    expect(body({ audience: { segmentos: [] }, basePublico: 'a'.repeat(64) })).toEqual([])
    expect(body({ basePublico: 'a'.repeat(64) })).toEqual(['No hay nada que cambiar'])
    expect(body({ audience: { segmentos: [] }, basePublico: '' })).toEqual(['La versión que ves no es válida'])
    expect(body({ audience: { segmentos: [] }, basePublico: 'a'.repeat(201) })).toEqual(['La versión que ves no es válida'])
    // La pantalla vieja no lo manda: sigue igual.
    expect(body({ audience: { segmentos: [{ tipo: 'PROSPECTOS' }] } })).toEqual([])
  })
})
