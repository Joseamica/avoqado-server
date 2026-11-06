import { Prisma } from '@prisma/client'
import { createAccountSchema } from '@/schemas/crm.schema'

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
  'CrmTeam',
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
  it('existen los 10 modelos', () => {
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
    // Ruling 10: a key row is claimed by ONE Staff, so a recycled or changed email never inherits it.
    expect(campo('PlatformAccess', 'staffId')).toMatchObject({ isUnique: true, isRequired: false })
    // Ruling 14: ONE sales team, with its own organization and venue, each one held by no other team row.
    expect(campo('CrmTeam', 'key')).toMatchObject({ isUnique: true, hasDefaultValue: true, default: 'default' })
    expect(campo('CrmTeam', 'organizationId')).toMatchObject({ isUnique: true, isRequired: true })
    expect(campo('CrmTeam', 'venueId')).toMatchObject({ isUnique: true, isRequired: true })
    // N-2: deleting the team's organization or venue fails in plain sight instead of leaving CrmTeam pointing at nothing.
    expect(campo('CrmTeam', 'organization')).toMatchObject({ relationFromFields: ['organizationId'], relationOnDelete: 'Restrict' })
    expect(campo('CrmTeam', 'venue')).toMatchObject({ relationFromFields: ['venueId'], relationOnDelete: 'Restrict' })
    expect(campo('CrmStage', 'name')?.isUnique).toBe(true)
    expect(campo('CrmLostReason', 'name')?.isUnique).toBe(true)
    expect(campo('CrmTimelineEvent', 'sourceKey')).toMatchObject({ isUnique: true, isRequired: false })
    expect(modelo('CrmDigestSend')?.uniqueFields).toContainEqual(['staffId', 'day', 'kind'])
  })

  // Ruling 12: an account left «Sin dueño» takes its pending activities with it, to nobody.
  it('una actividad puede quedar sin responsable', () => {
    expect(campo('CrmActivity', 'assigneeStaffId')).toMatchObject({ isRequired: false })
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

describe('esquemas de la prueba con destino', () => {
  const { sendTemplateTestSchema, campaignTestSchema } = jest.requireActual('@/schemas/crm.schema')
  const id = 'cstaffotro0000000000000001'
  it('la plantilla acepta destinoStaffId opcional y sigue exigiendo subject y blocks', () => {
    const blocks = [{ type: 'paragraph', text: 'Hola' }]
    expect(sendTemplateTestSchema.safeParse({ body: { subject: 'Hola', blocks } }).success).toBe(true)
    expect(sendTemplateTestSchema.safeParse({ body: { subject: 'Hola', blocks, destinoStaffId: id } }).success).toBe(true)
    expect(sendTemplateTestSchema.safeParse({ body: { blocks } }).success).toBe(false)
  })
  it('la campaña acepta body ausente, vacío o con destino', () => {
    for (const body of [undefined, {}, { destinoStaffId: id }])
      expect(campaignTestSchema.safeParse({ params: { id }, body }).success).toBe(true)
    expect(campaignTestSchema.safeParse({ params: { id }, body: { destinoStaffId: 'x' } }).success).toBe(false)
  })
})

describe('POST /crm/accounts: la casilla «Aceptó recibir correos»', () => {
  const parse = (contact: Record<string, unknown>) => createAccountSchema.safeParse({ body: { name: 'Café', contact } })
  const mensajes = (r: ReturnType<typeof parse>) => (r.success ? [] : r.error.issues.map(i => i.message))

  it('aceptaCorreos: true sin correo es 400 con «Para que reciba correos, escribe su correo»', () => {
    expect(mensajes(parse({ name: 'Paola', aceptaCorreos: true }))).toContain('Para que reciba correos, escribe su correo')
  })

  it('aceptaCorreos: true con correo pasa, y false sin correo también', () => {
    expect(parse({ name: 'Paola', email: 'p@cafe.mx', aceptaCorreos: true }).success).toBe(true)
    expect(parse({ name: 'Paola', aceptaCorreos: false }).success).toBe(true)
    expect(parse({ name: 'Paola' }).success).toBe(true)
  })

  it("aceptaCorreos: 'si' es «Aceptó recibir correos es sí o no»", () => {
    expect(mensajes(parse({ name: 'Paola', email: 'p@cafe.mx', aceptaCorreos: 'si' }))).toContain('Aceptó recibir correos es sí o no')
  })
})

describe('GET /crm/clients: los filtros de C1', () => {
  const { listClientsSchema } = jest.requireActual('@/schemas/crm.schema')
  const parse = (query: Record<string, string>) => listClientsSchema.safeParse({ query })
  const mensajes = (r: ReturnType<typeof parse>) => (r.success ? [] : r.error.issues.map((i: { message: string }) => i.message))

  it('acepta cada valor de Usa (con AVISO), Plan, Estado y Motivo (con SIN_MOTIVO)', () => {
    for (const usa of ['AMBOS', 'TERMINAL', 'POS', 'NO_IDENTIFICADO', 'NINGUNO', 'AVISO']) expect(parse({ usa }).success).toBe(true)
    for (const nivel of ['FREE', 'PRO', 'PREMIUM']) expect(parse({ nivel }).success).toBe(true)
    for (const estado of ['ALTA_SIN_TARJETA', 'COBRA', 'SIN_COBROS', 'NUNCA']) expect(parse({ estado }).success).toBe(true)
    for (const motivo of ['PRECIO', 'NO_QUISO_TARJETA', 'SOLO_VEIA', 'OTRO_SISTEMA', 'PROBLEMA_TECNICO', 'DESPUES', 'OTRO', 'SIN_MOTIVO'])
      expect(parse({ motivo }).success).toBe(true)
    for (const dueno of ['MIOS', 'SIN_DUENO', 'cstaffoth0000000000000001']) expect(parse({ dueno }).success).toBe(true)
  })

  it('un valor que no existe dice «Ese filtro no existe»; ENTERPRISE no es un nivel', () => {
    for (const query of [{ usa: 'OTRA' }, { nivel: 'ENTERPRISE' }, { estado: 'PAGANDO' }, { motivo: 'CARO' }] as Array<
      Record<string, string>
    >)
      expect(mensajes(parse(query))).toEqual(['Ese filtro no existe'])
  })

  it('un dueño con forma rara dice «El dueño no es válido»', () => {
    expect(mensajes(parse({ dueno: "x' OR 1=1" }))).toEqual(['El dueño no es válido'])
  })

  it('«condicion» ya no es filtro (rediseño r3): se ignora y no llega al servicio', () => {
    const r = parse({ condicion: 'PAGADO', usa: 'POS' })
    expect(r.success).toBe(true)
    expect(r.success && r.data.query).toEqual({ usa: 'POS' })
  })
})

describe('POST /crm/accounts/:id/usa: el «✋ a mano» (C1, tarea 7)', () => {
  const { usaSchema } = jest.requireActual('@/schemas/crm.schema')
  const parse = (body: Record<string, unknown>) => usaSchema.safeParse({ params: { id: 'caccounta0000000000000001' }, body })
  const mensajes = (r: ReturnType<typeof parse>) => (r.success ? [] : r.error.issues.map((i: { message: string }) => i.message))

  it('un valor sin porqué dice «Escribe por qué (3 a 140 letras)»; con porqué de 2 letras, igual', () => {
    expect(mensajes(parse({ valor: 'TERMINAL' }))).toEqual(['Escribe por qué (3 a 140 letras)'])
    expect(mensajes(parse({ valor: 'TERMINAL', porque: 'ab' }))).toEqual(['Escribe por qué (3 a 140 letras)'])
    expect(parse({ valor: 'TERMINAL', porque: 'Lo vi en su local' }).success).toBe(true)
  })

  it('«OTRO», NINGUNO y NO_IDENTIFICADO no se escriben a mano → 400', () => {
    for (const valor of ['OTRO', 'NINGUNO', 'NO_IDENTIFICADO']) expect(parse({ valor, porque: 'porque sí' }).success).toBe(false)
  })

  it('«Leerlo solo» (valor null) es válido sin porqué', () => {
    expect(parse({ valor: null }).success).toBe(true)
  })

  it('el porqué pasa por trim y tiene tope de 140', () => {
    expect(parse({ valor: 'POS', porque: 'x'.repeat(141) }).success).toBe(false)
    expect(parse({ valor: 'POS', porque: '   a   ' }).success).toBe(false)
  })
})

describe('POST /crm/accounts/:id/alta: «¿Por qué se quedó?» (C1, tarea 8)', () => {
  const { altaMotivoSchema } = jest.requireActual('@/schemas/crm.schema')
  const parse = (body: Record<string, unknown>) => altaMotivoSchema.safeParse({ params: { id: 'caccounta0000000000000001' }, body })
  const mensajes = (r: ReturnType<typeof parse>) => (r.success ? [] : r.error.issues.map((i: { message: string }) => i.message))

  it('«Otro» sin texto dice «Escribe el motivo»', () => {
    expect(mensajes(parse({ motivo: 'OTRO', perdido: false }))).toEqual(['Escribe el motivo'])
    expect(parse({ motivo: 'OTRO', texto: 'Se fue con su cuñado', perdido: false }).success).toBe(true)
  })

  it('un texto con un motivo que no es «Otro» (o sin motivo) dice «El texto sólo va con «Otro»»', () => {
    expect(mensajes(parse({ motivo: 'PRECIO', texto: 'caro', perdido: false }))).toEqual(['El texto sólo va con «Otro»'])
    expect(mensajes(parse({ motivo: null, texto: 'caro', perdido: false }))).toEqual(['El texto sólo va con «Otro»'])
  })

  it('un texto vacío con un motivo de la lista se acepta (se ignora); con «Otro» sigue pidiendo el motivo; un texto que no es texto avisa en español', () => {
    expect(parse({ motivo: 'PRECIO', texto: '   ', perdido: false }).success).toBe(true)
    expect(mensajes(parse({ motivo: 'OTRO', texto: '  ', perdido: false }))).toEqual(['Escribe el motivo'])
    expect(mensajes(parse({ motivo: 'OTRO', texto: 5, perdido: false }))).toEqual(['El motivo debe ser un texto'])
  })

  it('motivo null con Perdido es válido; un motivo fuera de la lista y el texto de 201 letras no', () => {
    expect(parse({ motivo: null, perdido: true }).success).toBe(true)
    expect(parse({ motivo: 'TERMINO', perdido: false }).success).toBe(false)
    expect(parse({ motivo: 'OTRO', texto: 'x'.repeat(201), perdido: false }).success).toBe(false)
    expect(parse({ motivo: 'PRECIO' }).success).toBe(false)
  })
})
