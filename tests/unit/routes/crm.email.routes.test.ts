/**
 * Las rutas de plantillas, vista previa, prueba e imágenes de `/api/v1/crm`, con la guardia REAL (`requireCrm` releyendo las
 * llaves de la base —simulada—): quien sólo manda correo uno a uno LEE las plantillas pero no las escribe; quien tenía
 * «Campañas masivas» (hoy las 4 llaves de correo masivo, L2) las escribe pero no ve ni un negocio; y lo que se guarda no puede
 * inyectar nada. Las llaves finas una por una: `crm.llaves-finas.routes.test.ts`.
 */
import 'express-async-errors'
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { prismaMock } from '@tests/__helpers__/setup'
import { uploadAnnouncementImage } from '@/services/announcements/announcementImage.service'
import emailService from '@/services/email.service'
import * as templatesService from '@/services/crm/email/templates.service'
import * as campaignsService from '@/services/crm/email/campaigns.service'
import * as teamService from '@/services/crm/teamVenue.service'

const STAFF = 'cstaffemail00000000000001'
const TEMPLATE = 'ctemplate0000000000000001'
const ACCOUNT = 'caccountem0000000000000001'

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: unknown, next: () => void) => {
    req.authContext = {
      userId: 'cstaffemail00000000000001',
      orgId: 'corgteam00000000000000001',
      venueId: 'cvenuecrm0000000000000001',
      role: 'VIEWER',
    }
    next()
  },
  // La vuelta de Google lee la sesión SIN exigirla (`autenticacionOpcional`): aquí «hay sesión» = traer este encabezado.
  extraerToken: (req: any) => req.headers['x-test-token'],
}))
jest.mock('@/services/announcements/announcementImage.service', () => ({ uploadAnnouncementImage: jest.fn() }))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendEmailWithResult: jest.fn() } }))

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

