/**
 * Mandar uno a uno desde el Gmail del vendedor (fase 2, plan tarea 7), y reconciliar lo que no sabemos si salió.
 *
 * Lo que fijan, más allá del camino feliz:
 *  - el doble clic (mismo `clientRequestId`) manda UN solo correo;
 *  - una dirección dada de baja — también si la baja llega mientras el vendedor escribía — da 422 y no llama a Gmail;
 *  - la reserva va bajo el candado de la conexión, toma de ESA lectura la cuenta y el token, y deja el evento de la ficha
 *    ANTES de mandar: un envío incierto se ve («no sabemos si salió») y nadie lo repite a ciegas;
 *  - lo incierto NUNCA se reenvía ni se certifica como «no salió»: se busca por su Message-ID en Enviados;
 *  - un `invalid_grant` de las credenciales viejas no apaga una conexión que ya se reconectó (`version`).
 *
 * `googleapis` va simulado: aquí no sale ningún correo.
 */
const mockSend = jest.fn()
const mockList = jest.fn()
const mockSetCredentials = jest.fn()
jest.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: jest.fn().mockImplementation(() => ({ setCredentials: (...a: unknown[]) => mockSetCredentials(...a) })) },
    gmail: jest.fn(() => ({
      users: {
        messages: { send: (...a: unknown[]) => mockSend(...a), list: (...a: unknown[]) => mockList(...a) },
      },
    })),
  },
}))

import { prismaMock } from '@tests/__helpers__/setup'
import { createTokenCipher } from '@/lib/token-encryption'
import logger from '@/config/logger'
import type { CrmAccess } from '@/services/crm/access.service'
import { mandarCorreo, reconciliarDesconocidos } from '@/services/crm/email/gmailSend.service'
import * as templates from '@/services/crm/email/templates.service'

const STAFF = 'cstaffrafa000000000000001'
const ACCOUNT = 'caccountbr0000000000000001'
const CONTACT = 'ccontactbr0000000000000001'
const MSG = 'cmessage00000000000000001'
const KEY_HEX = 'cd'.repeat(32)
const NOW = new Date('2026-11-03T18:00:00.000Z')
const MIN = 60_000

const actor = (over: Partial<CrmAccess> = {}): CrmAccess => ({
  staffId: STAFF,
  isSuperadmin: false,
  ver: 'propios',
  editar: null,
  contactar: true,
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

const input = (over: Record<string, unknown> = {}) => ({
  accountId: ACCOUNT,
  contactId: CONTACT,
  subject: 'Hola {{nombre}}',
  blocks: [{ type: 'paragraph' as const, text: 'Soy {{vendedor}}, te escribo por {{negocio}}.' }],
  clientRequestId: 'clic-123e4567-e89b-12d3',
  ...over,
})

const ENV = { ...process.env }
const cipher = () => createTokenCipher('CRM_GMAIL_TOKEN_KEY')

/** La fila de la conexión como la devuelve el `SELECT … FOR UPDATE`. */
const filaBloqueada = (over: Record<string, unknown> = {}) => ({
  googleEmail: 'rafa.ventas@gmail.com',
  refreshTokenCiphertext: cipher().encrypt('rt-actual'),
  status: 'ACTIVA',
  version: 2,
  ...over,
})

const httpError = (status: number, data: unknown = { error: { message: 'Invalid To header' } }) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { status, response: { status, data } })
const invalidGrant = () =>
  Object.assign(new Error('invalid_grant'), {
    response: { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } },
  })

const sqlDe = (call: unknown[]) => (call[0] as string[]).join('?')
const orden = (fn: jest.Mock, i = 0) => fn.mock.invocationCallOrder[i]

