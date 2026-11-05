/**
 * Lo que la lista de campañas (y la herramienta de MCP que la expone) promete: los contadores por estado de cada campaña
 * salen de UNA consulta agrupada para toda la página y, con los 7 estados de una delivery presentes, su suma es el `total`
 * que se encoló. El `total` y los contadores no pueden contar historias distintas.
 */
import { createHash } from 'crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StaffRole } from '@prisma/client'
import { z } from 'zod'
import { prismaMock } from '@tests/__helpers__/setup'
import type { McpScope } from '@/mcp/scope'
import { registerCrmTools } from '@/mcp/tools/crm'
import { getCrmAccess } from '@/services/crm/access.service'
import { contarAudiencia, personasNoElegibles, recorrerAudiencia } from '@/services/crm/email/audience.service'
import {
  cancelCampaign,
  enqueueCampaign,
  getCampaign,
  listCampaigns,
  previewSend,
  sendCampaignTest,
  updateCampaign,
} from '@/services/crm/email/campaigns.service'
import { contentHash, enviarPrueba } from '@/services/crm/email/templates.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { campanasPausadasPorCupo } from '@/services/email/resendQuota'

jest.mock('@/services/crm/email/templates.service', () => ({
  ...jest.requireActual('@/services/crm/email/templates.service'),
  enviarPrueba: jest.fn(),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/services/email/resendQuota', () => ({ campanasPausadasPorCupo: jest.fn(() => false) }))
// A quién le llega es SQL del servicio de públicos: aquí basta el conteo.
jest.mock('@/services/crm/email/audience.service', () => ({
  ...jest.requireActual('@/services/crm/email/audience.service'),
  contarAudiencia: jest.fn(),
  recorrerAudiencia: jest.fn(),
  personasNoElegibles: jest.fn(),
}))
jest.mock('@/services/crm/access.service', () => ({
  ...jest.requireActual('@/services/crm/access.service'),
  getCrmAccess: jest.fn(),
}))

const STAFF = 'cstaffsup0000000000000001'
const CAMP_A = 'ccampaign000000000000001'
const CAMP_B = 'ccampaign000000000000002'
const TEMPLATE = 'ctemplate0000000000000001'

/** Los 7 estados que una delivery puede tener (campaignSender.service.ts y campaignWebhook.service.ts). */
const ESTADOS = ['PENDIENTE', 'ENVIANDO', 'ENVIADO', 'REINTENTO', 'FALLIDO', 'OMITIDO', 'DESCONOCIDO'] as const

/** La campaña A tiene deliveries en los 7 estados: 5 + 2 + 20 + 3 + 4 + 1 + 5 = 40. */
const CUENTA_A: Record<(typeof ESTADOS)[number], number> = {
  PENDIENTE: 5,
  ENVIANDO: 2,
  ENVIADO: 20,
  REINTENTO: 3,
  FALLIDO: 4,
  OMITIDO: 1,
  DESCONOCIDO: 5,
}
const TOTAL_A = 40

const fila = (id: string, total: number) => ({
  id,
  name: `Campaña ${id.slice(-1)}`,
  templateId: TEMPLATE,
  subject: 'Lo nuevo de Avoqado',
  blocks: [{ type: 'paragraph', text: 'Hola {{nombre}}' }],
  audience: { segmentos: [{ tipo: 'PROSPECTOS' }] },
  status: 'ENVIANDO',
  testSentHash: null,
  total,
  createdById: STAFF,
  enqueuedAt: new Date('2026-11-03T16:00:00.000Z'),
  finishedAt: null,
  cancelledAt: null,
  createdAt: new Date('2026-11-03T15:00:00.000Z'),
  updatedAt: new Date('2026-11-03T16:00:00.000Z'),
})

/** Lo que devuelve el `groupBy` de Prisma: una fila por campaña y estado. B sólo tiene 3 deliveries, todas enviadas. */
const GRUPOS = [
  ...ESTADOS.map(status => ({ campaignId: CAMP_A, status, _count: { _all: CUENTA_A[status] } })),
  { campaignId: CAMP_B, status: 'ENVIADO', _count: { _all: 3 } },
]

const suma = (cuentas: Record<string, number>) => Object.values(cuentas).reduce((a, b) => a + b, 0)

describe('contadores de las campañas', () => {
  beforeEach(() => {
    prismaMock.crmCampaign.findMany.mockResolvedValue([fila(CAMP_A, TOTAL_A), fila(CAMP_B, 3)] as never)
    prismaMock.crmCampaign.count.mockResolvedValue(2)
    prismaMock.crmCampaignDelivery.groupBy.mockResolvedValue(GRUPOS as never)
  })

  it('listCampaigns: con los 7 estados presentes, la suma de los contadores es el total encolado', async () => {
    const { rows, total } = await listCampaigns({ limit: 10 })
    expect(total).toBe(2)
    const [a, b] = rows
    expect(Object.keys(a.contadores).sort()).toEqual([...ESTADOS].sort())
    expect(a.contadores).toEqual(CUENTA_A)
    expect(suma(a.contadores)).toBe(a.total)
    expect(a.total).toBe(TOTAL_A)
    expect(b.contadores).toEqual({ ENVIADO: 3 })
    expect(suma(b.contadores)).toBe(b.total)
  })

  it('listCampaigns: los contadores de TODA la página salen de UNA consulta agrupada (sin N+1)', async () => {
    await listCampaigns({})
    expect(prismaMock.crmCampaignDelivery.groupBy).toHaveBeenCalledTimes(1)
    expect(prismaMock.crmCampaignDelivery.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ by: ['campaignId', 'status'], where: { campaignId: { in: [CAMP_A, CAMP_B] } } }),
    )
  })

  it('getCampaign: los mismos contadores para una sola campaña', async () => {
    prismaMock.crmCampaign.findUnique.mockResolvedValue(fila(CAMP_A, TOTAL_A) as never)
    const campana = await getCampaign(CAMP_A)
    expect(campana.contadores).toEqual(CUENTA_A)
    expect(suma(campana.contadores)).toBe(campana.total)
  })

  it('la herramienta crm_campaign_status cuenta lo mismo: 7 contadores que suman el total, y ENVIANDO sale como enCurso', async () => {
    ;(getCrmAccess as jest.Mock).mockResolvedValue({
      staffId: STAFF,
      isSuperadmin: true,
      ver: 'todos',
      editar: 'todos',
      contactar: true,
      campanas: true,
      exportar: true,
      ventas: true,
      admin: true,
      cerrar: true,
      bajas: true,
      plantillas: true,
      preparar: true,
      mandar: true,
      verCampanas: true,
      equipo: true,
      configurar: true,
    })
    const handlers: Record<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>> = {}
    const server = { tool: (name: string, _d: string, _s: unknown, handler: (typeof handlers)[string]) => void (handlers[name] = handler) }
    registerCrmTools(server as unknown as McpServer, { staffId: STAFF, isSuperAdmin: true, scopes: ['mcp:read'] } as McpScope)

    const answer = JSON.parse((await handlers.crm_campaign_status({})).content[0].text)
    const [a, b] = answer.campanas
    expect(Object.keys(a.contadores).sort()).toEqual([
      'desconocidos',
      'enCurso',
      'enviados',
      'fallidos',
      'omitidos',
      'pendientes',
      'reintentos',
    ])
    expect(a.contadores).toEqual({ pendientes: 5, enCurso: 2, enviados: 20, reintentos: 3, fallidos: 4, omitidos: 1, desconocidos: 5 })
    expect(suma(a.contadores)).toBe(a.total)
    expect(suma(b.contadores)).toBe(b.total)
  })
})

// El cupo de Resend (3-nov): con 80 de 100 en el día, las campañas ENVIANDO esperan a la medianoche de CDMX. La pantalla y el MCP
// lo dicen con un campo NUEVO y opcional (`pausadaPorCupo`): ningún campo existente cambia.
describe('pausadaPorCupo — la campaña espera al cupo de Resend', () => {
  const pausa = campanasPausadasPorCupo as jest.Mock
  beforeEach(() => {
    pausa.mockReset().mockReturnValue(false)
    prismaMock.crmCampaignDelivery.groupBy.mockResolvedValue(GRUPOS as never)
  })

  it('una campaña ENVIANDO con el cupo en pausa dice pausadaPorCupo: true; sin pausa, false', async () => {
    prismaMock.crmCampaign.findUnique.mockResolvedValue(fila(CAMP_A, TOTAL_A) as never)
    expect((await getCampaign(CAMP_A)).pausadaPorCupo).toBe(false)
    pausa.mockReturnValue(true)
    const campana = await getCampaign(CAMP_A)
    expect(campana.pausadaPorCupo).toBe(true)
    expect(campana.contadores).toEqual(CUENTA_A)
  })

  it('una campaña que ya no envía (ENVIADA, CANCELADA) nunca está «en pausa»', async () => {
    pausa.mockReturnValue(true)
    prismaMock.crmCampaign.findUnique.mockResolvedValue({ ...fila(CAMP_B, 3), status: 'ENVIADA' } as never)
    expect((await getCampaign(CAMP_B)).pausadaPorCupo).toBe(false)
  })

  it('crm_campaign_status lo trae en el detalle y en la lista', async () => {
    pausa.mockReturnValue(true)
    ;(getCrmAccess as jest.Mock).mockResolvedValue({
      staffId: STAFF,
      isSuperadmin: true,
      ver: 'todos',
      editar: 'todos',
      contactar: true,
      campanas: true,
      exportar: true,
      ventas: true,
      admin: true,
      cerrar: true,
      bajas: true,
      plantillas: true,
      preparar: true,
      mandar: true,
      verCampanas: true,
      equipo: true,
      configurar: true,
    })
    prismaMock.crmCampaign.findUnique.mockResolvedValue(fila(CAMP_A, TOTAL_A) as never)
    prismaMock.crmCampaign.findMany.mockResolvedValue([fila(CAMP_A, TOTAL_A)] as never)
    prismaMock.crmCampaign.count.mockResolvedValue(1)
    const handlers: Record<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>> = {}
    const server = { tool: (name: string, _d: string, _s: unknown, handler: (typeof handlers)[string]) => void (handlers[name] = handler) }
    registerCrmTools(server as unknown as McpServer, { staffId: STAFF, isSuperAdmin: true, scopes: ['mcp:read'] } as McpScope)

    const detalle = JSON.parse((await handlers.crm_campaign_status({ campaignId: CAMP_A })).content[0].text)
    const lista = JSON.parse((await handlers.crm_campaign_status({})).content[0].text)
    expect(detalle.campana.pausadaPorCupo).toBe(true)
    expect(lista.campanas[0].pausadaPorCupo).toBe(true)
  })
})

// Familia C (pasada r2): cancelar no puede decir «omitida» de lo que pudo haber salido. Una REINTENTO ya llamó (o pudo llamar) a
// Resend: su respuesta pudo perderse. PENDIENTE nunca se reclamó: ésa sí es OMITIDO seguro.
describe('cancelCampaign — lo que esperaba otro intento queda DESCONOCIDO, no OMITIDO', () => {
  it('PENDIENTE → OMITIDO «campaña cancelada»; REINTENTO → DESCONOCIDO con el mismo motivo', async () => {
    prismaMock.crmCampaign.updateMany.mockResolvedValue({ count: 1 } as never)
    prismaMock.crmCampaignDelivery.updateMany.mockResolvedValue({ count: 2 } as never)
    prismaMock.crmCampaign.findUnique.mockResolvedValue(fila(CAMP_A, TOTAL_A) as never)
    prismaMock.crmCampaignDelivery.groupBy.mockResolvedValue(GRUPOS as never)

    await cancelCampaign({ staffId: STAFF } as never, CAMP_A)

    const escrituras = prismaMock.crmCampaignDelivery.updateMany.mock.calls.map(([arg]: any[]) => arg)
    expect(escrituras).toContainEqual({
      where: { campaignId: CAMP_A, status: 'PENDIENTE' },
      data: { status: 'OMITIDO', skipReason: 'campaña cancelada', nextAttemptAt: null },
    })
    expect(escrituras).toContainEqual({
      where: { campaignId: CAMP_A, status: 'REINTENTO' },
      data: {
        status: 'DESCONOCIDO',
        skipReason: 'campaña cancelada',
        lastError: 'No sabemos si salió: un intento anterior pudo llegar a Resend',
        nextAttemptAt: null,
      },
    })
    expect(escrituras.some((e: any) => e.data.status === 'OMITIDO' && JSON.stringify(e.where).includes('REINTENTO'))).toBe(false)
  })
})

// H3 (Codex código r2, misma familia que H1): con sólo «Mandar», Yonatan ve el público de Guadalajara; Rafa lo cambia a Monterrey
// mientras tanto. La vista previa ya no firma la versión NUEVA: la pantalla manda la huella de lo que pinta y, si no coincide con
// lo que hay ahora, 409 sin token. Sin huella (la pantalla vieja), igual que antes.
describe('previewSend — la confirmación se ata a la versión que se ve (huella)', () => {
  const guadalajara = { segmentos: [{ tipo: 'CLIENTES', ciudades: ['Guadalajara'] }] }
  const monterrey = { segmentos: [{ tipo: 'CLIENTES', ciudades: ['Monterrey'] }] }
  const borrador = (over: Record<string, unknown> = {}) => ({ ...fila(CAMP_A, 0), status: 'BORRADOR', enqueuedAt: null, ...over })
  const ACTOR = { staffId: STAFF } as never

  beforeEach(() => {
    prismaMock.crmCampaignDelivery.groupBy.mockResolvedValue([] as never)
    ;(contarAudiencia as jest.Mock).mockReset().mockResolvedValue({ total: 2, porSegmento: { CLIENTES: 2 }, bloqueados: 0 })
  })

  /** La huella que la pantalla recibió al abrir la campaña con ese estado. */
  const huellaVista = async (over: Record<string, unknown>) => {
    prismaMock.crmCampaign.findUnique.mockResolvedValueOnce(borrador(over) as never)
    return (await getCampaign(CAMP_A)).huella
  }

  it('la vista trae la huella: igual para la misma versión, distinta si cambia el público o el contenido', async () => {
    const a = await huellaVista({ audience: guadalajara })
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(await huellaVista({ audience: guadalajara })).toBe(a)
    expect(await huellaVista({ audience: monterrey })).not.toBe(a)
    expect(await huellaVista({ audience: guadalajara, subject: 'Otro asunto' })).not.toBe(a)
    expect(await huellaVista({ audience: guadalajara, blocks: [{ type: 'paragraph', text: 'Otro texto' }] })).not.toBe(a)
    // Un borrador recién creado (sin público) también la trae: la vista nunca truena por eso.
    expect(await huellaVista({ audience: { segmentos: [] } })).toMatch(/^[0-9a-f]{64}$/)
  })

  it('con la huella de la versión que hay ahora: conteo y token, como siempre', async () => {
    const huella = await huellaVista({ audience: guadalajara })
    prismaMock.crmCampaign.findUnique.mockResolvedValueOnce(borrador({ audience: guadalajara }) as never)
    const vista = await previewSend(ACTOR, CAMP_A, huella)
    expect(vista).toMatchObject({ total: 2, bloqueados: 0 })
    expect(vista.token).toEqual(expect.any(String))
    // H3 (Codex r4): la respuesta dice QUÉ versión comprobó; la pantalla no deja mandar si no es la que enseña.
    expect(vista.huella).toBe(huella)
  })

  it('🔴 con la huella de Guadalajara y el servidor ya en Monterrey: 409 CRM_CAMPANA_CAMBIO y no se firma nada', async () => {
    const huella = await huellaVista({ audience: guadalajara })
    prismaMock.crmCampaign.findUnique.mockResolvedValueOnce(borrador({ audience: monterrey }) as never)
    await expect(previewSend(ACTOR, CAMP_A, huella)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CRM_CAMPANA_CAMBIO',
      message: 'Alguien cambió esta campaña mientras la veías. Ya te enseñamos la versión nueva: revísala y vuelve a confirmar.',
    })
    // Ni siquiera se contó: el token sale después del conteo, así que no hubo token.
    expect(contarAudiencia).not.toHaveBeenCalled()
  })

  it('🔴 lo mismo si cambió el contenido (mismo público)', async () => {
    const huella = await huellaVista({ audience: guadalajara })
    prismaMock.crmCampaign.findUnique.mockResolvedValueOnce(borrador({ audience: guadalajara, subject: 'Otro asunto' }) as never)
    await expect(previewSend(ACTOR, CAMP_A, huella)).rejects.toMatchObject({ statusCode: 409, code: 'CRM_CAMPANA_CAMBIO' })
    expect(contarAudiencia).not.toHaveBeenCalled()
  })

  it('sin huella (la pantalla vieja): conteo y token de lo que haya, igual que antes', async () => {
    prismaMock.crmCampaign.findUnique.mockResolvedValueOnce(borrador({ audience: monterrey }) as never)
    const vista = await previewSend(ACTOR, CAMP_A)
    expect(vista).toMatchObject({ total: 2, bloqueados: 0 })
    expect(vista.token).toEqual(expect.any(String))
    // También dice qué versión firmó (la de Monterrey), aunque nadie la pidió.
    expect(vista.huella).toBe(await huellaVista({ audience: monterrey }))
  })

  it('una campaña que ya no está en BORRADOR sigue diciendo por qué, aunque traiga huella', async () => {
    const huella = await huellaVista({ audience: guadalajara })
    prismaMock.crmCampaign.findUnique.mockResolvedValueOnce(borrador({ audience: guadalajara, status: 'ENVIADA' }) as never)
    await expect(previewSend(ACTOR, CAMP_A, huella)).rejects.toMatchObject({ code: 'CRM_CAMPANA_NO_EDITABLE' })
  })
})