/** Las siete llaves de una persona, como las guarda `PlatformAccess`; por default ninguna. */
const keys = (over: Record<string, unknown>) =>
  prismaMock.platformAccess.findUnique.mockResolvedValue({
    id: 'caccessem0000000000000001',
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
/** Como deja la migración de las llaves finas (L2) una fila vieja con `campanas`, y una con `admin`. */
const CAMPANAS_DE_ANTES = { campanas: true, plantillas: true, preparar: true, mandar: true, verCampanas: true }
const ADMIN_DE_ANTES = { ...CAMPANAS_DE_ANTES, admin: true, equipo: true, configurar: true, bajas: true }
const soloContactar = () => keys({ verScope: 'propios', editarScope: 'propios', contactar: true })
const soloCampanas = () => keys(CAMPANAS_DE_ANTES)

const template = (over: Record<string, unknown> = {}) => ({
  id: TEMPLATE,
  name: 'Novedades',
  subject: 'Hola {{nombre}}',
  blocks: [{ type: 'paragraph', text: 'Hola {{nombre}}' }],
  archivedAt: null,
  createdById: STAFF,
  updatedById: STAFF,
  createdAt: new Date('2026-11-02T10:00:00Z'),
  updatedAt: new Date('2026-11-02T10:00:00Z'),
  ...over,
})
const BODY = { name: 'Novedades', subject: 'Hola {{nombre}}', blocks: [{ type: 'paragraph', text: 'Hola {{nombre}}' }] }

const ENV = { ...process.env }

beforeEach(() => {
  for (const fn of [
    prismaMock.staff.findUnique,
    prismaMock.staffVenue.findFirst,
    prismaMock.platformAccess.findUnique,
    prismaMock.crmEmailTemplate.create,
    prismaMock.crmEmailTemplate.findMany,
    prismaMock.crmEmailTemplate.findUnique,
    prismaMock.crmEmailTemplate.count,
    prismaMock.crmEmailTemplate.update,
    prismaMock.crmEmailTemplate.updateMany,
    prismaMock.crmAccount.findFirst,
    prismaMock.crmAccount.findMany,
    prismaMock.crmAccount.count,
    uploadAnnouncementImage as jest.Mock,
    emailService.sendEmailWithResult as jest.Mock,
  ])
    fn.mockReset()
  // `requireCrm` lee al Staff para las llaves; el servicio de la prueba lee su correo y su nombre de la misma fila.
  prismaMock.staff.findUnique.mockResolvedValue({
    email: 'rafa@avoqado.io',
    active: true,
    emailVerified: true,
    firstName: 'Rafa',
    lastName: 'Pérez',
  })
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.crmEmailTemplate.create.mockResolvedValue(template())
  prismaMock.crmEmailTemplate.findMany.mockResolvedValue([template()])
  prismaMock.crmEmailTemplate.count.mockResolvedValue(1)
  prismaMock.crmEmailTemplate.findUnique.mockResolvedValue(template())
  prismaMock.crmEmailTemplate.update.mockResolvedValue(template())
  prismaMock.crmEmailTemplate.updateMany.mockResolvedValue({ count: 1 })
  delete process.env.CRM_CORREO_PRUEBAS
})

afterEach(() => {
  if (ENV.CRM_CORREO_PRUEBAS === undefined) delete process.env.CRM_CORREO_PRUEBAS
  else process.env.CRM_CORREO_PRUEBAS = ENV.CRM_CORREO_PRUEBAS
})

describe('quien sólo tiene «Mandar correo» (crm:contactar)', () => {
  beforeEach(soloContactar)

  it('lee las plantillas: la lista con su total, y una por id', async () => {
    const list = await request(app).get('/crm/templates')
    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(1)
    expect(list.body.meta).toEqual({ total: 1, nextCursor: null })

    const one = await request(app).get(`/crm/templates/${TEMPLATE}`)
    expect(one.status).toBe(200)
    expect(one.body.data).toMatchObject({ id: TEMPLATE, subject: 'Hola {{nombre}}' })
  })

  it('usa la vista previa', async () => {
    const res = await request(app).post('/crm/templates/preview').send({ subject: 'Hola', blocks: BODY.blocks })
    expect(res.status).toBe(200)
    expect(res.body.data.html).toContain('Hola Ana')
  })

  it('no crea (POST 403), ni edita, ni archiva, ni manda la prueba, ni sube imágenes', async () => {
    const results = await Promise.all([
      request(app).post('/crm/templates').send(BODY),
      request(app).patch(`/crm/templates/${TEMPLATE}`).send({ name: 'x' }),
      request(app).post(`/crm/templates/${TEMPLATE}/archive`),
      request(app).post(`/crm/templates/${TEMPLATE}/unarchive`),
      request(app).post('/crm/templates/test').send({ subject: 'Hola', blocks: BODY.blocks }),
      request(app).post('/crm/uploads/image').attach('file', Buffer.from('x'), { filename: 'a.png', contentType: 'image/png' }),
    ])
    for (const res of results) {
      expect(res.status).toBe(403)
      expect(res.body.code).toBe('CRM_FORBIDDEN')
    }
    expect(prismaMock.crmEmailTemplate.create).not.toHaveBeenCalled()
    expect(prismaMock.crmEmailTemplate.update).not.toHaveBeenCalled()
    expect(prismaMock.crmEmailTemplate.updateMany).not.toHaveBeenCalled()
    expect(uploadAnnouncementImage).not.toHaveBeenCalled()
    expect(emailService.sendEmailWithResult).not.toHaveBeenCalled()
  })
})

describe('quien sólo tiene las 4 llaves de correo masivo (plantillas, preparar, mandar, ver-campanas), sin «Ver negocios»', () => {
  beforeEach(soloCampanas)

  it('crea una plantilla (201) y la guarda a su nombre', async () => {
    const res = await request(app).post('/crm/templates').send(BODY)

    expect(res.status).toBe(201)
    expect(res.body.data.id).toBe(TEMPLATE)
    expect(prismaMock.crmEmailTemplate.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ createdById: STAFF, updatedById: STAFF }) }),
    )
  })

  it('lee las plantillas, la vista previa de ejemplo y las edita y archiva', async () => {
    expect((await request(app).get('/crm/templates')).status).toBe(200)
    expect((await request(app).post('/crm/templates/preview').send({ subject: 'Hola', blocks: BODY.blocks })).status).toBe(200)
    expect((await request(app).patch(`/crm/templates/${TEMPLATE}`).send({ name: 'Otro' })).status).toBe(200)
    expect((await request(app).post(`/crm/templates/${TEMPLATE}/archive`)).status).toBe(200)
    expect((await request(app).post(`/crm/templates/${TEMPLATE}/unarchive`)).status).toBe(200)
  })

  it('🔴 recibe 403 en el embudo, las fichas y «Mis pendientes»: ni un negocio', async () => {
    for (const path of ['/crm/accounts', `/crm/accounts/${ACCOUNT}`, '/crm/pending', '/crm/clients']) {
      const res = await request(app).get(path)
      expect(res.status).toBe(403)
      expect(res.body.code).toBe('CRM_FORBIDDEN')
    }
    expect(prismaMock.crmAccount.findMany).not.toHaveBeenCalled()
  })

  it('la vista previa con el contexto de un negocio es 404: no tiene «Ver negocios», no hay cuenta dentro de su alcance', async () => {
    prismaMock.crmAccount.findFirst.mockResolvedValue(null)
    const res = await request(app)
      .post('/crm/templates/preview')
      .send({ subject: 'Hola', blocks: BODY.blocks, contexto: { accountId: ACCOUNT } })

    expect(res.status).toBe(404)
    expect(prismaMock.crmAccount.findFirst.mock.calls[0][0].where).toEqual({ AND: [{ id: ACCOUNT }, { id: { in: [] } }] })
  })

  it('la prueba a sí mismo, en NODE_ENV=test sin CRM_CORREO_PRUEBAS, dice «fuera de la lista de prueba» y no llama a Resend', async () => {
    const res = await request(app).post('/crm/templates/test').send({ subject: 'Hola', blocks: BODY.blocks })

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ ok: false, motivo: 'fuera de la lista de prueba' })
    expect(emailService.sendEmailWithResult).not.toHaveBeenCalled()
  })

  it('con su correo en la lista, la prueba sale', async () => {
    process.env.CRM_CORREO_PRUEBAS = 'rafa@avoqado.io'
    ;(emailService.sendEmailWithResult as jest.Mock).mockResolvedValue({ ok: true, transient: false })

    const res = await request(app).post('/crm/templates/test').send({ subject: 'Hola', blocks: BODY.blocks })

    expect(res.body.data).toEqual({ ok: true })
    expect((emailService.sendEmailWithResult as jest.Mock).mock.calls[0][0].to).toBe('rafa@avoqado.io')
  })
})