beforeEach(() => {
  process.env.CRM_GMAIL_CLIENT_ID = 'client-id'
  process.env.CRM_GMAIL_CLIENT_SECRET = 'client-secret'
  process.env.CRM_GMAIL_REDIRECT_URI = 'https://api.avoqado.test/api/v1/crm/gmail/callback'
  process.env.CRM_GMAIL_TOKEN_KEY = KEY_HEX
  process.env.OAUTH_STATE_SECRET = 'state-secret'
  process.env.CRM_CORREO_PRUEBAS = 'brenda@cafe.mx'

  for (const fn of [
    mockSend,
    mockList,
    mockSetCredentials,
    prismaMock.$queryRaw,
    prismaMock.crmEmailMessage.findUnique,
    prismaMock.crmEmailMessage.findMany,
    prismaMock.crmEmailMessage.create,
    prismaMock.crmEmailMessage.update,
    prismaMock.crmEmailMessage.updateMany,
    prismaMock.crmAccount.findFirst,
    prismaMock.crmAccount.updateMany,
    prismaMock.crmGmailConnection.findUnique,
    prismaMock.crmGmailConnection.findMany,
    prismaMock.crmGmailConnection.updateMany,
    prismaMock.crmEmailOptOut.findUnique,
    prismaMock.emailSuppression.findUnique,
    prismaMock.crmTimelineEvent.createMany,
    prismaMock.staff.findUnique,
  ])
    fn.mockReset()

  prismaMock.crmEmailMessage.findUnique.mockResolvedValue(null)
  prismaMock.crmAccount.findFirst.mockResolvedValue({
    name: 'Café Brenda',
    contacts: [{ id: CONTACT, name: 'Brenda', email: 'Brenda@Cafe.MX' }],
  })
  prismaMock.crmGmailConnection.findUnique.mockResolvedValue({ status: 'ACTIVA' })
  prismaMock.crmEmailOptOut.findUnique.mockResolvedValue(null)
  prismaMock.emailSuppression.findUnique.mockResolvedValue(null)
  prismaMock.staff.findUnique.mockResolvedValue({ firstName: 'Rafa', lastName: 'Pérez' })
  prismaMock.$queryRaw.mockResolvedValue([filaBloqueada()])
  prismaMock.crmEmailMessage.create.mockResolvedValue({ id: MSG })
  prismaMock.crmEmailMessage.update.mockResolvedValue({})
  prismaMock.crmEmailMessage.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.crmTimelineEvent.createMany.mockResolvedValue({ count: 1 })
  prismaMock.crmGmailConnection.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.crmAccount.updateMany.mockResolvedValue({ count: 1 })
  mockSend.mockResolvedValue({ data: { id: 'gm-1', threadId: 'th-1' } })
})

afterAll(() => {
  process.env = ENV
})

function mimeEnviado(): string {
  const { requestBody } = mockSend.mock.calls[0][0]
  return Buffer.from(requestBody.raw, 'base64url').toString('utf8')
}

describe('mandarCorreo: el camino feliz', () => {
  it('reserva bajo el candado, deja el evento de la ficha ANTES de mandar, manda desde el Gmail y lo deja ENVIADO', async () => {
    await expect(mandarCorreo(actor(), input())).resolves.toEqual({ status: 'ENVIADO', para: 'brenda@cafe.mx' })

    // 1. El candado de la conexión, y de ESA lectura salen la cuenta y el token.
    expect(sqlDe(prismaMock.$queryRaw.mock.calls[0])).toMatch(/FROM "CrmGmailConnection" WHERE "staffId" = \?.*FOR UPDATE/s)
    expect(prismaMock.$queryRaw.mock.calls[0][1]).toBe(STAFF)
    expect(mockSetCredentials).toHaveBeenCalledWith({ refresh_token: 'rt-actual' })

    // 2. La reserva: SALIDA ENVIANDO con su clic, y su Message-ID propio.
    expect(prismaMock.crmEmailMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountId: ACCOUNT,
        contactId: CONTACT,
        staffId: STAFF,
        direction: 'SALIDA',
        fromEmail: 'rafa.ventas@gmail.com',
        toEmail: 'brenda@cafe.mx',
        clientRequestId: 'clic-123e4567-e89b-12d3',
        subject: 'Hola Brenda',
        status: 'ENVIANDO',
        snippet: expect.stringContaining('Soy Rafa Pérez'),
      }),
      select: { id: true },
    })
    expect(prismaMock.crmEmailMessage.update).toHaveBeenCalledWith({
      where: { id: MSG },
      data: { rfcMessageId: `<crm.${MSG}@avoqado.io>` },
    })

    // 3. El evento existe desde la reserva, sólo con ids, y antes de tocar Gmail.
    expect(prismaMock.crmTimelineEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          accountId: ACCOUNT,
          kind: 'EMAIL_SENT',
          actorStaffId: STAFF,
          data: { messageId: MSG, contactId: CONTACT },
          sourceKey: `email:${MSG}`,
        },
      ],
      skipDuplicates: true,
    })
    expect(orden(prismaMock.crmTimelineEvent.createMany)).toBeLessThan(orden(mockSend))

    // 🔴 Mandar es un toque: «Estancado» cuenta desde aquí, con el ayudante que nunca lo mueve hacia atrás, en la reserva.
    expect(prismaMock.crmAccount.updateMany).toHaveBeenCalledWith({
      where: { id: ACCOUNT, lastTouchAt: { lt: expect.any(Date) } },
      data: { lastTouchAt: expect.any(Date) },
    })
    const toque = prismaMock.crmAccount.updateMany.mock.calls[0][0]
    expect(toque.where.lastTouchAt.lt).toBe(toque.data.lastTouchAt)
    expect(orden(prismaMock.crmAccount.updateMany)).toBeLessThan(orden(mockSend))

    // 4. El MIME: del vendedor, a la persona, con nuestro Message-ID y SIN el pie de las campañas.
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockSend.mock.calls[0][0].userId).toBe('me')
    const mime = mimeEnviado()
    expect(mime).toMatch(/^From: =\?UTF-8\?Q\?Rafa_P=C3=A9rez\?= <rafa\.ventas@gmail\.com>$/m)
    expect(mime).toMatch(/^To: Brenda <brenda@cafe\.mx>$/m)
    expect(mime).toMatch(new RegExp(`^Message-ID: <crm\\.${MSG}@avoqado\\.io>$`, 'm'))
    expect(mime).toMatch(/^Subject: Hola Brenda$/m)
    expect(mime).not.toContain('Dejar de recibir')
    expect(mime).not.toContain('Servicios Tecnol')

    // 5. Guardado: ENVIADO con los ids de Gmail (también si mientras tanto alguien lo marcó DESCONOCIDO).
    expect(prismaMock.crmEmailMessage.updateMany).toHaveBeenCalledWith({
      where: { id: MSG, status: { in: ['ENVIANDO', 'DESCONOCIDO'] } },
      data: { status: 'ENVIADO', gmailMessageId: 'gm-1', gmailThreadId: 'th-1', sentAt: expect.any(Date), error: null },
    })
  })
})