describe('sendCampaignTest', () => {
  const OTRA = 'cstaffotra00000000000001'
  const actor = { staffId: STAFF } as never
  const campana = { subject: 'Lo nuevo', blocks: [{ type: 'paragraph', text: 'Hola' }] }
  beforeEach(() => {
    ;(enviarPrueba as jest.Mock).mockReset()
    prismaMock.crmCampaign.findUnique.mockResolvedValue(campana as never)
    prismaMock.crmCampaign.updateMany.mockResolvedValue({ count: 1 } as never)
  })

  it('pasa el destino, escribe testSentHash sólo si salió y su bitácora dice { para, llave } sin correo', async () => {
    ;(enviarPrueba as jest.Mock).mockResolvedValue({ resultado: { ok: true, destino: { nombre: 'Ana' } }, llave: 'crm-prueba:a:b:h' })
    await expect(sendCampaignTest(actor, CAMP_A, { destinoStaffId: OTRA })).resolves.toEqual({ ok: true, destino: { nombre: 'Ana' } })
    expect(enviarPrueba).toHaveBeenCalledWith(actor, expect.objectContaining({ destinoStaffId: OTRA }))
    expect(prismaMock.crmCampaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { testSentHash: contentHash(campana.subject, campana.blocks as never) } }),
    )
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CRM_CAMPAIGN_TEST_SENT', entityId: CAMP_A, data: { para: OTRA, llave: 'crm-prueba:a:b:h' } }),
    )
  })

  it('no salió: ni testSentHash ni bitácora; repetida: testSentHash sí, bitácora no', async () => {
    ;(enviarPrueba as jest.Mock).mockResolvedValueOnce({ resultado: { ok: false, motivo: 'x' } })
    await sendCampaignTest(actor, CAMP_A)
    expect(prismaMock.crmCampaign.updateMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
    ;(enviarPrueba as jest.Mock).mockResolvedValueOnce({ resultado: { ok: true, repetida: true }, llave: 'k' })
    await sendCampaignTest(actor, CAMP_A)
    expect(prismaMock.crmCampaign.updateMany).toHaveBeenCalledTimes(1)
    expect(logAction).not.toHaveBeenCalled()
  })
})