describe('un administrador de antes (migrado, L2)', () => {
  it('sigue escribiendo plantillas: la migración le dio «Plantillas»', async () => {
    keys(ADMIN_DE_ANTES)
    expect((await request(app).post('/crm/templates').send(BODY)).status).toBe(201)
  })
})

describe('POST /crm/opt-outs — «Dar de baja este correo» (la oposición, desde la ficha)', () => {
  const EMAIL = 'cliente@example.com'

  beforeEach(() => {
    prismaMock.crmEmailOptOut.createMany.mockReset()
    prismaMock.crmEmailOptOut.createMany.mockResolvedValue({ count: 1 })
  })

  it.each([
    ['sin llaves', {}],
    ['«Mandar correo» (contactar)', { verScope: 'todos', editarScope: 'todos', contactar: true }],
    ['«Campañas masivas» (campanas)', CAMPANAS_DE_ANTES],
    ['«Ver negocios», «Editar» y «Exportar»', { verScope: 'todos', editarScope: 'todos', exportar: true }],
  ])('🔴 %s: 403 y no escribe nada (sólo «Bajas de correo» da de baja)', async (_name, over) => {
    keys(over)
    const res = await request(app).post('/crm/opt-outs').send({ email: EMAIL })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('CRM_FORBIDDEN')
    expect(prismaMock.crmEmailOptOut.createMany).not.toHaveBeenCalled()
  })

  it('un admin de antes (con «Bajas de correo»): da de baja el correo (en minúsculas), con origen ADMIN y a su nombre', async () => {
    keys(ADMIN_DE_ANTES)
    const res = await request(app).post('/crm/opt-outs').send({ email: '  Cliente@Example.COM ' })

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ ok: true })
    expect(prismaMock.crmEmailOptOut.createMany).toHaveBeenCalledWith({
      data: [{ email: EMAIL, source: 'ADMIN', actorStaffId: STAFF }],
      skipDuplicates: true,
    })
  })

  it('repetirlo es 200 otra vez (idempotente)', async () => {
    keys(ADMIN_DE_ANTES)
    prismaMock.crmEmailOptOut.createMany.mockResolvedValue({ count: 0 })
    expect((await request(app).post('/crm/opt-outs').send({ email: EMAIL })).status).toBe(200)
  })

  it.each([[{}], [{ email: '' }], [{ email: 'no-es-correo' }], [{ email: 42 }], [{ email: `${'a'.repeat(250)}@example.com` }]])(
    'un cuerpo inválido (%j) es 400 y no escribe',
    async body => {
      keys(ADMIN_DE_ANTES)
      const res = await request(app).post('/crm/opt-outs').send(body)
      expect(res.status).toBe(400)
      expect(prismaMock.crmEmailOptOut.createMany).not.toHaveBeenCalled()
    },
  )
})

