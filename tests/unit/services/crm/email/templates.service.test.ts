/**
 * Las plantillas del equipo de ventas: lo que se guarda (y lo que se rechaza al guardar), la vista previa con datos de
 * ejemplo o con los de un negocio dentro del alcance, y «Envíame una prueba» — que fuera de producción sólo sale a la lista.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'
import type { CrmAccess } from '@/services/crm/access.service'
import {
  archiveTemplate,
  armarCorreo,
  contentHash,
  createTemplate,
  getTemplate,
  listTemplates,
  previewTemplate,
  sendTestToSelf,
  unarchiveTemplate,
  updateTemplate,
} from '@/services/crm/email/templates.service'
import emailService from '@/services/email.service'

jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendEmailWithResult: jest.fn() } }))

const send = emailService.sendEmailWithResult as jest.Mock

const STAFF = 'cstaffrafa000000000000001'
const TEMPLATE = 'ctemplate0000000000000001'
const ACCOUNT = 'caccounttp0000000000000001'
const CONTACT = 'ccontacttp0000000000000001'

const actor = (over: Partial<CrmAccess> = {}): CrmAccess => ({
  staffId: STAFF,
  isSuperadmin: false,
  ver: null,
  editar: null,
  contactar: false,
  campanas: true,
  exportar: false,
  ventas: false,
  admin: false,
  ...over,
})

const row = (over: Record<string, unknown> = {}) => ({
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

const ENV = { ...process.env }
const setList = (lista?: string) => {
  if (lista === undefined) delete process.env.CRM_CORREO_PRUEBAS
  else process.env.CRM_CORREO_PRUEBAS = lista
}

beforeEach(() => {
  for (const fn of [
    prismaMock.crmEmailTemplate.create,
    prismaMock.crmEmailTemplate.findMany,
    prismaMock.crmEmailTemplate.findUnique,
    prismaMock.crmEmailTemplate.count,
    prismaMock.crmEmailTemplate.update,
    prismaMock.crmEmailTemplate.updateMany,
    prismaMock.crmAccount.findFirst,
    prismaMock.staff.findUnique,
    send,
  ])
    fn.mockReset()
  prismaMock.staff.findUnique.mockResolvedValue({ email: 'Rafa@Avoqado.io', firstName: 'Rafa', lastName: 'Pérez' })
  send.mockResolvedValue({ ok: true, resendId: 'resend-1', transient: false })
  setList(undefined)
})

afterEach(() => {
  setList(ENV.CRM_CORREO_PRUEBAS)
  process.env.NODE_ENV = ENV.NODE_ENV
})

describe('guardar: la lista cerrada de variables', () => {
  it('{{precio}} en el cuerpo se rechaza con «Variable desconocida: {{precio}}» y no escribe nada', async () => {
    await expect(
      createTemplate(actor(), { name: 'x', subject: 'Hola', blocks: [{ type: 'paragraph', text: 'Cuesta {{precio}}' }] }),
    ).rejects.toMatchObject({ statusCode: 400, message: 'Variable desconocida: {{precio}}' })
    expect(prismaMock.crmEmailTemplate.create).not.toHaveBeenCalled()
  })

  it('también en el asunto, en la etiqueta de un botón y en el alt de una imagen; varias, en plural', async () => {
    const bloques = [
      { type: 'button' as const, label: 'Ver {{oferta}}', url: 'https://avoqado.io' },
      { type: 'image' as const, url: 'https://avoqado.io/a.png', alt: '{{foto}}' },
    ]
    await expect(createTemplate(actor(), { name: 'x', subject: '{{asunto}}', blocks: bloques })).rejects.toMatchObject({
      message: 'Variables desconocidas: {{asunto}}, {{oferta}}, {{foto}}',
    })
  })

  it('las tres conocidas pasan, y un {{x}} dentro de una url no es una variable (la url no se sustituye)', async () => {
    prismaMock.crmEmailTemplate.create.mockResolvedValue(row())
    await createTemplate(actor(), {
      name: 'x',
      subject: '{{negocio}}',
      blocks: [
        { type: 'paragraph', text: '{{nombre}} {{vendedor}}' },
        { type: 'button', label: 'Ir', url: 'https://avoqado.io/?q={{x}}' },
      ],
    })
    expect(prismaMock.crmEmailTemplate.create).toHaveBeenCalledTimes(1)
  })

  it('crea con quien la escribió como creador y editor, y deja rastro', async () => {
    prismaMock.crmEmailTemplate.create.mockResolvedValue(row())
    await createTemplate(actor(), { name: 'Novedades', subject: 'Hola', blocks: [{ type: 'divider' }] })

    expect(prismaMock.crmEmailTemplate.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ createdById: STAFF, updatedById: STAFF, name: 'Novedades' }) }),
    )
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: STAFF, venueId: null, action: 'CRM_EMAIL_TEMPLATE_CREATED', entityId: TEMPLATE }),
    )
  })
})

describe('editar, archivar y leer', () => {
  it('cambiar sólo el nombre no vuelve a revisar variables viejas, y el editor queda anotado', async () => {
    prismaMock.crmEmailTemplate.findUnique.mockResolvedValue(row())
    prismaMock.crmEmailTemplate.update.mockResolvedValue(row({ name: 'Otro' }))

    await updateTemplate(actor({ staffId: 'cstaffotro00000000000001' }), TEMPLATE, { name: 'Otro' })

    expect(prismaMock.crmEmailTemplate.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TEMPLATE }, data: { name: 'Otro', updatedById: 'cstaffotro00000000000001' } }),
    )
  })

  it('un asunto nuevo se revisa contra los bloques que ya tiene', async () => {
    prismaMock.crmEmailTemplate.findUnique.mockResolvedValue(row())
    await expect(updateTemplate(actor(), TEMPLATE, { subject: 'Hola {{apellido}}' })).rejects.toMatchObject({
      message: 'Variable desconocida: {{apellido}}',
    })
    expect(prismaMock.crmEmailTemplate.update).not.toHaveBeenCalled()
  })

  it('una plantilla que no existe es 404, y una archivada no se edita (409)', async () => {
    prismaMock.crmEmailTemplate.findUnique.mockResolvedValueOnce(null)
    await expect(updateTemplate(actor(), TEMPLATE, { name: 'x' })).rejects.toMatchObject({ statusCode: 404 })

    prismaMock.crmEmailTemplate.findUnique.mockResolvedValueOnce(row({ archivedAt: new Date() }))
    await expect(updateTemplate(actor(), TEMPLATE, { name: 'x' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CRM_PLANTILLA_ARCHIVADA',
    })
  })

  it('archivar es idempotente: la segunda vez no cambia nada ni deja otro rastro', async () => {
    prismaMock.crmEmailTemplate.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    prismaMock.crmEmailTemplate.findUnique.mockResolvedValue(row({ archivedAt: new Date() }))

    await archiveTemplate(actor(), TEMPLATE)
    await archiveTemplate(actor(), TEMPLATE)

    expect(prismaMock.crmEmailTemplate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TEMPLATE, archivedAt: null } }),
    )
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CRM_EMAIL_TEMPLATE_ARCHIVED' }))
  })

  it('desarchivar sólo toca las archivadas', async () => {
    prismaMock.crmEmailTemplate.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.crmEmailTemplate.findUnique.mockResolvedValue(row())

    await unarchiveTemplate(actor(), TEMPLATE)

    expect(prismaMock.crmEmailTemplate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TEMPLATE, archivedAt: { not: null } }, data: expect.objectContaining({ archivedAt: null }) }),
    )
  })

  it('archivar algo que no existe es 404', async () => {
    prismaMock.crmEmailTemplate.updateMany.mockResolvedValue({ count: 0 })
    prismaMock.crmEmailTemplate.findUnique.mockResolvedValue(null)
    await expect(archiveTemplate(actor(), TEMPLATE)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('getTemplate: 404 si no existe', async () => {
    prismaMock.crmEmailTemplate.findUnique.mockResolvedValue(null)
    await expect(getTemplate(TEMPLATE)).rejects.toMatchObject({ statusCode: 404, code: 'CRM_PLANTILLA_NOT_FOUND' })
  })
})

describe('listTemplates: acotada y con el total', () => {
  it('un límite desmedido se recorta a 100 (pide 101 para saber si hay otra página) y las vivas son las que se listan', async () => {
    prismaMock.crmEmailTemplate.findMany.mockResolvedValue([])
    prismaMock.crmEmailTemplate.count.mockResolvedValue(0)

    await listTemplates({ limit: 100000 })

    const args = prismaMock.crmEmailTemplate.findMany.mock.calls[0][0]
    expect(args.take).toBe(101)
    expect(args.where).toEqual({ archivedAt: null })
    expect(args.orderBy).toEqual([{ updatedAt: 'desc' }, { id: 'desc' }])
  })

  it('el default son 50, la página siguiente parte del cursor y el total sale aparte del conteo de filas', async () => {
    const filas = Array.from({ length: 51 }, (_, i) => row({ id: `ctemplate${String(i).padStart(16, '0')}` }))
    prismaMock.crmEmailTemplate.findMany.mockResolvedValue(filas)
    prismaMock.crmEmailTemplate.count.mockResolvedValue(130)

    const r = await listTemplates({ cursor: 'ctemplatecursor00000000001' })

    expect(prismaMock.crmEmailTemplate.findMany.mock.calls[0][0]).toMatchObject({
      take: 51,
      cursor: { id: 'ctemplatecursor00000000001' },
      skip: 1,
    })
    expect(r.rows).toHaveLength(50)
    expect(r.nextCursor).toBe(filas[49].id)
    expect(r.total).toBe(130)
  })

  it('archivadas: true lista sólo las archivadas', async () => {
    prismaMock.crmEmailTemplate.findMany.mockResolvedValue([])
    prismaMock.crmEmailTemplate.count.mockResolvedValue(0)
    await listTemplates({ archivadas: true })
    expect(prismaMock.crmEmailTemplate.findMany.mock.calls[0][0].where).toEqual({ archivedAt: { not: null } })
  })
})

describe('previewTemplate', () => {
  const bloques = [
    { type: 'heading' as const, text: 'Hola {{nombre}}' },
    { type: 'paragraph' as const, text: 'Te escribe {{vendedor}} sobre {{negocio}}.' },
  ]

  it('con datos de ejemplo: Ana, Cafetería La Esquina y el nombre de quien lo pide; sin pie', async () => {
    const r = await previewTemplate({ subject: 'Para {{negocio}}', blocks: bloques }, actor())

    expect(r.subject).toBe('Para Cafetería La Esquina')
    expect(r.html).toContain('Hola Ana')
    expect(r.html).toContain('Te escribe Rafa Pérez sobre Cafetería La Esquina.')
    expect(r.text).toContain('Hola Ana')
    expect(r.html).not.toContain('Dejar de recibir')
    expect(r.text).not.toContain('Dejar de recibir')
    expect(prismaMock.crmAccount.findFirst).not.toHaveBeenCalled()
  })

  it('con contexto: los datos reales de ese negocio y de ese contacto, buscados DENTRO del alcance de quien pide', async () => {
    prismaMock.crmAccount.findFirst.mockResolvedValue({ name: 'Taquería Lalo', contacts: [{ name: 'Lalo Gómez' }] })

    const r = await previewTemplate(
      { subject: 'x', blocks: bloques, contexto: { accountId: ACCOUNT, contactId: CONTACT } },
      actor({ ver: 'propios', contactar: true }),
    )

    expect(r.html).toContain('Hola Lalo Gómez')
    expect(r.html).toContain('sobre Taquería Lalo.')
    const args = prismaMock.crmAccount.findFirst.mock.calls[0][0]
    expect(args.where).toEqual({ AND: [{ id: ACCOUNT }, { OR: [{ ownerStaffId: STAFF }, { ownerStaffId: null }] }] })
    expect(args.select.contacts.where).toEqual({ id: CONTACT })
    expect(args.select.contacts.take).toBe(1)
  })

  it('sin contacto elegido y sin contactos, «nombre» cae en el negocio', async () => {
    prismaMock.crmAccount.findFirst.mockResolvedValue({ name: 'Taquería Lalo', contacts: [] })
    const r = await previewTemplate({ subject: 'x', blocks: bloques, contexto: { accountId: ACCOUNT } }, actor({ ver: 'todos' }))
    expect(r.html).toContain('Hola Taquería Lalo')
  })

  it('una cuenta fuera del alcance es 404, igual que si no existiera', async () => {
    prismaMock.crmAccount.findFirst.mockResolvedValue(null)
    await expect(
      previewTemplate({ subject: 'x', blocks: bloques, contexto: { accountId: ACCOUNT } }, actor({ ver: 'propios' })),
    ).rejects.toMatchObject({ statusCode: 404, code: 'CRM_CUENTA_NOT_FOUND' })
  })

  it('quien no tiene «Ver negocios» (sólo «Campañas masivas») nunca encuentra una cuenta: la consulta no puede coincidir', async () => {
    prismaMock.crmAccount.findFirst.mockResolvedValue(null)
    await expect(
      previewTemplate({ subject: 'x', blocks: bloques, contexto: { accountId: ACCOUNT } }, actor({ ver: null })),
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(prismaMock.crmAccount.findFirst.mock.calls[0][0].where).toEqual({ AND: [{ id: ACCOUNT }, { id: { in: [] } }] })
  })

  it('un contacto que no es de esa cuenta es 404', async () => {
    prismaMock.crmAccount.findFirst.mockResolvedValue({ name: 'Taquería Lalo', contacts: [] })
    await expect(
      previewTemplate({ subject: 'x', blocks: bloques, contexto: { accountId: ACCOUNT, contactId: CONTACT } }, actor({ ver: 'todos' })),
    ).rejects.toMatchObject({ statusCode: 404, code: 'CRM_CONTACTO_NOT_FOUND' })
  })

  it('🔴 lo que viene de la base sale ESCAPADO: un nombre con HTML no inyecta nada', async () => {
    prismaMock.crmAccount.findFirst.mockResolvedValue({
      name: '<script>alert(1)</script>"onerror="x',
      contacts: [{ name: '<b>Ana</b>' }],
    })

    const r = await previewTemplate(
      {
        subject: 'x',
        blocks: [
          { type: 'paragraph', text: 'Hola {{nombre}} de {{negocio}}' },
          { type: 'image', url: 'https://avoqado.io/a.png', alt: '{{negocio}}' },
          { type: 'button', label: '{{nombre}}', url: 'https://avoqado.io/{{nombre}}' },
        ],
        contexto: { accountId: ACCOUNT },
      },
      actor({ ver: 'todos' }),
    )

    expect(r.html).not.toContain('<script>')
    expect(r.html).not.toContain('<b>')
    expect(r.html).not.toContain('"onerror="x')
    expect(r.html).toContain('&lt;b&gt;Ana&lt;/b&gt;')
    expect(r.html).toContain('&lt;script&gt;')
    // La url no se sustituye: el {{nombre}} queda como estaba.
    expect(r.html).toContain('href="https://avoqado.io/{{nombre}}"')
  })

  it('una variable que no existe sale tal cual en la vista previa (se rechaza al guardar, no aquí)', async () => {
    const r = await previewTemplate({ subject: 'x', blocks: [{ type: 'paragraph', text: '{{precio}}' }] }, actor())
    expect(r.html).toContain('{{precio}}')
  })
})

describe('armarCorreo y contentHash', () => {
  it('es el mismo armado con y sin pie: el pie sólo se agrega al final', () => {
    const sin = armarCorreo('s', [{ type: 'paragraph', text: 'hola' }], {})
    const con = armarCorreo('s', [{ type: 'paragraph', text: 'hola' }], {}, { html: '<i>pie</i>', text: '\npie' })
    expect(con.html).toContain('hola')
    expect(con.html).toContain('<i>pie</i>')
    expect(sin.html).not.toContain('pie')
    expect(con.text).toBe('hola\npie')
  })

  it('contentHash cambia con el asunto y con los bloques, y no con nada más', () => {
    const b = [{ type: 'paragraph' as const, text: 'a' }]
    expect(contentHash('s', b)).toBe(contentHash('s', [{ type: 'paragraph', text: 'a' }]))
    expect(contentHash('s', b)).not.toBe(contentHash('t', b))
    expect(contentHash('s', b)).not.toBe(contentHash('s', [{ type: 'paragraph', text: 'b' }]))
    expect(contentHash('s', b)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('sendTestToSelf', () => {
  const input = {
    subject: 'Novedades para {{negocio}}',
    blocks: [{ type: 'paragraph' as const, text: 'Hola {{nombre}}, soy {{vendedor}}' }],
  }

  it('🔴 en NODE_ENV=test sin CRM_CORREO_PRUEBAS contesta «fuera de la lista de prueba» y NO llama a Resend', async () => {
    expect(process.env.NODE_ENV).toBe('test')

    await expect(sendTestToSelf(actor(), input)).resolves.toEqual({ ok: false, motivo: 'fuera de la lista de prueba' })
    expect(send).not.toHaveBeenCalled()
  })

  it('con una lista que no lo incluye, tampoco sale', async () => {
    setList('otra@avoqado.io')
    await expect(sendTestToSelf(actor(), input)).resolves.toEqual({ ok: false, motivo: 'fuera de la lista de prueba' })
    expect(send).not.toHaveBeenCalled()
  })

  it('en la lista: va al Staff.email de quien lo pide (en minúsculas), por el remitente de campañas, con pie de PROSPECTO y cabeceras de baja', async () => {
    setList('rafa@avoqado.io')

    await expect(sendTestToSelf(actor(), input)).resolves.toEqual({ ok: true })

    expect(prismaMock.staff.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: STAFF } }))
    expect(send).toHaveBeenCalledTimes(1)
    const email = send.mock.calls[0][0]
    expect(email.to).toBe('rafa@avoqado.io')
    expect(email.from).toBe('Avoqado <novedades@novedades.avoqado.io>')
    expect(email.replyTo).toBe('hola@avoqado.io')
    expect(email.subject).toBe('Novedades para Cafetería La Esquina')
    expect(email.html).toContain('Hola Ana, soy Rafa Pérez')
    expect(email.html).toContain('Te llega porque pediste recibir novedades de Avoqado.')
    expect(email.text).toContain('Servicios Tecnológicos Avo S.A. de C.V. · Ciudad de México, México · hola@avoqado.io')
    expect(email.headers['List-Unsubscribe']).toMatch(/^<https?:\/\/.+>$/)
    expect(email.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    expect(email.html).toContain('Dejar de recibir estos correos')
  })

  it('la llave de idempotencia es crm-prueba:<staffId>:<huella>: lo mismo es UNA prueba, otro contenido es otra', async () => {
    setList('rafa@avoqado.io')
    await sendTestToSelf(actor(), input)
    await sendTestToSelf(actor(), input)
    await sendTestToSelf(actor(), { ...input, subject: 'Otro asunto' })

    const [a, b, c] = send.mock.calls.map(([email]) => email.idempotencyKey as string)
    expect(a).toMatch(new RegExp(`^crm-prueba:${STAFF}:[0-9a-f]{64}$`))
    expect(b).toBe(a)
    expect(c).not.toBe(a)
  })

  it('si Resend la rechaza, vuelve {ok:false} con un motivo para la persona, sin lanzar', async () => {
    setList('rafa@avoqado.io')
    send.mockResolvedValue({ ok: false, transient: true, errorCode: 'EMAIL_SERVICE_UNAVAILABLE' })
    await expect(sendTestToSelf(actor(), input)).resolves.toEqual({
      ok: false,
      motivo: 'No se pudo mandar la prueba. Intenta de nuevo en un momento',
    })

    send.mockRejectedValue(new Error('boom'))
    await expect(sendTestToSelf(actor(), input)).resolves.toMatchObject({ ok: false })
  })

  it('quien ya no tiene correo no recibe nada', async () => {
    setList('rafa@avoqado.io')
    prismaMock.staff.findUnique.mockResolvedValue(null)
    await expect(sendTestToSelf(actor(), input)).resolves.toEqual({ ok: false, motivo: 'No encontramos tu correo' })
    expect(send).not.toHaveBeenCalled()
  })
})
