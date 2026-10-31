import { Prisma } from '@prisma/client'

/**
 * CRM propio, tarea 1: la forma del esquema que usan las tareas siguientes, leída del DMMF (no necesita base).
 *
 * Las llaves únicas son el contrato de la concurrencia: el upsert por fuente + llave externa, un negocio del CRM por
 * Organization, un aviso diario por persona y el barrido que no repite eventos. El teléfono y el correo de una persona
 * sólo AVISAN de duplicados: un índice único ahí tumbaría escrituras legítimas (el mismo dueño con dos negocios).
 * Y nada de enums de Postgres: el servidor compartido del 3000 revienta al leer un valor de enum que no conoce.
 */
const MODELOS = [
  'PlatformAccess',
  'CrmAccount',
  'CrmContact',
  'CrmStage',
  'CrmLostReason',
  'CrmActivity',
  'CrmTimelineEvent',
  'CrmInboundEntry',
  'CrmDigestSend',
] as const

const modelo = (nombre: string) => Prisma.dmmf.datamodel.models.find(m => m.name === nombre)
const campo = (nombreModelo: string, nombreCampo: string) => modelo(nombreModelo)?.fields.find(f => f.name === nombreCampo)

describe('CRM propio — forma del esquema', () => {
  it('existen los 9 modelos', () => {
    expect(MODELOS.filter(nombre => !modelo(nombre))).toEqual([])
  })

  it('CrmAccount: fuente + llave externa es única, y hay un solo negocio del CRM por Organization', () => {
    expect(modelo('CrmAccount')?.uniqueFields).toContainEqual(['source', 'externalKey'])
    expect(campo('CrmAccount', 'organizationId')).toMatchObject({ isUnique: true, isRequired: false })
  })

  it('CrmContact: ni el teléfono ni el correo son únicos', () => {
    expect(campo('CrmContact', 'phoneE164')).toMatchObject({ isUnique: false })
    expect(campo('CrmContact', 'email')).toMatchObject({ isUnique: false })
    expect(modelo('CrmContact')?.uniqueFields).toEqual([])
  })

  it('las demás llaves únicas de las que dependen el alta de llaves, los catálogos, el barrido y el aviso diario', () => {
    expect(campo('PlatformAccess', 'email')?.isUnique).toBe(true)
    expect(campo('CrmStage', 'name')?.isUnique).toBe(true)
    expect(campo('CrmLostReason', 'name')?.isUnique).toBe(true)
    expect(campo('CrmTimelineEvent', 'sourceKey')).toMatchObject({ isUnique: true, isRequired: false })
    expect(modelo('CrmDigestSend')?.uniqueFields).toContainEqual(['staffId', 'day', 'kind'])
  })

  it('ningún campo de los modelos nuevos usa un enum de Prisma: tipos, fuentes y estados van como String', () => {
    for (const nombre of MODELOS) expect(modelo(nombre)).toBeDefined()
    const conEnum = MODELOS.flatMap(nombre => (modelo(nombre)?.fields ?? []).filter(f => f.kind === 'enum').map(f => `${nombre}.${f.name}`))
    expect(conEnum).toEqual([])
  })

  // Regresión: la migración es aditiva. Staff y Organization sólo ganan la relación inversa (virtual, sin columna):
  // la llave foránea vive en la tabla nueva, nunca en la existente.
  it('Staff y Organization no ganan ninguna columna: sólo la relación inversa hacia el CRM', () => {
    const nuevos: readonly string[] = MODELOS
    for (const existente of ['Staff', 'Organization']) {
      const haciaElCrm = (modelo(existente)?.fields ?? []).filter(f => nuevos.includes(f.type))
      expect(haciaElCrm.length).toBeGreaterThan(0)
      for (const f of haciaElCrm) expect({ campo: f.name, columnas: f.relationFromFields ?? [] }).toEqual({ campo: f.name, columnas: [] })
    }
  })
})
