/**
 * Las llaves finas del CRM (plan 2026-11-04, L4–L9) con la guardia REAL: `requireCrm` relee las llaves de la base
 * —simulada— en cada petición, y los servicios deciden lo que la ruta no puede (reabrir un negocio cerrado, eliminar).
 *
 * - Quien sólo tiene «Mandar campañas» abre una campaña ya probada, ve el correo, cuenta y la manda; no la edita ni la prueba.
 * - Quien sólo tiene «Ver campañas» usa la vista previa, pero con el contexto de un negocio no lee a nadie.
 * - «Configurar el CRM» abre la puerta de «Eliminar», pero eliminar sigue siendo del superadmin real.
 * - «Bajas de correo» da de baja sola; «Equipo y llaves» no da «Mandar campañas»; «Editar» sin «Cerrar negocios» no reabre.
 */
import 'express-async-errors'
import express from 'express'
import request from 'supertest'
import { prismaMock } from '@tests/__helpers__/setup'
import { contarAudiencia, recorrerAudiencia } from '@/services/crm/email/audience.service'
import { contentHash } from '@/services/crm/email/templates.service'

const STAFF = 'cstafffina00000000000001'
const EMAIL = 'yonatan@avoqado.io'
const CAMPAIGN = 'ccampaignf000000000000001'
const ACCOUNT = 'caccountfi000000000000001'
const DEMO = 'cstagedem0000000000000001'
const PERDIDO = 'cstageper0000000000000001'

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: unknown, next: () => void) => {
    req.authContext = {
      userId: 'cstafffina00000000000001',
      orgId: 'corgteam00000000000000001',
      venueId: 'cvenuecrm0000000000000001',
      role: 'VIEWER',
    }
    next()
  },
}))
// A quién le llega la campaña es SQL del servicio de públicos; aquí basta con dos destinatarios.
jest.mock('@/services/crm/email/audience.service', () => ({ contarAudiencia: jest.fn(), recorrerAudiencia: jest.fn() }))

import router from '@/routes/crm.routes'