describe('quien no tiene ninguna llave del correo', () => {
  it.each([
    ['sin llaves', {}],
    ['sólo «Ver negocios» y «Editar»', { verScope: 'todos', editarScope: 'todos' }],
    ['«Mandar correo» sin «Ver negocios» (no vale solo)', { contactar: true }],
  ])('%s: 403 en todo', async (_name, over) => {
    keys(over)
    for (const res of [
      await request(app).get('/crm/templates'),
      await request(app).get(`/crm/templates/${TEMPLATE}`),
      await request(app).post('/crm/templates/preview').send({ subject: 'Hola', blocks: BODY.blocks }),
      await request(app).post('/crm/templates').send(BODY),
    ])
      expect(res.status).toBe(403)
  })
})

describe('lo que se guarda tiene que ser seguro', () => {
  beforeEach(soloCampanas)

  it('{{precio}} es 400 con «Variable desconocida: {{precio}}»', async () => {
    const res = await request(app)
      .post('/crm/templates')
      .send({ ...BODY, blocks: [{ type: 'paragraph', text: 'Cuesta {{precio}}' }] })

    expect(res.status).toBe(400)
    expect(res.body.message).toBe('Variable desconocida: {{precio}}')
    expect(prismaMock.crmEmailTemplate.create).not.toHaveBeenCalled()
  })

  it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'JaVaScRiPt:alert(1)'])(
    'un botón con la url %s es 400: sólo http(s)',
    async url => {
      const res = await request(app)
        .post('/crm/templates')
        .send({ ...BODY, blocks: [{ type: 'button', label: 'Ver', url }] })

      expect(res.status).toBe(400)
      expect(res.body.message).toContain('El bloque 1 necesita una dirección válida que empiece con http:// o https://')
      expect(prismaMock.crmEmailTemplate.create).not.toHaveBeenCalled()
    },
  )

  it('lo mismo en una imagen, y al editar', async () => {
    const bad = [{ type: 'image', url: 'javascript:alert(1)', alt: 'x' }]
    expect(
      (
        await request(app)
          .post('/crm/templates')
          .send({ ...BODY, blocks: bad })
      ).status,
    ).toBe(400)
    expect((await request(app).patch(`/crm/templates/${TEMPLATE}`).send({ blocks: bad })).status).toBe(400)
    expect((await request(app).post('/crm/templates/preview').send({ subject: 'x', blocks: bad })).status).toBe(400)
  })

  it('un tipo de bloque inventado, un bloque vacío, ningún bloque y demasiados son 400 en español', async () => {
    const send = (blocks: unknown) =>
      request(app)
        .post('/crm/templates')
        .send({ ...BODY, blocks })

    expect((await send([{ type: 'script', text: 'x' }])).body.message).toContain('El bloque 1 no es válido')
    expect((await send([{ type: 'paragraph', text: '   ' }])).body.message).toContain('El bloque 1 no puede quedar vacío')
    expect((await send([])).body.message).toContain('Agrega al menos un bloque')
    expect((await send('hola')).body.message).toContain('lista de bloques')
    expect((await send(Array.from({ length: 51 }, () => ({ type: 'divider' })))).body.message).toContain('Máximo 50 bloques')
    expect((await send([{ type: 'paragraph', text: 'x'.repeat(100_001) }])).body.message).toContain('demasiado largo')
  })

  it('un cuerpo sin nada que cambiar es 400, y los ids tienen que ser cuid', async () => {
    expect((await request(app).patch(`/crm/templates/${TEMPLATE}`).send({})).body.message).toContain('No hay nada que cambiar')
    expect((await request(app).get('/crm/templates/no-es-un-cuid')).status).toBe(400)
  })

  it('un texto raro se guarda como TEXTO y en la vista previa sale escapado', async () => {
    const raro = [
      { type: 'heading', text: '<script>alert("x")</script>' },
      { type: 'paragraph', text: `Hola "{{nombre}}" & <img src=x onerror=alert(1)>` },
      { type: 'image', url: 'https://avoqado.io/a.png', alt: '" onerror="alert(1)' },
    ]
    const res = await request(app).post('/crm/templates/preview').send({ subject: 'x', blocks: raro })

    expect(res.status).toBe(200)
    const html: string = res.body.data.html
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('" onerror="alert(1)')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&quot;Ana&quot; &amp; &lt;img src=x onerror=alert(1)&gt;')
  })

  it('un límite desmedido se recorta a 100, y archivadas=true pide sólo las archivadas', async () => {
    await request(app).get('/crm/templates?limit=100000&archivadas=true')

    const args = prismaMock.crmEmailTemplate.findMany.mock.calls[0][0]
    expect(args.take).toBe(101)
    expect(args.where).toEqual({ archivedAt: { not: null } })
  })

  it('una plantilla que no existe es 404', async () => {
    prismaMock.crmEmailTemplate.findUnique.mockResolvedValue(null)
    const res = await request(app).get(`/crm/templates/${TEMPLATE}`)
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('CRM_PLANTILLA_NOT_FOUND')
  })
})

