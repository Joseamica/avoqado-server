/**
 * Lo que la lista de campañas (y la herramienta de MCP que la expone) promete: los contadores por estado de cada campaña
 * salen de UNA consulta agrupada para toda la página y, con los 7 estados de una delivery presentes, su suma es el `total`
 * que se encoló. El `total` y los contadores no pueden contar historias distintas.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prismaMock } from '@tests/__helpers__/setup'
import type { McpScope } from '@/mcp/scope'
import { registerCrmTools } from '@/mcp/tools/crm'
import { getCrmAccess } from '@/services/crm/access.service'
import { contarAudiencia } from '@/services/crm/email/audience.service'
import { cancelCampaign, getCampaign, listCampaigns, previewSend, sendCampaignTest } from '@/services/crm/email/campaigns.service'
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
