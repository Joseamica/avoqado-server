/**
 * La forma de la audiencia de una campaña (fase 2, tarea 4): de 1 a 3 públicos, UNO de cada tipo, y los filtros de cada
 * uno. Sólo forma y mensajes en español; qué correos salen lo contesta la base (`audiencias.integration.test.ts`).
 */
import { audienciaSchema } from '@/schemas/crm.schema'

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

  it('pide de 1 a 3 públicos, y ninguno repetido', () => {
    expect(mensajes({ segmentos: [] })).toEqual(['Elige al menos un público'])
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