describe('POST /crm/uploads/image', () => {
  const FIVE_MB = 5 * 1024 * 1024
  const upload = () => request(app).post('/crm/uploads/image')

  beforeEach(soloCampanas)

  it('sube la imagen con el servicio de siempre y devuelve su url', async () => {
    ;(uploadAnnouncementImage as jest.Mock).mockResolvedValue({ url: 'https://storage.example/announcements/x.png' })
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

    const res = await upload().attach('file', bytes, { filename: 'logo.png', contentType: 'image/png' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data: { url: 'https://storage.example/announcements/x.png' } })
    expect(uploadAnnouncementImage).toHaveBeenCalledWith(expect.any(Buffer), 'image/png', 'logo.png')
    expect((uploadAnnouncementImage as jest.Mock).mock.calls[0][0].equals(bytes)).toBe(true)
  })

  it('png, jpeg y webp pasan; 5 MB exactos pasan', async () => {
    ;(uploadAnnouncementImage as jest.Mock).mockResolvedValue({ url: 'https://storage.example/x' })
    for (const [filename, contentType] of [
      ['a.jpg', 'image/jpeg'],
      ['a.webp', 'image/webp'],
    ])
      expect((await upload().attach('file', Buffer.alloc(10), { filename, contentType })).status).toBe(200)
    expect((await upload().attach('file', Buffer.alloc(FIVE_MB, 1), { filename: 'a.png', contentType: 'image/png' })).status).toBe(200)
  })

  it('más de 5 MB es 400, no 500', async () => {
    const res = await upload().attach('file', Buffer.alloc(FIVE_MB + 1, 1), { filename: 'a.png', contentType: 'image/png' })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ code: 'CRM_IMAGEN_INVALIDA', message: 'La imagen puede pesar hasta 5 MB' })
    expect(uploadAnnouncementImage).not.toHaveBeenCalled()
  })

  it('un PDF, un GIF o un SVG es 400 y no llega al servicio', async () => {
    for (const [filename, contentType] of [
      ['a.pdf', 'application/pdf'],
      ['a.gif', 'image/gif'],
      ['a.svg', 'image/svg+xml'],
    ]) {
      const res = await upload().attach('file', Buffer.from('x'), { filename, contentType })
      expect(res.status).toBe(400)
      expect(res.body.message).toBe('Sube una sola imagen PNG, JPG o WEBP')
    }
    expect(uploadAnnouncementImage).not.toHaveBeenCalled()
  })

  it('sin archivo es 400, y dos archivos también', async () => {
    expect((await upload()).status).toBe(400)
    const two = await upload()
      .attach('file', Buffer.from('x'), { filename: 'a.png', contentType: 'image/png' })
      .attach('file', Buffer.from('x'), { filename: 'b.png', contentType: 'image/png' })
    expect(two.status).toBe(400)
    expect(uploadAnnouncementImage).not.toHaveBeenCalled()
  })

  it('si el servicio rechaza los bytes (no es una imagen de verdad), el 400 es el suyo', async () => {
    const { BadRequestError } = jest.requireActual('@/errors/AppError')
    ;(uploadAnnouncementImage as jest.Mock).mockRejectedValue(new BadRequestError('El archivo no es una imagen válida'))

    const res = await upload().attach('file', Buffer.from('MZ-not-an-image'), { filename: 'a.png', contentType: 'image/png' })

    expect(res.status).toBe(400)
    expect(res.body.message).toBe('El archivo no es una imagen válida')
  })
})