const app = express()
  .use(express.json())
  .use('/crm', router)
  .use(
    (
      error: { statusCode?: number; code?: string; message: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(error.statusCode ?? 500).json({ code: error.code, message: error.message })
    },
  )

/** La fila de `PlatformAccess` de quien pide: las 15 columnas, todas apagadas salvo lo que se pase. */
const fila = (over: Record<string, unknown> = {}) => ({
  id: 'caccessfi0000000000000001',
  staffId: STAFF,
  verScope: null,
  editarScope: null,
  contactar: false,
  campanas: false,
  exportar: false,
  ventas: false,
  admin: false,
  cerrar: false,
  bajas: false,
  plantillas: false,
  preparar: false,
  mandar: false,
  verCampanas: false,
  equipo: false,
  configurar: false,
  ...over,
})
const llaves = (over: Record<string, unknown>) => prismaMock.platformAccess.findUnique.mockResolvedValue(fila(over))

const SUBJECT = 'Hola {{nombre}}'
const BLOCKS = [{ type: 'paragraph', text: 'Hola {{negocio}}' }]
/** Una campaña lista para mandar: BORRADOR, con público y con la prueba de ESTA versión ya hecha. */
const campana = () => ({
  id: CAMPAIGN,
  name: 'Novedades de noviembre',
  templateId: null,
  subject: SUBJECT,
  blocks: BLOCKS,
  audience: { segmentos: [{ tipo: 'PROSPECTOS' }] },
  status: 'BORRADOR',
  testSentHash: contentHash(SUBJECT, BLOCKS as never),
  total: 0,
  createdById: 'cstaffrafa0000000000000001',
  enqueuedAt: null,
  finishedAt: null,
  cancelledAt: null,
  createdAt: new Date('2026-11-04T10:00:00Z'),
  updatedAt: new Date('2026-11-04T10:00:00Z'),
})
const DESTINATARIOS = [
  { email: 'ana@example.com', name: 'Ana', reason: 'PROSPECTO', publico: 'PROSPECTOS', vars: {} },
  { email: 'beto@example.com', name: 'Beto', reason: 'PROSPECTO', publico: 'PROSPECTOS', vars: {} },
]
/** Las mismas dos personas al contar y al mandar: el `conjuntoHash` coincide. */
const CONJUNTO = 'conjunto-ana-beto'

beforeEach(() => {
  for (const fn of [
    prismaMock.staff.findUnique,
    prismaMock.staffVenue.findFirst,
    prismaMock.platformAccess.findUnique,
    prismaMock.crmCampaign.findUnique,
    prismaMock.crmCampaign.update,
    prismaMock.crmCampaign.updateMany,
    prismaMock.crmCampaignDelivery.groupBy,
    prismaMock.crmCampaignDelivery.createMany,
    prismaMock.crmAccount.findFirst,
    prismaMock.crmAccount.updateMany,
    prismaMock.crmAccount.findUniqueOrThrow,
    prismaMock.crmAccount.update,
    prismaMock.crmStage.findUnique,
    prismaMock.crmEmailOptOut.createMany,
    prismaMock.$queryRaw,
    contarAudiencia as jest.Mock,
    recorrerAudiencia as jest.Mock,
  ])
    fn.mockReset()
  // `requireCrm` lee al Staff para las llaves; la vista previa lee su nombre de la misma fila. No es superadmin.
  prismaMock.staff.findUnique.mockResolvedValue({ email: EMAIL, active: true, emailVerified: true, firstName: 'Yonatan', lastName: 'Ríos' })
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.crmCampaign.findUnique.mockResolvedValue(campana())
  prismaMock.crmCampaign.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.crmCampaign.update.mockResolvedValue(campana())
  prismaMock.crmCampaignDelivery.groupBy.mockResolvedValue([])
  prismaMock.crmCampaignDelivery.createMany.mockResolvedValue({ count: DESTINATARIOS.length })
  ;(contarAudiencia as jest.Mock).mockResolvedValue({
    total: DESTINATARIOS.length,
    porSegmento: { PROSPECTOS: DESTINATARIOS.length, CLIENTES: 0, USUARIOS: 0, AGREGADOS: 0 },
    bloqueados: 0,
    conjuntoHash: CONJUNTO,
  })
  ;(recorrerAudiencia as jest.Mock).mockImplementation(async (_audiencia, alLote) => {
    await alLote(DESTINATARIOS)
    return { entregados: DESTINATARIOS.length, conjuntoHash: CONJUNTO }
  })
})

describe('sólo «Mandar campañas» (Review Focus 1)', () => {
  beforeEach(() => llaves({ mandar: true }))

  it('abre la campaña, ve el correo, cuenta y la manda con el token de la vista previa', async () => {
    const detalle = await request(app).get(`/crm/campaigns/${CAMPAIGN}`)
    expect(detalle.status).toBe(200)
    expect(detalle.body.data).toMatchObject({ id: CAMPAIGN, status: 'BORRADOR', pruebaVigente: true })

    // `VistaPrevia` dentro de la campaña: «Mandar» trae «Ver campañas» (L1).
    const correo = await request(app).post('/crm/templates/preview').send({ subject: SUBJECT, blocks: BLOCKS })
    expect(correo.status).toBe(200)
    expect(correo.body.data.subject).toBe('Hola Ana')

    const conteo = await request(app).post(`/crm/campaigns/${CAMPAIGN}/preview`)
    expect(conteo.status).toBe(200)
    expect(conteo.body.data).toMatchObject({ total: 2, bloqueados: 0 })

    const mandada = await request(app).post(`/crm/campaigns/${CAMPAIGN}/send`).send({ token: conteo.body.data.token })
    expect(mandada.status).toBe(200)
    expect(mandada.body.data).toEqual({ total: 2 })
    // Mandar no edita: sólo BORRADOR → ENVIANDO y el total; nunca un PATCH del contenido ni del público.
    expect(prismaMock.crmCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: CAMPAIGN, status: 'BORRADOR' },
      data: { status: 'ENVIANDO', enqueuedAt: expect.any(Date) },
    })
    expect(prismaMock.crmCampaign.update).toHaveBeenCalledWith({ where: { id: CAMPAIGN }, data: { total: 2 } })
  })

  // H3 (Codex código r2): Yonatan abre la campaña con el público de Guadalajara; Rafa lo cambia a Monterrey mientras la ve.
  it('🔴 si alguien cambió la campaña mientras la veía, la vista previa contesta 409 sin token; con la versión actual, sí', async () => {
    const guadalajara = { ...campana(), audience: { segmentos: [{ tipo: 'CLIENTES', ciudades: ['Guadalajara'] }] } }
    const monterrey = { ...campana(), audience: { segmentos: [{ tipo: 'CLIENTES', ciudades: ['Monterrey'] }] } }

    prismaMock.crmCampaign.findUnique.mockResolvedValue(guadalajara)
    const vista = await request(app).get(`/crm/campaigns/${CAMPAIGN}`)
    expect(vista.body.data.huella).toMatch(/^[0-9a-f]{64}$/)

    prismaMock.crmCampaign.findUnique.mockResolvedValue(monterrey)
    const vieja = await request(app).post(`/crm/campaigns/${CAMPAIGN}/preview`).send({ huella: vista.body.data.huella })
    expect(vieja.status).toBe(409)
    expect(vieja.body).toEqual({
      code: 'CRM_CAMPANA_CAMBIO',
      message: 'Alguien cambió esta campaña mientras la veías. Ya te enseñamos la versión nueva: revísala y vuelve a confirmar.',
    })
    expect(contarAudiencia).not.toHaveBeenCalled()

    // La pantalla recarga: con la huella de Monterrey ya cuenta y firma.
    const nueva = await request(app).get(`/crm/campaigns/${CAMPAIGN}`)
    const conteo = await request(app).post(`/crm/campaigns/${CAMPAIGN}/preview`).send({ huella: nueva.body.data.huella })
    expect(conteo.status).toBe(200)
    expect(conteo.body.data).toMatchObject({ total: 2, token: expect.any(String) })
  })

  it('una huella que no es texto o es enorme se rechaza en español, sin contar', async () => {
    for (const huella of [123, 'x'.repeat(201), '']) {
      const res = await request(app).post(`/crm/campaigns/${CAMPAIGN}/preview`).send({ huella })
      expect(res.status).toBe(400)
      expect(res.body.message).toMatch(/^Error de validación: huella: La versión que ves no es válida/)
    }
    expect(contarAudiencia).not.toHaveBeenCalled()
  })

  it('no edita ni se manda la prueba: 403 y no se toca la campaña', async () => {
    for (const res of [
      await request(app).patch(`/crm/campaigns/${CAMPAIGN}`).send({ name: 'Otra' }),
      await request(app).post(`/crm/campaigns/${CAMPAIGN}/test`),
    ]) {
      expect(res.status).toBe(403)
      expect(res.body).toMatchObject({ code: 'CRM_FORBIDDEN', message: 'No tienes la llave «Preparar campañas»' })
    }
    expect(prismaMock.crmCampaign.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.crmCampaign.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.crmCampaign.update).not.toHaveBeenCalled()
  })
})