describe('mandarCorreo: la misma lectura que la vista previa', () => {
  it('lee la cuenta y el contacto con la MISMA función que la vista previa con datos reales', async () => {
    const lectura = jest.spyOn(templates, 'cuentaYContactoEnAlcance')
    await mandarCorreo(actor(), input())
    expect(lectura).toHaveBeenCalledWith(actor(), ACCOUNT, CONTACT)
    lectura.mockRestore()
  })
})

describe('mandarCorreo: un solo correo por clic', () => {
  it('🔴 el mismo clientRequestId dos veces manda una sola vez', async () => {
    await mandarCorreo(actor(), input())
    // El segundo clic encuentra la fila del primero.
    prismaMock.crmEmailMessage.findUnique.mockResolvedValue({ status: 'ENVIADO', staffId: STAFF, accountId: ACCOUNT, error: null })
    await expect(mandarCorreo(actor(), input())).resolves.toEqual({ status: 'ENVIADO' })

    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(prismaMock.crmEmailMessage.create).toHaveBeenCalledTimes(1)
  })

  it('dos clics a la vez: el segundo espera el candado, ve la fila del primero y no manda', async () => {
    // Afuera todavía no existe; adentro del candado, sí.
    prismaMock.crmEmailMessage.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: 'ENVIANDO', staffId: STAFF, accountId: ACCOUNT, error: null })
    await expect(mandarCorreo(actor(), input())).resolves.toEqual({ status: 'DESCONOCIDO' })
    expect(prismaMock.crmEmailMessage.create).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('el clientRequestId de otra persona o de otra cuenta no devuelve nada ajeno', async () => {
    prismaMock.crmEmailMessage.findUnique.mockResolvedValue({
      status: 'ENVIADO',
      staffId: 'cstaffotro000000000000001',
      accountId: ACCOUNT,
      error: null,
    })
    await expect(mandarCorreo(actor(), input())).rejects.toMatchObject({ statusCode: 409 })
    expect(mockSend).not.toHaveBeenCalled()
  })
})