describe('/crm/campaigns — las llaves de correo masivo (L5)', () => {
  const CAMPAIGN = 'ccampaign0000000000000001'
  const campana = {
    id: CAMPAIGN,
    name: 'Novedades de noviembre',
    templateId: TEMPLATE,
    subject: 'Hola {{nombre}}',
    blocks: [{ type: 'paragraph', text: 'Hola {{nombre}}' }],
    audience: { segmentos: [] },
    status: 'BORRADOR',
    testSentHash: null,
    total: 0,
    createdById: STAFF,
    enqueuedAt: null,
    finishedAt: null,
    cancelledAt: null,
    createdAt: new Date('2026-11-02T10:00:00Z'),
    updatedAt: new Date('2026-11-02T10:00:00Z'),
  }
  const rutas: Array<[string, () => request.Test]> = [
    ['GET /campaigns', () => request(app).get('/crm/campaigns')],
    ['POST /campaigns', () => request(app).post('/crm/campaigns').send({ name: 'x', templateId: TEMPLATE })],
    ['GET /campaigns/:id', () => request(app).get(`/crm/campaigns/${CAMPAIGN}`)],
    ['GET /campaigns/:id/recipients', () => request(app).get(`/crm/campaigns/${CAMPAIGN}/recipients`)],
    ['PATCH /campaigns/:id', () => request(app).patch(`/crm/campaigns/${CAMPAIGN}`).send({ name: 'Otra' })],
    ['POST /campaigns/:id/preview', () => request(app).post(`/crm/campaigns/${CAMPAIGN}/preview`)],
    ['POST /campaigns/:id/test', () => request(app).post(`/crm/campaigns/${CAMPAIGN}/test`)],
    ['POST /campaigns/:id/send', () => request(app).post(`/crm/campaigns/${CAMPAIGN}/send`).send({ token: 'x.y' })],
    ['POST /campaigns/:id/cancel', () => request(app).post(`/crm/campaigns/${CAMPAIGN}/cancel`)],
  ]

  beforeEach(() => {
    for (const fn of [
      prismaMock.crmCampaign.create,
      prismaMock.crmCampaign.findUnique,
      prismaMock.crmCampaign.findMany,
      prismaMock.crmCampaign.count,
      prismaMock.crmCampaignDelivery.groupBy,
    ])
      fn.mockReset()
    prismaMock.crmCampaign.create.mockResolvedValue(campana)
    prismaMock.crmCampaign.findUnique.mockResolvedValue(campana)
    prismaMock.crmCampaign.findMany.mockResolvedValue([campana])
    prismaMock.crmCampaign.count.mockResolvedValue(1)
    prismaMock.crmCampaignDelivery.groupBy.mockResolvedValue([])
  })

  it.each(rutas)('🔴 quien sólo manda correo uno a uno recibe 403 en %s y no se toca nada', async (_ruta, llamar) => {
    soloContactar()
    const res = await llamar()
    expect(res.status).toBe(403)
    expect(prismaMock.crmCampaign.create).not.toHaveBeenCalled()
    expect(prismaMock.crmCampaign.findUnique).not.toHaveBeenCalled()
  })

  it('con «Campañas masivas» crea el borrador desde la plantilla y lee la lista con su total', async () => {
    soloCampanas()

    const creada = await request(app).post('/crm/campaigns').send({ name: 'Novedades de noviembre', templateId: TEMPLATE })
    expect(creada.status).toBe(201)
    expect(creada.body.data).toMatchObject({ id: CAMPAIGN, status: 'BORRADOR', pruebaVigente: false, contadores: {} })
    expect(creada.body.data).not.toHaveProperty('testSentHash')
    expect(prismaMock.crmCampaign.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ subject: 'Hola {{nombre}}', createdById: STAFF }) }),
    )

    const lista = await request(app).get('/crm/campaigns?limit=500')
    expect(lista.status).toBe(200)
    expect(lista.body.meta).toEqual({ total: 1, nextCursor: null })
    // El tope de 100 lo pone el servidor, pida lo que pida el cliente.
    expect(prismaMock.crmCampaign.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 101 }))
  })

  it('un público mal formado se rechaza al guardar, en español', async () => {
    soloCampanas()
    const res = await request(app)
      .patch(`/crm/campaigns/${CAMPAIGN}`)
      .send({ audience: { segmentos: [{ tipo: 'CLIENTES' }, { tipo: 'CLIENTES' }] } })
    expect(res.status).toBe(400)
  })
})