describe('«Preparar campañas» sin «Mandar campañas»', () => {
  it('cuenta, pero mandar y cancelar son 403', async () => {
    llaves({ preparar: true })
    expect((await request(app).post(`/crm/campaigns/${CAMPAIGN}/preview`)).status).toBe(200)
    for (const res of [
      await request(app).post(`/crm/campaigns/${CAMPAIGN}/send`).send({ token: 'x.y' }),
      await request(app).post(`/crm/campaigns/${CAMPAIGN}/cancel`),
    ]) {
      expect(res.status).toBe(403)
      expect(res.body).toMatchObject({ code: 'CRM_FORBIDDEN', message: 'No tienes la llave «Mandar campañas»' })
    }
    expect(prismaMock.crmCampaign.updateMany).not.toHaveBeenCalled()
  })
})

describe('sólo «Ver campañas»: la vista previa con el contexto de un negocio no lee a nadie (L4)', () => {
  // La cuenta existe y se llama «Café Secreto»: sólo la encuentra quien la puede ver.
  beforeEach(() =>
    prismaMock.crmAccount.findFirst.mockImplementation(async ({ where }: { where: unknown }) =>
      JSON.stringify(where).includes('"in":[]')
        ? null
        : { name: 'Café Secreto', contacts: [{ id: 'ccontactfi000000000000001', name: 'Ana', email: 'ana@example.com' }] },
    ),
  )

  it('sin «Ver negocios» es 404 y nunca sale su nombre', async () => {
    llaves({ verCampanas: true })
    const res = await request(app)
      .post('/crm/templates/preview')
      .send({ subject: SUBJECT, blocks: BLOCKS, contexto: { accountId: ACCOUNT } })

    expect(res.status).toBe(404)
    expect(JSON.stringify(res.body)).not.toContain('Café Secreto')
    expect(prismaMock.crmAccount.findFirst.mock.calls[0][0].where).toEqual({ AND: [{ id: ACCOUNT }, { id: { in: [] } }] })
  })

  it('con «Ver negocios» además, la misma vista previa sí trae al negocio', async () => {
    llaves({ verCampanas: true, verScope: 'todos' })
    const res = await request(app)
      .post('/crm/templates/preview')
      .send({ subject: SUBJECT, blocks: BLOCKS, contexto: { accountId: ACCOUNT } })

    expect(res.status).toBe(200)
    expect(res.body.data.text).toContain('Hola Café Secreto')
  })
})