describe('mandarCorreo: a quién no se le escribe', () => {
  it('🔴 una dirección dada de baja da 422 «No se manda: BAJA» y no llama a Gmail', async () => {
    prismaMock.crmEmailOptOut.findUnique.mockResolvedValue({ id: 'optout-1' })
    await expect(mandarCorreo(actor(), input())).rejects.toMatchObject({ statusCode: 422, message: 'No se manda: BAJA' })
    expect(prismaMock.crmEmailOptOut.findUnique).toHaveBeenCalledWith({ where: { email: 'brenda@cafe.mx' }, select: { id: true } })
    expect(prismaMock.crmEmailMessage.create).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('🔴 una baja que llega mientras el vendedor escribía también frena (se revisa otra vez bajo el candado)', async () => {
    prismaMock.crmEmailOptOut.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'optout-1' })
    await expect(mandarCorreo(actor(), input())).rejects.toMatchObject({ statusCode: 422, message: 'No se manda: BAJA' })
    expect(prismaMock.$queryRaw).toHaveBeenCalled()
    expect(prismaMock.crmEmailMessage.create).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('un rebote o una queja también frenan', async () => {
    prismaMock.emailSuppression.findUnique.mockResolvedValue({ reason: 'COMPLAINT' })
    await expect(mandarCorreo(actor(), input())).rejects.toMatchObject({ statusCode: 422, message: 'No se manda: QUEJA' })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('🔴 fuera de producción, a alguien fuera de la lista de prueba: 422 y no llama a Gmail', async () => {
    process.env.CRM_CORREO_PRUEBAS = ''
    await expect(mandarCorreo(actor(), input())).rejects.toMatchObject({
      statusCode: 422,
      message: 'No se manda: fuera de la lista de prueba',
    })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('la cuenta fuera del alcance es un 404 (igual que si no existiera), y el filtro es el de «Ver»', async () => {
    prismaMock.crmAccount.findFirst.mockResolvedValue(null)
    await expect(mandarCorreo(actor(), input())).rejects.toMatchObject({ statusCode: 404 })
    expect(prismaMock.crmAccount.findFirst.mock.calls[0][0].where).toEqual({
      AND: [{ id: ACCOUNT }, { OR: [{ ownerStaffId: STAFF }, { ownerStaffId: null }] }],
    })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('un contacto sin correo es un 422', async () => {
    prismaMock.crmAccount.findFirst.mockResolvedValue({ name: 'Café', contacts: [{ id: CONTACT, name: 'Brenda', email: null }] })
    await expect(mandarCorreo(actor(), input())).rejects.toMatchObject({ statusCode: 422, message: 'Ese contacto no tiene correo' })
  })

  it('sin Gmail conectado, o revocado, es un 409 que dice qué hacer', async () => {
    prismaMock.crmGmailConnection.findUnique.mockResolvedValue(null)
    await expect(mandarCorreo(actor(), input())).rejects.toMatchObject({ statusCode: 409, code: 'CRM_GMAIL_NO_CONECTADO' })
    prismaMock.crmGmailConnection.findUnique.mockResolvedValue({ status: 'REVOCADA' })
    await expect(mandarCorreo(actor(), input())).rejects.toMatchObject({ statusCode: 409, message: 'Reconecta tu Gmail' })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('una variable fuera de la lista cerrada se rechaza antes de reservar', async () => {
    await expect(mandarCorreo(actor(), input({ subject: 'Hola {{precio}}' }))).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.crmEmailMessage.create).not.toHaveBeenCalled()
  })
})

describe('mandarCorreo: cuando Gmail no contesta o falla', () => {
  it('🔴 si no se puede preparar el envío (token ilegible), queda FALLIDO «No se pudo preparar el envío» y Gmail no se llama', async () => {
    prismaMock.$queryRaw.mockResolvedValue([filaBloqueada({ refreshTokenCiphertext: Buffer.from('basura') })])
    await expect(mandarCorreo(actor(), input())).rejects.toMatchObject({ statusCode: 503, code: 'CRM_GMAIL_NO_PREPARADO' })
    expect(mockSend).not.toHaveBeenCalled()
    expect(prismaMock.crmEmailMessage.updateMany).toHaveBeenCalledWith({
      where: { id: MSG, status: 'ENVIANDO' },
      data: { status: 'FALLIDO', error: 'No se pudo preparar el envío' },
    })
    // Sabemos que no salió: nunca «no sabemos si salió».
    const estados = prismaMock.crmEmailMessage.updateMany.mock.calls.map((c: any[]) => c[0].data.status)
    expect(estados).not.toContain('DESCONOCIDO')
  })

  it('🔴 un timeout deja DESCONOCIDO (nunca reintenta solo) y el evento de la ficha ya existía', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ETIMEDOUT' }))
    await expect(mandarCorreo(actor(), input())).resolves.toEqual({ status: 'DESCONOCIDO', para: 'brenda@cafe.mx' })
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(prismaMock.crmTimelineEvent.createMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.crmEmailMessage.updateMany).toHaveBeenCalledWith({
      where: { id: MSG, status: 'ENVIANDO' },
      data: { status: 'DESCONOCIDO', error: 'Gmail no contestó' },
    })
  })

  it('un 5xx también es DESCONOCIDO: Google pudo haberlo mandado', async () => {
    mockSend.mockRejectedValue(httpError(503, { error: { message: 'Backend Error' } }))
    await expect(mandarCorreo(actor(), input())).resolves.toEqual({ status: 'DESCONOCIDO', para: 'brenda@cafe.mx' })
  })

  it('si Google contesta y el guardado falla, la respuesta es DESCONOCIDO (la fila queda para reconciliar)', async () => {
    prismaMock.crmEmailMessage.updateMany.mockRejectedValue(new Error('P1001: no se pudo llegar a la base'))
    await expect(mandarCorreo(actor(), input())).resolves.toEqual({ status: 'DESCONOCIDO', para: 'brenda@cafe.mx' })
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it('un 4xx de validación de Google es FALLIDO (no salió) y un 422 en español; el texto de Google va sólo al log', async () => {
    mockSend.mockRejectedValue(httpError(400))
    const error = await mandarCorreo(actor(), input()).catch((e: { statusCode: number; message: string }) => e)
    expect(error).toMatchObject({
      statusCode: 422,
      message: 'Gmail no aceptó el correo, así que no salió. Revisa la dirección del contacto o intenta más tarde',
    })
    expect(prismaMock.crmEmailMessage.updateMany).toHaveBeenCalledWith({
      where: { id: MSG, status: 'ENVIANDO' },
      data: { status: 'FALLIDO', error: 'Gmail no lo aceptó (400)' },
    })
    // Lo que ve la persona (la respuesta y la ficha) no trae el inglés de Google; el log sí, para diagnosticar.
    expect(JSON.stringify(error)).not.toContain('Invalid To header')
    expect(JSON.stringify(prismaMock.crmEmailMessage.updateMany.mock.calls)).not.toContain('Invalid To header')
    expect(logger.warn).toHaveBeenCalledWith(
      '[CRM] Gmail rejected the send',
      expect.objectContaining({ status: 400, google: 'Invalid To header' }),
    )
  })

  it('🔴 invalid_grant: FALLIDO, la conexión REVOCADA sólo si sigue en la versión que se usó, y un 409 «Reconecta tu Gmail»', async () => {
    mockSend.mockRejectedValue(invalidGrant())
    await expect(mandarCorreo(actor(), input())).rejects.toMatchObject({ statusCode: 409, message: 'Reconecta tu Gmail' })
    expect(prismaMock.crmGmailConnection.updateMany).toHaveBeenCalledWith({
      where: { staffId: STAFF, version: 2, status: 'ACTIVA' },
      data: { status: 'REVOCADA', revokedAt: expect.any(Date), lastError: 'invalid_grant' },
    })
    expect(prismaMock.crmEmailMessage.updateMany).toHaveBeenCalledWith({
      where: { id: MSG, status: 'ENVIANDO' },
      data: { status: 'FALLIDO', error: 'Reconecta tu Gmail' },
    })
  })

  it('🔴 un invalid_grant de las credenciales viejas que llega después de reconectar no apaga la conexión nueva', async () => {
    // Se reservó con la versión 2; mientras Google contestaba, el vendedor reconectó (versión 3): el CAS no encuentra nada.
    mockSend.mockRejectedValue(invalidGrant())
    prismaMock.crmGmailConnection.updateMany.mockResolvedValue({ count: 0 })
    await expect(mandarCorreo(actor(), input())).rejects.toMatchObject({ statusCode: 409 })
    const where = prismaMock.crmGmailConnection.updateMany.mock.calls[0][0].where
    // Y sólo si sigue ACTIVA: tras «Desconectar» (que no sube la versión) no se escribe una revocación falsa.
    expect(where).toEqual({ staffId: STAFF, version: 2, status: 'ACTIVA' })
  })
})

describe('reconciliarDesconocidos: lo que no sabemos si salió', () => {
  const conexion = (over: Record<string, unknown> = {}) => ({
    staffId: STAFF,
    googleEmail: 'rafa.ventas@gmail.com',
    refreshTokenCiphertext: cipher().encrypt('rt-actual'),
    version: 2,
    ...over,
  })
  const pendiente = (over: Record<string, unknown> = {}) => ({
    id: MSG,
    rfcMessageId: `<crm.${MSG}@avoqado.io>`,
    status: 'ENVIANDO',
    createdAt: new Date(NOW.getTime() - 15 * MIN),
    ...over,
  })

  beforeEach(() => {
    prismaMock.crmGmailConnection.findMany.mockResolvedValue([conexion()])
    prismaMock.crmEmailMessage.findMany.mockResolvedValue([pendiente()])
  })

  it('🔴 una fila ENVIANDO de hace 15 min, sin gmailMessageId, se encuentra por su Message-ID en Enviados y queda ENVIADO', async () => {
    mockList.mockResolvedValue({ data: { messages: [{ id: 'gm-9', threadId: 'th-9' }] } })
    await reconciliarDesconocidos(NOW)

    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ userId: 'me', q: `in:sent rfc822msgid:crm.${MSG}@avoqado.io` }), {
      timeout: 30_000,
    })
    expect(prismaMock.crmEmailMessage.updateMany).toHaveBeenCalledWith({
      where: { id: MSG, status: { in: ['ENVIANDO', 'DESCONOCIDO'] } },
      data: { status: 'ENVIADO', gmailMessageId: 'gm-9', gmailThreadId: 'th-9', sentAt: pendiente().createdAt, error: null },
    })
    // Su evento ya existía: no se agrega otro. Y nunca se reenvía.
    expect(prismaMock.crmTimelineEvent.createMany).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('busca sólo los ENVIANDO de más de 10 min y los DESCONOCIDO que siguen abiertos, del buzón actual', async () => {
    mockList.mockResolvedValue({ data: {} })
    await reconciliarDesconocidos(NOW)
    const { where } = prismaMock.crmEmailMessage.findMany.mock.calls[0][0]
    expect(where).toEqual({
      staffId: STAFF,
      direction: 'SALIDA',
      fromEmail: 'rafa.ventas@gmail.com',
      rfcMessageId: { not: null },
      OR: [
        { status: 'ENVIANDO', createdAt: { lt: new Date(NOW.getTime() - 10 * MIN) } },
        { status: 'DESCONOCIDO', OR: [{ error: null }, { error: { notIn: ['cuenta reemplazada', 'no se encontró en Enviados'] } }] },
      ],
    })
  })

  it('🔴 un pendiente de la cuenta anterior (A) no se busca con las credenciales de la nueva (B)', async () => {
    prismaMock.crmGmailConnection.findMany.mockResolvedValue([conexion({ googleEmail: 'b@gmail.com' })])
    prismaMock.crmEmailMessage.findMany.mockResolvedValue([])
    await reconciliarDesconocidos(NOW)
    expect(prismaMock.crmEmailMessage.findMany.mock.calls[0][0].where.fromEmail).toBe('b@gmail.com')
    expect(mockList).not.toHaveBeenCalled()
  })

  it('si no se encuentra antes de 24 h queda DESCONOCIDO (se sigue buscando) y NUNCA FALLIDO', async () => {
    mockList.mockResolvedValue({ data: { resultSizeEstimate: 0 } })
    await reconciliarDesconocidos(NOW)
    expect(prismaMock.crmEmailMessage.updateMany).toHaveBeenCalledWith({
      where: { id: MSG, status: 'ENVIANDO' },
      data: { status: 'DESCONOCIDO', error: 'Gmail no contestó' },
    })
    const estados = prismaMock.crmEmailMessage.updateMany.mock.calls.map((c: any[]) => c[0].data.status)
    expect(estados).not.toContain('FALLIDO')
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('a las 24 h sin encontrarlo queda DESCONOCIDO para siempre («revisa tus Enviados») y ya no se busca', async () => {
    prismaMock.crmEmailMessage.findMany.mockResolvedValue([
      pendiente({ status: 'DESCONOCIDO', createdAt: new Date(NOW.getTime() - 25 * 60 * MIN) }),
    ])
    mockList.mockResolvedValue({ data: {} })
    await reconciliarDesconocidos(NOW)
    expect(prismaMock.crmEmailMessage.updateMany).toHaveBeenCalledWith({
      where: { id: MSG, status: { in: ['ENVIANDO', 'DESCONOCIDO'] } },
      data: { status: 'DESCONOCIDO', error: 'no se encontró en Enviados' },
    })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('un timeout de envío seguido de la reconciliación que lo encuentra termina ENVIADO', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
    await expect(mandarCorreo(actor(), input())).resolves.toEqual({ status: 'DESCONOCIDO', para: 'brenda@cafe.mx' })

    prismaMock.crmEmailMessage.findMany.mockResolvedValue([
      pendiente({ status: 'DESCONOCIDO', error: 'Gmail no contestó', createdAt: new Date(NOW.getTime() - 3 * MIN) }),
    ])
    mockList.mockResolvedValue({ data: { messages: [{ id: 'gm-1', threadId: 'th-1' }] } })
    await reconciliarDesconocidos(NOW)
    expect(prismaMock.crmEmailMessage.updateMany).toHaveBeenLastCalledWith({
      where: { id: MSG, status: { in: ['ENVIANDO', 'DESCONOCIDO'] } },
      data: expect.objectContaining({ status: 'ENVIADO', gmailMessageId: 'gm-1' }),
    })
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it('un invalid_grant en una conexión la deja REVOCADA (con su versión) y no frena a la siguiente', async () => {
    const OTRA = 'cstaffotro000000000000001'
    prismaMock.crmGmailConnection.findMany.mockResolvedValue([
      conexion(),
      conexion({ staffId: OTRA, googleEmail: 'otra@gmail.com', version: 7 }),
    ])
    mockList.mockRejectedValueOnce(invalidGrant()).mockResolvedValueOnce({ data: { messages: [{ id: 'gm-2', threadId: 'th-2' }] } })
    await reconciliarDesconocidos(NOW)
    expect(prismaMock.crmGmailConnection.updateMany).toHaveBeenCalledWith({
      where: { staffId: STAFF, version: 2, status: 'ACTIVA' },
      data: { status: 'REVOCADA', revokedAt: NOW, lastError: 'invalid_grant' },
    })
    expect(mockList).toHaveBeenCalledTimes(2)
    expect(prismaMock.crmEmailMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ENVIADO', gmailMessageId: 'gm-2' }) }),
    )
  })

  it('🔴 un pendiente cuya búsqueda falla siempre no tapa a los demás, y a las 24 h igual se cierra', async () => {
    const OTRO_MSG = 'cmessage00000000000000002'
    prismaMock.crmEmailMessage.findMany.mockResolvedValue([
      pendiente({ status: 'DESCONOCIDO', createdAt: new Date(NOW.getTime() - 25 * 60 * MIN) }),
      pendiente({ id: OTRO_MSG, rfcMessageId: `<crm.${OTRO_MSG}@avoqado.io>` }),
    ])
    mockList.mockRejectedValueOnce(httpError(500, {})).mockResolvedValueOnce({ data: { messages: [{ id: 'gm-3', threadId: 'th-3' }] } })

    await reconciliarDesconocidos(NOW)

    expect(mockList).toHaveBeenCalledTimes(2)
    expect(prismaMock.crmEmailMessage.updateMany).toHaveBeenCalledWith({
      where: { id: MSG, status: { in: ['ENVIANDO', 'DESCONOCIDO'] } },
      data: { status: 'DESCONOCIDO', error: 'no se encontró en Enviados' },
    })
    expect(prismaMock.crmEmailMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: OTRO_MSG, status: { in: ['ENVIANDO', 'DESCONOCIDO'] } },
        data: expect.objectContaining({ status: 'ENVIADO' }),
      }),
    )
    // Un pendiente roto no es un error de la conexión.
    expect(prismaMock.crmGmailConnection.updateMany).not.toHaveBeenCalled()
  })

  it('un error al guardar un pendiente tampoco frena al siguiente', async () => {
    const OTRO_MSG = 'cmessage00000000000000002'
    prismaMock.crmEmailMessage.findMany.mockResolvedValue([
      pendiente(),
      pendiente({ id: OTRO_MSG, rfcMessageId: `<crm.${OTRO_MSG}@avoqado.io>` }),
    ])
    mockList.mockResolvedValue({ data: { messages: [{ id: 'gm-4', threadId: 'th-4' }] } })
    prismaMock.crmEmailMessage.updateMany.mockRejectedValueOnce(new Error('P2034')).mockResolvedValueOnce({ count: 1 })
    await reconciliarDesconocidos(NOW)
    expect(prismaMock.crmEmailMessage.updateMany).toHaveBeenCalledTimes(2)
    expect(prismaMock.crmEmailMessage.updateMany.mock.calls[1][0].where.id).toBe(OTRO_MSG)
    expect(prismaMock.crmGmailConnection.updateMany).not.toHaveBeenCalled()
  })

  it('sin la app configurada no hace nada', async () => {
    delete process.env.CRM_GMAIL_CLIENT_ID
    await reconciliarDesconocidos(NOW)
    expect(prismaMock.crmGmailConnection.findMany).not.toHaveBeenCalled()
  })
})

describe('C2 Bloque 0B: «Mandar correo» compara la dirección que se vio (Codex plan r1 H4, r2 H2, r3 H4)', () => {
  const previo = (over: Record<string, unknown> = {}) => ({
    status: 'ENVIADO',
    staffId: STAFF,
    accountId: ACCOUNT,
    error: null,
    toEmail: 'anterior@cafe.mx',
    ...over,
  })

  it('🔴 paraCorreo anterior@ y la persona ya tiene otra dirección, sin intento previo → 409 CRM_CORREO_CAMBIO con ahora; ni reserva, ni evento, ni Gmail', async () => {
    await expect(mandarCorreo(actor(), input({ paraCorreo: 'anterior@cafe.mx' }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'CRM_CORREO_CAMBIO',
      details: { ahora: 'brenda@cafe.mx' },
    })
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expect(prismaMock.crmEmailMessage.create).not.toHaveBeenCalled()
    expect(prismaMock.crmTimelineEvent.createMany).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('paraCorreo igual (con mayúsculas o espacios) → manda y contesta para', async () => {
    await expect(mandarCorreo(actor(), input({ paraCorreo: '  BRENDA@cafe.mx ' }))).resolves.toEqual({
      status: 'ENVIADO',
      para: 'brenda@cafe.mx',
    })
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it('🔴 Codex r2 H2: el intento X salió a anterior@, la persona ya tiene otra, y llega X con paraCorreo de la nueva → 409 CRM_INTENTO_A_OTRO_CORREO con para anterior@; nunca ENVIADO', async () => {
    prismaMock.crmEmailMessage.findUnique.mockResolvedValue(previo())
    await expect(mandarCorreo(actor(), input({ paraCorreo: 'brenda@cafe.mx' }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'CRM_INTENTO_A_OTRO_CORREO',
      details: { para: 'anterior@cafe.mx' },
    })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('🔴 el mismo X con paraCorreo anterior@ → ENVIADO con para anterior@, sin reservar otro', async () => {
    prismaMock.crmEmailMessage.findUnique.mockResolvedValue(previo())
    await expect(mandarCorreo(actor(), input({ paraCorreo: 'anterior@cafe.mx' }))).resolves.toEqual({
      status: 'ENVIADO',
      para: 'anterior@cafe.mx',
    })
    expect(prismaMock.crmEmailMessage.create).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('🔴 el mismo X dentro del candado (dos clics a la vez) también compara la dirección', async () => {
    prismaMock.crmEmailMessage.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(previo({ status: 'ENVIANDO' }))
    prismaMock.crmAccount.findFirst.mockResolvedValue({
      name: 'Café Brenda',
      contacts: [{ id: CONTACT, name: 'Brenda', email: 'nuevo@cafe.mx' }],
    })
    process.env.CRM_CORREO_PRUEBAS = 'nuevo@cafe.mx'
    await expect(mandarCorreo(actor(), input({ paraCorreo: 'nuevo@cafe.mx' }))).rejects.toMatchObject({
      code: 'CRM_INTENTO_A_OTRO_CORREO',
      details: { para: 'anterior@cafe.mx' },
    })
    expect(prismaMock.crmEmailMessage.create).not.toHaveBeenCalled()
  })

  it('🔴 Codex r3 H4: una llave que nunca llegó, reenviada sin paraCorreo, es un envío normal: pasa las bajas, la lista de prueba y crea su reserva', async () => {
    await expect(mandarCorreo(actor(), input())).resolves.toEqual({ status: 'ENVIADO', para: 'brenda@cafe.mx' })
    expect(prismaMock.crmEmailOptOut.findUnique).toHaveBeenCalled()
    expect(prismaMock.crmEmailMessage.create).toHaveBeenCalledTimes(1)
  })

  it('🔴 el mismo X sin paraCorreo (SUPERADMIN viejo) → su estado con para', async () => {
    prismaMock.crmEmailMessage.findUnique.mockResolvedValue(previo({ status: 'DESCONOCIDO' }))
    await expect(mandarCorreo(actor(), input())).resolves.toEqual({ status: 'DESCONOCIDO', para: 'anterior@cafe.mx' })
  })

  it('un intento FALLIDO dice a qué dirección iba', async () => {
    prismaMock.crmEmailMessage.findUnique.mockResolvedValue(previo({ status: 'FALLIDO', error: 'Gmail no lo aceptó (400)' }))
    await expect(mandarCorreo(actor(), input({ paraCorreo: 'anterior@cafe.mx' }))).rejects.toMatchObject({
      code: 'CRM_GMAIL_RECHAZADO',
      details: { para: 'anterior@cafe.mx' },
    })
  })
})