describe('el Gmail del vendedor — sólo «Mandar correo» (crm:contactar)', () => {
  const EMAIL_BODY = {
    contactId: 'ccontactem0000000000000001',
    subject: 'Hola',
    blocks: [{ type: 'paragraph', text: 'Hola' }],
    clientRequestId: 'clic-0000-0001',
  }

  beforeEach(() => {
    for (const fn of [prismaMock.crmGmailConnection.findUnique, prismaMock.crmGmailAccountSeen.count]) fn.mockReset()
    prismaMock.crmGmailConnection.findUnique.mockResolvedValue(null)
    prismaMock.crmGmailAccountSeen.count.mockResolvedValue(3)
    for (const nombre of ['CRM_GMAIL_CLIENT_ID', 'CRM_GMAIL_CLIENT_SECRET', 'CRM_GMAIL_REDIRECT_URI', 'CRM_GMAIL_TOKEN_KEY'])
      delete process.env[nombre]
    process.env.SUPERADMIN_URL = 'https://superadmin.test'
  })

  afterEach(() => {
    for (const nombre of [
      'CRM_GMAIL_CLIENT_ID',
      'CRM_GMAIL_CLIENT_SECRET',
      'CRM_GMAIL_REDIRECT_URI',
      'CRM_GMAIL_TOKEN_KEY',
      'OAUTH_STATE_SECRET',
      'SUPERADMIN_URL',
    ]) {
      if (ENV[nombre] === undefined) delete process.env[nombre]
      else process.env[nombre] = ENV[nombre]
    }
  })

  it('🔴 Rafa con sólo «Campañas masivas» recibe 403 en «Mi Gmail», al conectar, al desconectar y al mandar', async () => {
    soloCampanas()
    for (const res of [
      await request(app).get('/crm/gmail'),
      await request(app).get('/crm/gmail/connect'),
      await request(app).post('/crm/gmail/disconnect'),
      await request(app).post(`/crm/accounts/${ACCOUNT}/emails`).send(EMAIL_BODY),
    ]) {
      expect(res.status).toBe(403)
      expect(res.body.code).toBe('CRM_FORBIDDEN')
    }
  })

  it('con «Mandar correo», «Mi Gmail» dice que falta configurar la app, y conectar da el error claro', async () => {
    soloContactar()
    const estado = await request(app).get('/crm/gmail')
    expect(estado.status).toBe(200)
    expect(estado.body.data).toEqual({ configurado: false, conectado: false, cuentasUsadas: 3, tope: 100 })

    const conectar = await request(app).get('/crm/gmail/connect')
    expect(conectar.status).toBe(503)
    expect(conectar.body.message).toBe('Falta configurar la app de Google')
  })

  it('mandar sin clientRequestId, o con uno raro, es 400 en español', async () => {
    soloContactar()
    const sinClic: Partial<typeof EMAIL_BODY> = { ...EMAIL_BODY }
    delete sinClic.clientRequestId
    expect((await request(app).post(`/crm/accounts/${ACCOUNT}/emails`).send(sinClic)).status).toBe(400)
    const raro = await request(app)
      .post(`/crm/accounts/${ACCOUNT}/emails`)
      .send({ ...EMAIL_BODY, clientRequestId: 'a b"<script>' })
    expect(raro.status).toBe(400)
    expect(raro.body.message).toContain('El identificador del envío no es válido')
  })

  describe('GET /crm/gmail/callback — la vuelta de Google, sin exigir sesión', () => {
    beforeEach(() => {
      Object.assign(process.env, {
        CRM_GMAIL_CLIENT_ID: 'client-id',
        CRM_GMAIL_CLIENT_SECRET: 'client-secret',
        CRM_GMAIL_REDIRECT_URI: 'https://api.avoqado.test/api/v1/crm/gmail/callback',
        CRM_GMAIL_TOKEN_KEY: 'ab'.repeat(32),
        OAUTH_STATE_SECRET: 'state-secret',
      })
    })
    const state = (staffId: string) =>
      jwt.sign({ intent: 'crm-gmail', staffId, nonce: 'n' }, 'state-secret', { algorithm: 'HS256', expiresIn: 600 })

    it('🔴 sin sesión redirige a «Mi Gmail» con ?error=otra-sesion (no un 401 pelón)', async () => {
      const res = await request(app)
        .get('/crm/gmail/callback')
        .query({ code: 'c', state: state(STAFF) })
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe('https://superadmin.test/crm/gmail?error=otra-sesion')
    })

    it('🔴 con la sesión de OTRA persona también: la liga de Rafa no le conecta el Gmail de quien la abrió', async () => {
      const res = await request(app)
        .get('/crm/gmail/callback')
        .set('x-test-token', 'token-de-la-sesion')
        .query({ code: 'c', state: state('cstaffotro000000000000001') })
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe('https://superadmin.test/crm/gmail?error=otra-sesion')
    })

    it('un state que no es nuestro es ?error=state; si la persona dijo que no en Google, ?error=cancelado', async () => {
      const malo = await request(app).get('/crm/gmail/callback').query({ code: 'c', state: 'no-es-un-jwt' })
      expect(malo.headers.location).toBe('https://superadmin.test/crm/gmail?error=state')
      const cancelado = await request(app)
        .get('/crm/gmail/callback')
        .query({ error: 'access_denied', state: state(STAFF) })
      expect(cancelado.status).toBe(302)
      expect(cancelado.headers.location).toBe('https://superadmin.test/crm/gmail?error=cancelado')
    })
  })
})