describe('«Configurar el CRM» y «Eliminar» (L7)', () => {
  it('con «Configurar» y sin ser superadmin real, eliminar sigue en CRM_SOLO_SUPERADMIN y no toca nada', async () => {
    llaves({ configurar: true })
    const res = await request(app).post(`/crm/accounts/${ACCOUNT}/delete`).send({ confirmName: 'Café Secreto' })

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('CRM_SOLO_SUPERADMIN')
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })

  it('sin «Configurar» ni la puerta se abre', async () => {
    llaves({ equipo: true, bajas: true })
    const res = await request(app).post(`/crm/accounts/${ACCOUNT}/delete`).send({ confirmName: 'Café Secreto' })
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ code: 'CRM_FORBIDDEN', message: 'No tienes la llave «Configurar el CRM»' })
  })
})

describe('«Bajas de correo» va sola (L1, L8)', () => {
  it('con sólo «Bajas» da de baja el correo; con «Configurar» o «Equipo» no', async () => {
    prismaMock.crmEmailOptOut.createMany.mockResolvedValue({ count: 1 })
    llaves({ bajas: true })
    const ok = await request(app).post('/crm/opt-outs').send({ email: 'Cliente@Example.com' })
    expect(ok.status).toBe(200)
    expect(prismaMock.crmEmailOptOut.createMany).toHaveBeenCalledWith({
      data: [{ email: 'cliente@example.com', source: 'ADMIN', actorStaffId: STAFF }],
      skipDuplicates: true,
    })

    prismaMock.crmEmailOptOut.createMany.mockClear()
    llaves({ equipo: true, configurar: true })
    const no = await request(app).post('/crm/opt-outs').send({ email: 'cliente@example.com' })
    expect(no.status).toBe(403)
    expect(no.body).toMatchObject({ code: 'CRM_FORBIDDEN', message: 'No tienes la llave «Bajas de correo»' })
    expect(prismaMock.crmEmailOptOut.createMany).not.toHaveBeenCalled()
  })
})

describe('«Equipo y llaves» no da lo que no tiene (Review Focus 2, por HTTP)', () => {
  it('quien sólo tiene «Equipo» y da «Mandar campañas» recibe 403 CRM_KEY_ESCALATION, sin escribir nada', async () => {
    // La fila de quien pide se busca por su correo; la persona nueva todavía no tiene fila.
    prismaMock.platformAccess.findUnique.mockImplementation(async ({ where }: { where: { email: string } }) =>
      where.email === EMAIL ? fila({ equipo: true }) : null,
    )
    const keys = {
      ver: null,
      editar: null,
      cerrar: false,
      contactar: false,
      exportar: false,
      ventas: false,
      bajas: false,
      plantillas: false,
      preparar: false,
      mandar: true,
      verCampanas: false,
      equipo: false,
      configurar: false,
    }

    const res = await request(app).post('/crm/team').send({ email: 'nueva@avoqado.io', firstName: 'Nueva', lastName: 'Persona', keys })

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('CRM_KEY_ESCALATION')
    expect(res.body.message).toContain('Mandar campañas')
    expect(prismaMock.platformAccess.upsert).not.toHaveBeenCalled()
  })
})

describe('«Editar» sin «Cerrar negocios» no reabre (Review Focus 4)', () => {
  it('mover un PERDIDO a «Demo» por /stage es 403 «Cerrar negocios» y no lo reabre; ganar y perder también piden la llave', async () => {
    llaves({ verScope: 'propios', editarScope: 'propios' })
    prismaMock.crmStage.findUnique.mockResolvedValue({ id: DEMO, name: 'Demo', kind: 'ABIERTA' })
    prismaMock.crmAccount.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.crmAccount.findUniqueOrThrow.mockResolvedValue({
      id: ACCOUNT,
      stageId: PERDIDO,
      stage: { id: PERDIDO, name: 'Perdido', kind: 'PERDIDA', staleDays: null },
      archivedAt: null,
    })

    const movido = await request(app).post(`/crm/accounts/${ACCOUNT}/stage`).send({ stageId: DEMO })
    expect(movido.status).toBe(403)
    expect(movido.body.code).toBe('CRM_FORBIDDEN')
    expect(movido.body.message).toContain('«Cerrar negocios»')
    expect(prismaMock.crmAccount.update).not.toHaveBeenCalled()

    for (const res of [
      await request(app).post(`/crm/accounts/${ACCOUNT}/win`).send({ organizationId: 'corgclient000000000000001' }),
      await request(app).post(`/crm/accounts/${ACCOUNT}/lose`).send({ lostReasonId: 'creasonpr0000000000000001' }),
    ]) {
      expect(res.status).toBe(403)
      expect(res.body).toMatchObject({ code: 'CRM_FORBIDDEN', message: 'No tienes la llave «Cerrar negocios»' })
    }
    expect(prismaMock.crmAccount.update).not.toHaveBeenCalled()
  })
})