// ── Plan B, tarea 4 (rediseño tras Codex r2 y r3): el público gana `excluir` e `incluir` y se guarda bajo el candado ──────

// El `audienciaSchema` de ANTES de la tarea 4, copiado tal cual: es como lee el público un SERVIDOR viejo después de una reversa.
const MAX_FILTER_VALUES_VIEJO = 50
const textFilterViejo = (singular: string, plural: string) =>
  z
    .array(
      z
        .string({ invalid_type_error: `Cada ${singular} es un texto con letras` })
        .trim()
        .min(1, `Cada ${singular} es un texto con letras`)
        .max(100, 'Máximo 100 caracteres'),
      { invalid_type_error: `Los ${plural} van en una lista` },
    )
    .max(MAX_FILTER_VALUES_VIEJO, `Máximo ${MAX_FILTER_VALUES_VIEJO} ${plural}`)
    .optional()
const audienceRolesViejo = z
  .array(z.nativeEnum(StaffRole, { errorMap: () => ({ message: 'Ese rol no existe' }) }), {
    required_error: 'Elige al menos un rol',
    invalid_type_error: 'Elige al menos un rol',
  })
  .min(1, 'Elige al menos un rol')
  .max(Object.keys(StaffRole).length, 'Hay roles repetidos')
const audienceSegmentSchemaViejo = z.discriminatedUnion(
  'tipo',
  [
    z.object({
      tipo: z.literal('PROSPECTOS'),
      etapas: z
        .array(z.string({ invalid_type_error: 'El id de la etapa no es válido' }).cuid('El id de la etapa no es válido'))
        .max(MAX_FILTER_VALUES_VIEJO, `Máximo ${MAX_FILTER_VALUES_VIEJO} etapas`)
        .optional(),
    }),
    z.object({
      tipo: z.literal('CLIENTES'),
      giros: textFilterViejo('giro', 'giros'),
      ciudades: textFilterViejo('ciudad', 'ciudades'),
      planes: z
        .array(z.enum(['GRATIS', 'PRO', 'PREMIUM'], { errorMap: () => ({ message: 'Ese plan no existe' }) }))
        .max(3, 'Hay planes repetidos')
        .optional(),
    }),
    z.object({
      tipo: z.literal('USUARIOS'),
      roles: audienceRolesViejo,
      giros: textFilterViejo('giro', 'giros'),
      ciudades: textFilterViejo('ciudad', 'ciudades'),
      soloClientes: z.boolean({ invalid_type_error: 'Solo clientes es sí o no' }).optional(),
    }),
  ],
  { errorMap: () => ({ message: 'Ese público no existe' }) },
)
const audienciaSchemaViejo = z
  .object({
    segmentos: z
      .array(audienceSegmentSchemaViejo, { required_error: 'Elige a quién le mandas', invalid_type_error: 'Elige a quién le mandas' })
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

const sha256 = (texto: string) => createHash('sha256').update(texto).digest('hex')
/** Lo que trae el token por dentro (cuerpo base64url antes del punto). */
const cuerpoDelToken = (token: string) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf-8'))

describe('el público con excluir e incluir: guardar bajo el candado, forma v2 y huellas', () => {
  const ACTOR = { staffId: STAFF } as never
  const P = { tipo: 'PROSPECTOS' as const }
  const C = { tipo: 'CLIENTES' as const }
  const SUBJECT = 'Lo nuevo de Avoqado'
  const BLOCKS = [{ type: 'paragraph', text: 'Hola {{nombre}}' }]
  /** La fila guardada: `updateMany` la cambia, y las lecturas siguientes (la del candado y `getCampaign`) la ven. */
  let guardado: unknown
  const borrador = () => ({ ...fila(CAMP_A, 0), status: 'BORRADOR', enqueuedAt: null, audience: guardado })
  const huellaPublicoDe = async () => (await getCampaign(CAMP_A)).huellaPublico

  beforeEach(() => {
    guardado = { segmentos: [P] }
    prismaMock.crmCampaign.findUnique.mockReset().mockImplementation((() => Promise.resolve(borrador())) as never)
    prismaMock.crmCampaign.updateMany.mockReset().mockImplementation(((args: { data: { audience?: unknown } }) => {
      if (args.data.audience !== undefined) guardado = args.data.audience
      return Promise.resolve({ count: 1 })
    }) as never)
    prismaMock.$queryRaw.mockReset().mockResolvedValue([{ id: CAMP_A }] as never)
    prismaMock.crmCampaignDelivery.groupBy.mockResolvedValue([] as never)
    ;(personasNoElegibles as jest.Mock).mockReset().mockResolvedValue([])
    ;(contarAudiencia as jest.Mock).mockReset().mockResolvedValue({ total: 3, porSegmento: { PROSPECTOS: 3 }, bloqueados: 0 })
  })

  const escrito = () => prismaMock.crmCampaign.updateMany.mock.calls.at(-1)?.[0] as { data: { audience?: unknown } } | undefined

  // ── Compatibilidad: un público sin listas es el de hoy ────────────────────────────────────────────────────────────

  it('🔴 la huella de un público sin excluir/incluir no cambió: sha256(contentHash + ":" + sha256(JSON del público de hoy))', async () => {
    const vista = await getCampaign(CAMP_A)
    const delPublico = sha256(JSON.stringify({ segmentos: [P] }))
    expect(vista.huella).toBe(sha256(`${contentHash(SUBJECT, BLOCKS as never)}:${delPublico}`))
    expect(vista.huellaPublico).toBe(delPublico)
    // El token de la vista previa firma el MISMO audienceHash de hoy: un token firmado antes del despliegue sigue valiendo.
    const { token } = await previewSend(ACTOR, CAMP_A)
    expect(cuerpoDelToken(token!).audienceHash).toBe(delPublico)
    // La pantalla vieja sigue leyendo `audience` como hoy, y la nueva lee `publico` con las tres llaves.
    expect(vista.audience).toEqual({ segmentos: [P] })
    expect(vista.publico).toEqual({ segmentos: [P], excluir: [], incluir: [] })
  })

  it('excluir o incluir cambian la huella, la huellaPublico y el audienceHash del token', async () => {
    const antes = await getCampaign(CAMP_A)
    const tokenAntes = cuerpoDelToken((await previewSend(ACTOR, CAMP_A)).token!)
    await updateCampaign(ACTOR, CAMP_A, { audience: { segmentos: [P], excluir: ['ana@x.mx'] }, basePublico: antes.huellaPublico })
    const conExcluir = await getCampaign(CAMP_A)
    expect(conExcluir.huella).not.toBe(antes.huella)
    expect(conExcluir.huellaPublico).not.toBe(antes.huellaPublico)
    expect(cuerpoDelToken((await previewSend(ACTOR, CAMP_A)).token!).audienceHash).not.toBe(tokenAntes.audienceHash)

    await updateCampaign(ACTOR, CAMP_A, {
      audience: { segmentos: [P], excluir: ['ana@x.mx'], incluir: ['beto@x.mx'] },
      basePublico: conExcluir.huellaPublico,
    })
    expect((await getCampaign(CAMP_A)).huellaPublico).not.toBe(conExcluir.huellaPublico)
  })

  // ── La forma guardada que falla cerrado ante una reversa ─────────────────────────────────────────────────────────

  it('con listas, guarda la forma v2 { v: 2, publicos, excluir, incluir } y la vista trae publico completo y audience { segmentos: [] }', async () => {
    const base = await huellaPublicoDe()
    const vista = await updateCampaign(ACTOR, CAMP_A, {
      audience: { segmentos: [P, C], excluir: ['b@x.mx', 'a@x.mx'], incluir: ['z@x.mx'] },
      basePublico: base,
    })
    expect(escrito()!.data.audience).toEqual({ v: 2, publicos: [P, C], excluir: ['b@x.mx', 'a@x.mx'], incluir: ['z@x.mx'] })
    expect(Object.keys(escrito()!.data.audience as object)).not.toContain('segmentos')
    // La pantalla nueva lee `publico`, en el MISMO orden que mandó; la vieja ve «sin público» y no puede mandar.
    expect(vista.publico).toEqual({ segmentos: [P, C], excluir: ['b@x.mx', 'a@x.mx'], incluir: ['z@x.mx'] })
    expect(vista.audience).toEqual({ segmentos: [] })
  })

  it('🔴 una fila v2 parseada con el audienciaSchema VIEJO (copiado tal cual) falla con «Elige a quién le mandas»: un SERVIDOR viejo no cuenta ni manda', async () => {
    await updateCampaign(ACTOR, CAMP_A, { audience: { segmentos: [P], excluir: ['ana@x.mx'] }, basePublico: await huellaPublicoDe() })
    const viejo = audienciaSchemaViejo.safeParse(escrito()!.data.audience)
    expect(viejo.success).toBe(false)
    expect(viejo.success ? [] : viejo.error.issues.map(i => i.message)).toEqual(['Elige a quién le mandas'])
    // Control: una fila SIN listas el SERVIDOR viejo la sigue leyendo igual.
    await updateCampaign(ACTOR, CAMP_A, { audience: { segmentos: [P], excluir: [] }, basePublico: await huellaPublicoDe() })
    expect(audienciaSchemaViejo.safeParse(escrito()!.data.audience).success).toBe(true)
  })

  it('pantalla nueva: excluir: [] limpia lo guardado y la fila vuelve a la forma de hoy, con la huella de hoy', async () => {
    const deHoy = await huellaPublicoDe()
    await updateCampaign(ACTOR, CAMP_A, { audience: { segmentos: [P], excluir: ['ana@x.mx'] }, basePublico: deHoy })
    await updateCampaign(ACTOR, CAMP_A, { audience: { segmentos: [P], excluir: [], incluir: [] }, basePublico: await huellaPublicoDe() })
    expect(escrito()!.data.audience).toEqual({ segmentos: [P] })
    expect(await huellaPublicoDe()).toBe(deHoy)
  })

  // ── basePublico y la pantalla vieja ──────────────────────────────────────────────────────────────────────────────

  it('🔴 dos PATCH nuevos con el mismo basePublico: el segundo es 409 CRM_CAMPANA_CAMBIO y la exclusión del primero sigue', async () => {
    const base = await huellaPublicoDe()
    await updateCampaign(ACTOR, CAMP_A, { audience: { segmentos: [P], excluir: ['ana@x.mx'] }, basePublico: base })
    prismaMock.crmCampaign.updateMany.mockClear()
    await expect(
      updateCampaign(ACTOR, CAMP_A, { audience: { segmentos: [P], excluir: ['beto@x.mx'] }, basePublico: base }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CRM_CAMPANA_CAMBIO' })
    expect(prismaMock.crmCampaign.updateMany).not.toHaveBeenCalled()
    expect(guardado).toEqual({ v: 2, publicos: [P], excluir: ['ana@x.mx'], incluir: [] })
  })

  it('🔴 pantalla vieja (sin basePublico) sobre una campaña con listas: 409 CRM_CAMPANA_PANTALLA_VIEJA y no escribe nada', async () => {
    guardado = { v: 2, publicos: [P], excluir: ['ana@x.mx'], incluir: [] }
    await expect(updateCampaign(ACTOR, CAMP_A, { audience: { segmentos: [P, C] } })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CRM_CAMPANA_PANTALLA_VIEJA',
      message: 'Recarga la página: esta campaña tiene personas quitadas o agregadas que esta pantalla no conoce',
    })
    expect(prismaMock.crmCampaign.updateMany).not.toHaveBeenCalled()
    expect(guardado).toEqual({ v: 2, publicos: [P], excluir: ['ana@x.mx'], incluir: [] })
  })

  it('pantalla vieja sin listas guardadas: reemplaza como hoy, con la forma de hoy', async () => {
    const vista = await updateCampaign(ACTOR, CAMP_A, { audience: { segmentos: [P, C] } })
    expect(escrito()!.data.audience).toEqual({ segmentos: [P, C] })
    expect(vista.audience).toEqual({ segmentos: [P, C] })
  })

  it('un PATCH viejo sólo de contenido no toma el candado ni toca el público (como hoy), aunque haya listas', async () => {
    guardado = { v: 2, publicos: [P], excluir: ['ana@x.mx'], incluir: [] }
    await updateCampaign(ACTOR, CAMP_A, { subject: 'Otro asunto' })
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expect(escrito()!.data).toEqual({ subject: 'Otro asunto' })
    expect(guardado).toEqual({ v: 2, publicos: [P], excluir: ['ana@x.mx'], incluir: [] })
  })

  it('el candado se toma ANTES de leer, en una transacción, y una campaña que ya no es BORRADOR da 409 NO_EDITABLE sin escribir', async () => {
    const base = await huellaPublicoDe()
    prismaMock.crmCampaign.findUnique.mockClear()
    await updateCampaign(ACTOR, CAMP_A, { audience: { segmentos: [C] }, basePublico: base })
    expect(prismaMock.$transaction).toHaveBeenCalled()
    const sql = (prismaMock.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?')
    expect(sql).toMatch(/SELECT "id" FROM "CrmCampaign" WHERE "id" = \? FOR UPDATE/)
    const candado = prismaMock.$queryRaw.mock.invocationCallOrder[0]
    const lectura = prismaMock.crmCampaign.findUnique.mock.invocationCallOrder[0]
    expect(candado).toBeLessThan(lectura)

    prismaMock.crmCampaign.updateMany.mockClear()
    prismaMock.crmCampaign.findUnique.mockImplementation((() => Promise.resolve({ ...borrador(), status: 'ENVIANDO' })) as never)
    await expect(updateCampaign(ACTOR, CAMP_A, { audience: { segmentos: [P] } })).rejects.toMatchObject({ code: 'CRM_CAMPANA_NO_EDITABLE' })
    expect(prismaMock.crmCampaign.updateMany).not.toHaveBeenCalled()
  })

  // ── incluir: sólo se revisan los correos NUEVOS ──────────────────────────────────────────────────────────────────

  it('PATCH con incluir: un correo nuevo no elegible es 400 CRM_CAMPANA_PERSONA_SIN_PERMISO con sus correos; uno ya guardado no se vuelve a revisar', async () => {
    guardado = { v: 2, publicos: [P], excluir: [], incluir: ['ya@x.mx'] }
    ;(personasNoElegibles as jest.Mock).mockResolvedValue(['nuevo@x.mx'])
    await expect(
      updateCampaign(ACTOR, CAMP_A, {
        audience: { segmentos: [P], incluir: ['ya@x.mx', 'nuevo@x.mx', 'otro@x.mx'] },
        basePublico: await huellaPublicoDe(),
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'CRM_CAMPANA_PERSONA_SIN_PERMISO',
      message: 'Estas personas no se pueden agregar: no aceptaron recibir correos, se dieron de baja o ya no están en el CRM',
      details: { correos: ['nuevo@x.mx'] },
    })
    // Sólo los nuevos, y dentro de la transacción (con su `tx`).
    expect(personasNoElegibles).toHaveBeenCalledWith(['nuevo@x.mx', 'otro@x.mx'], prismaMock)
    expect(prismaMock.crmCampaign.updateMany).not.toHaveBeenCalled()

    // Todos elegibles: se guarda.
    ;(personasNoElegibles as jest.Mock).mockResolvedValue([])
    await updateCampaign(ACTOR, CAMP_A, {
      audience: { segmentos: [P], incluir: ['ya@x.mx', 'nuevo@x.mx'] },
      basePublico: await huellaPublicoDe(),
    })
    expect(guardado).toEqual({ v: 2, publicos: [P], excluir: [], incluir: ['ya@x.mx', 'nuevo@x.mx'] })
  })

  it('🔴 un CLIENTE sin consentimiento: quitar → guardar → regresar → guardar, sin 400 (excluir nunca pasa por la revisión)', async () => {
    // Nadie sería elegible: si «quitar» o «regresar» pasaran por la revisión, truenan.
    ;(personasNoElegibles as jest.Mock).mockImplementation(async (correos: string[]) => correos)
    guardado = { segmentos: [C] }
    await updateCampaign(ACTOR, CAMP_A, {
      audience: { segmentos: [C], excluir: ['dueno@cliente.mx'] },
      basePublico: await huellaPublicoDe(),
    })
    expect(guardado).toEqual({ v: 2, publicos: [C], excluir: ['dueno@cliente.mx'], incluir: [] })
    await updateCampaign(ACTOR, CAMP_A, { audience: { segmentos: [C], excluir: [] }, basePublico: await huellaPublicoDe() })
    expect(guardado).toEqual({ segmentos: [C] })
  })

  it('la bitácora dice qué llaves cambiaron, sin correos ni basePublico', async () => {
    await updateCampaign(ACTOR, CAMP_A, { audience: { segmentos: [P], excluir: ['ana@x.mx'] }, basePublico: await huellaPublicoDe() })
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CRM_CAMPAIGN_UPDATED', data: { cambios: ['audience'] } }))
    expect(JSON.stringify((logAction as jest.Mock).mock.calls)).not.toContain('ana@x.mx')
  })

  // ── La vista previa con 0 personas no firma ──────────────────────────────────────────────────────────────────────

  it('vista previa con 0 personas: total 0 y token null (el campo sigue); con 3, token como hoy', async () => {
    ;(contarAudiencia as jest.Mock).mockResolvedValueOnce({ total: 0, porSegmento: { PROSPECTOS: 0 }, bloqueados: 2 })
    const vacia = await previewSend(ACTOR, CAMP_A)
    expect(vacia).toMatchObject({ total: 0, bloqueados: 2, token: null })
    expect(vacia).toHaveProperty('token', null)
    const llena = await previewSend(ACTOR, CAMP_A)
    expect(llena.token).toEqual(expect.any(String))
    expect(cuerpoDelToken(llena.token!)).toMatchObject({ campaignId: CAMP_A, total: 3 })
  })

  it('vista previa de un borrador sin públicos ni incluir: total 0 sin recorrer la base', async () => {
    guardado = { segmentos: [] }
    const real = jest.requireActual('@/services/crm/email/audience.service') as typeof import('@/services/crm/email/audience.service')
    ;(contarAudiencia as jest.Mock).mockImplementationOnce(real.contarAudiencia)
    const vista = await previewSend(ACTOR, CAMP_A)
    expect(vista).toMatchObject({ total: 0, bloqueados: 0, token: null })
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expect(prismaMock.crmTeam.findUnique).not.toHaveBeenCalled()
  })

  it('encolar con el token de una vista previa vieja después de agregar a alguien: 409 CRM_CAMPANA_CAMBIO', async () => {
    prismaMock.crmCampaign.findUnique.mockImplementation((() =>
      Promise.resolve({ ...borrador(), testSentHash: contentHash(SUBJECT, BLOCKS as never) })) as never)
    const { token } = await previewSend(ACTOR, CAMP_A)
    await updateCampaign(ACTOR, CAMP_A, { audience: { segmentos: [P], incluir: ['nueva@x.mx'] }, basePublico: await huellaPublicoDe() })
    prismaMock.crmCampaign.updateMany.mockClear()
    await expect(enqueueCampaign(ACTOR, CAMP_A, token!)).rejects.toMatchObject({ statusCode: 409, code: 'CRM_CAMPANA_CAMBIO' })
    expect(prismaMock.crmCampaign.updateMany).not.toHaveBeenCalled()
  })
})

// ── Plan B, tarea 5 (Codex r1 #5): lo que se confirma son PERSONAS, no un número ──────────────────────────────────────────
// La vista previa firma `conjuntoHash` (los correos que contó, ya sin bajas) en el TOKEN; el encolado lo recalcula en la misma pasada que
// crea las deliveries. Si salió Ana y entró Brenda (mismo total), 409 PUBLICO_CAMBIO y se deshace todo. La `huella` de versión no cambia.
describe('conjuntoHash: se confirman las mismas personas, no sólo cuántas', () => {
  const ACTOR = { staffId: STAFF } as never
  const SUBJECT = 'Lo nuevo de Avoqado'
  const BLOCKS = [{ type: 'paragraph', text: 'Hola {{nombre}}' }]
  const borrador = () => ({
    ...fila(CAMP_A, 0),
    status: 'BORRADOR',
    enqueuedAt: null,
    testSentHash: contentHash(SUBJECT, BLOCKS as never),
  })
  const DOS = ['ana@x.mx', 'beto@x.mx'].map(email => ({ email, reason: 'PROSPECTO', publico: 'PROSPECTOS', vars: {} }))
  const conteo = (conjuntoHash?: string) => ({
    total: 2,
    porSegmento: { PROSPECTOS: 2, CLIENTES: 0, USUARIOS: 0, AGREGADOS: 0 },
    bloqueados: 0,
    ...(conjuntoHash === undefined ? {} : { conjuntoHash }),
  })
  /** El recorrido del encolado entrega a DOS personas cuyo conjunto da `conjuntoHash`. */
  const recorre = (conjuntoHash: string, personas = DOS) =>
    (recorrerAudiencia as jest.Mock).mockImplementationOnce(async (_a: unknown, alLote: (l: unknown[]) => Promise<void>) => {
      await alLote(personas)
      return { entregados: personas.length, conjuntoHash }
    })

  beforeEach(() => {
    prismaMock.crmCampaign.findUnique.mockReset().mockResolvedValue(borrador() as never)
    prismaMock.crmCampaign.updateMany.mockReset().mockResolvedValue({ count: 1 } as never)
    prismaMock.crmCampaign.update.mockReset().mockResolvedValue({} as never)
    prismaMock.crmCampaignDelivery.createMany
      .mockReset()
      .mockImplementation(((args: { data: unknown[] }) => Promise.resolve({ count: args.data.length })) as never)
    prismaMock.crmCampaignDelivery.groupBy.mockResolvedValue([] as never)
    prismaMock.$queryRaw.mockReset().mockResolvedValue([{ id: CAMP_A }] as never)
    ;(contarAudiencia as jest.Mock).mockReset()
    ;(recorrerAudiencia as jest.Mock).mockReset()
  })

  it('el token firma el conjuntoHash del conteo; la respuesta no lo trae', async () => {
    ;(contarAudiencia as jest.Mock).mockResolvedValueOnce(conteo('h-ana-beto'))
    const vista = await previewSend(ACTOR, CAMP_A)
    expect(cuerpoDelToken(vista.token!)).toMatchObject({ campaignId: CAMP_A, total: 2, conjuntoHash: 'h-ana-beto' })
    expect(vista).not.toHaveProperty('conjuntoHash')
  })

  it('las mismas personas: encola', async () => {
    ;(contarAudiencia as jest.Mock).mockResolvedValueOnce(conteo('h-ana-beto'))
    const { token } = await previewSend(ACTOR, CAMP_A)
    recorre('h-ana-beto')
    await expect(enqueueCampaign(ACTOR, CAMP_A, token!)).resolves.toEqual({ total: 2 })
  })

  it('🔴 mismo total, otras personas: 409 CRM_CAMPANA_PUBLICO_CAMBIO con confirmado y actual, y no se escribe el total', async () => {
    ;(contarAudiencia as jest.Mock).mockResolvedValueOnce(conteo('h-ana-beto'))
    const { token } = await previewSend(ACTOR, CAMP_A)
    recorre('h-brenda-beto')
    await expect(enqueueCampaign(ACTOR, CAMP_A, token!)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CRM_CAMPANA_PUBLICO_CAMBIO',
      message: 'El público cambió: revisa otra vez',
      details: { confirmado: 2, actual: 2 },
    })
    expect(prismaMock.crmCampaign.update).not.toHaveBeenCalled()
  })

  it('si creció sigue siendo PUBLICO_CRECIO (aunque el conjunto también cambió)', async () => {
    ;(contarAudiencia as jest.Mock).mockResolvedValueOnce(conteo('h-ana-beto'))
    const { token } = await previewSend(ACTOR, CAMP_A)
    recorre('h-tres', [...DOS, { email: 'caro@x.mx', reason: 'PROSPECTO', publico: 'PROSPECTOS', vars: {} }])
    await expect(enqueueCampaign(ACTOR, CAMP_A, token!)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CRM_CAMPANA_PUBLICO_CRECIO',
      details: { confirmado: 2, actual: 3 },
    })
  })

  it('un token sin conjuntoHash (firmado antes del despliegue) se acepta como hoy', async () => {
    // Sin conjuntoHash en el conteo, la vista previa firma el cuerpo de antes: { v, campaignId, contentHash, audienceHash, total, exp }.
    ;(contarAudiencia as jest.Mock).mockResolvedValueOnce(conteo())
    const { token } = await previewSend(ACTOR, CAMP_A)
    expect(Object.keys(cuerpoDelToken(token!)).sort()).toEqual(['audienceHash', 'campaignId', 'contentHash', 'exp', 'total', 'v'])
    recorre('cualquier-conjunto')
    await expect(enqueueCampaign(ACTOR, CAMP_A, token!)).resolves.toEqual({ total: 2 })
  })

  it('un conjuntoHash que no es texto vuelve inválido al token', async () => {
    ;(contarAudiencia as jest.Mock).mockResolvedValueOnce(conteo(123 as never))
    const { token } = await previewSend(ACTOR, CAMP_A)
    await expect(enqueueCampaign(ACTOR, CAMP_A, token!)).rejects.toMatchObject({ code: 'CRM_CAMPANA_CONFIRMACION_INVALIDA' })
    expect(recorrerAudiencia).not.toHaveBeenCalled()
  })

  it('la huella de versión que devuelve la vista previa no cambia con conjuntoHash', async () => {
    ;(contarAudiencia as jest.Mock).mockResolvedValueOnce(conteo('h-ana-beto')).mockResolvedValueOnce(conteo('h-brenda-beto'))
    const a = await previewSend(ACTOR, CAMP_A)
    const b = await previewSend(ACTOR, CAMP_A)
    expect(a.huella).toBe(b.huella)
    expect(a.huella).toBe((await getCampaign(CAMP_A)).huella)
    expect(cuerpoDelToken(a.token!).conjuntoHash).not.toBe(cuerpoDelToken(b.token!).conjuntoHash)
  })
})