describe('la prueba con destino (T3): rutas, esquemas y la lista de a quién mandarla', () => {
  const OTRO = 'cstaffotro0000000000000001'
  const CAMP = 'ccampana00000000000000001'
  const tpl = jest.spyOn(templatesService, 'sendTemplateTest')
  const camp = jest.spyOn(campaignsService, 'sendCampaignTest')
  const lista = jest.spyOn(teamService, 'listarDestinosDePrueba')

  beforeEach(() => {
    tpl.mockReset().mockResolvedValue({ ok: true, repetida: true, destino: { nombre: 'Ana' } })
    camp.mockReset().mockResolvedValue({ ok: true } as never)
    lista.mockReset().mockResolvedValue([{ staffId: STAFF, name: 'Rafa Pérez', tu: true }])
  })

  it('POST /campaigns/:id/test sin body sigue 200 y llama con {}', async () => {
    keys({ preparar: true })
    const res = await request(app).post(`/crm/campaigns/${CAMP}/test`)
    expect(res.status).toBe(200)
    expect(camp).toHaveBeenCalledWith(expect.objectContaining({ staffId: STAFF }), CAMP, {})
  })

  it('con destinoStaffId válido lo pasa; con uno que no es id, 400 «El id no es válido»', async () => {
    keys({ preparar: true })
    const ok = await request(app).post(`/crm/campaigns/${CAMP}/test`).send({ destinoStaffId: OTRO })
    expect(ok.status).toBe(200)
    expect(camp).toHaveBeenCalledWith(expect.anything(), CAMP, { destinoStaffId: OTRO })
    const mal = await request(app).post(`/crm/campaigns/${CAMP}/test`).send({ destinoStaffId: 'x' })
    expect(mal.status).toBe(400)
    expect(JSON.stringify(mal.body)).toContain('El id no es válido')
  })

  it('POST /templates/test pasa por sendTemplateTest y devuelve el eco tal cual', async () => {
    keys({ plantillas: true })
    const res = await request(app).post('/crm/templates/test').send({ subject: 'Hola', blocks: BODY.blocks, destinoStaffId: OTRO })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ ok: true, repetida: true, destino: { nombre: 'Ana' } })
    expect(tpl).toHaveBeenCalledWith(expect.anything(), { subject: 'Hola', blocks: BODY.blocks, destinoStaffId: OTRO })
  })

  it('el esquema de la plantilla exige subject y blocks y rechaza un destino que no es id', async () => {
    keys({ plantillas: true })
    expect((await request(app).post('/crm/templates/test').send({ subject: 'Hola' })).status).toBe(400)
    expect(
      (await request(app).post('/crm/templates/test').send({ subject: 'Hola', blocks: BODY.blocks, destinoStaffId: 'x' })).status,
    ).toBe(400)
  })

  it('GET /test-recipients con sólo «Preparar» es 200 y no trae correos; sin llave, 403', async () => {
    keys({ preparar: true })
    const res = await request(app).get('/crm/test-recipients')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([{ staffId: STAFF, name: 'Rafa Pérez', tu: true }])
    expect(JSON.stringify(res.body)).not.toMatch(/"email"|@/)
    soloContactar()
    expect((await request(app).get('/crm/test-recipients')).status).toBe(403)
  })
})
