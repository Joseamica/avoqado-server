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
import { cancelCampaign, getCampaign, listCampaigns } from '@/services/crm/email/campaigns.service'
import { campanasPausadasPorCupo } from '@/services/email/resendQuota'

jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/services/email/resendQuota', () => ({ campanasPausadasPorCupo: jest.fn(() => false) }))
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
