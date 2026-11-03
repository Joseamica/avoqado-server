/**
 * Las respuestas a la línea de tiempo (fase 2, plan tarea 7): el trabajo lee, hilo por hilo, los correos que mandó cada
 * vendedor desde su buzón ACTUAL y guarda lo que contestaron.
 *
 * Lo que fijan, más allá del camino feliz:
 *  - el token revocado de un vendedor (`invalid_grant`) no atora a los demás, y nunca apaga una conexión reconectada;
 *  - un hilo borrado (404) se retira y el siguiente hilo de la misma conexión se lee en la misma pasada;
 *  - una respuesta leída dos veces deja UN evento, y el mensaje propio del vendedor no cuenta como respuesta;
 *  - sólo se le pide a Google lo del buzón actual: tras pasar de A a B, los hilos de A ya no se leen.
 *
 * `googleapis` va simulado.
 */
const mockThreadsGet = jest.fn()
jest.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: jest.fn().mockImplementation(() => ({ setCredentials: jest.fn() })) },
    gmail: jest.fn(() => ({ users: { threads: { get: (...a: unknown[]) => mockThreadsGet(...a) } } })),
  },
}))

import { prismaMock } from '@tests/__helpers__/setup'
import { createTokenCipher } from '@/lib/token-encryption'
import { sincronizarRespuestas } from '@/services/crm/email/gmailReplies.service'

const STAFF = 'cstaffrafa000000000000001'
const OTRA = 'cstaffotro000000000000001'
const ACCOUNT = 'caccountbr0000000000000001'
const CONTACT = 'ccontactbr0000000000000001'
const KEY_HEX = 'ef'.repeat(32)
const NOW = new Date('2026-11-03T18:00:00.000Z')

const ENV = { ...process.env }
const cipher = () => createTokenCipher('CRM_GMAIL_TOKEN_KEY')

const conexion = (over: Record<string, unknown> = {}) => ({
  staffId: STAFF,
  googleEmail: 'rafa.ventas@gmail.com',
  refreshTokenCiphertext: cipher().encrypt('rt-actual'),
  version: 2,
  ...over,
})

const mensaje = (id: string, from: string, over: Record<string, unknown> = {}) => ({
  id,
  threadId: 'th-1',
  labelIds: ['INBOX'],
  snippet: `respuesta ${id}`,
  internalDate: String(NOW.getTime() - 60_000),
  payload: {
    headers: [
      { name: 'From', value: from },
      { name: 'To', value: 'Rafa <rafa.ventas@gmail.com>' },
      { name: 'Subject', value: 'Re: Hola Brenda' },
      { name: 'Message-ID', value: `<${id}@mail.cafe.mx>` },
    ],
  },
  ...over,
})

const propio = () => mensaje('gm-propio', '"Rafa Pérez" <Rafa.Ventas@gmail.com>', { labelIds: ['SENT'] })
const respuesta = (id = 'gm-r1') => mensaje(id, 'Brenda <Brenda@Cafe.mx>')

const http = (status: number) => Object.assign(new Error(`status ${status}`), { status, response: { status, data: {} } })
const invalidGrant = () => Object.assign(new Error('invalid_grant'), { response: { status: 400, data: { error: 'invalid_grant' } } })

beforeEach(() => {
  process.env.CRM_GMAIL_CLIENT_ID = 'client-id'
  process.env.CRM_GMAIL_CLIENT_SECRET = 'client-secret'
  process.env.CRM_GMAIL_REDIRECT_URI = 'https://api.avoqado.test/api/v1/crm/gmail/callback'
  process.env.CRM_GMAIL_TOKEN_KEY = KEY_HEX
  process.env.OAUTH_STATE_SECRET = 'state-secret'

  for (const fn of [
    mockThreadsGet,
    prismaMock.$queryRaw,
    prismaMock.crmGmailConnection.findMany,
    prismaMock.crmGmailConnection.updateMany,
    prismaMock.crmEmailMessage.findFirst,
    prismaMock.crmEmailMessage.createManyAndReturn,
    prismaMock.crmEmailMessage.updateMany,
    prismaMock.crmTimelineEvent.createMany,
    prismaMock.crmAccount.updateMany,
  ])
    fn.mockReset()
  prismaMock.crmAccount.updateMany.mockResolvedValue({ count: 1 })

  prismaMock.crmGmailConnection.findMany.mockResolvedValue([conexion()])
  prismaMock.crmGmailConnection.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.$queryRaw.mockResolvedValue([{ threadId: 'th-1' }])
  prismaMock.crmEmailMessage.findFirst.mockResolvedValue({ accountId: ACCOUNT, contactId: CONTACT })
  prismaMock.crmEmailMessage.createManyAndReturn.mockImplementation(async ({ data }: any) =>
    data.map((d: any, i: number) => ({
      id: `cmsgrecibido${i}000000000001`.slice(0, 25),
      gmailMessageId: d.gmailMessageId,
      sentAt: d.sentAt,
    })),
  )
  prismaMock.crmEmailMessage.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.crmTimelineEvent.createMany.mockResolvedValue({ count: 1 })
  mockThreadsGet.mockResolvedValue({ data: { id: 'th-1', messages: [propio(), respuesta()] } })
})

afterAll(() => {
  process.env = ENV
})

/** La consulta de hilos va como `Prisma.sql`: su texto con `?` en cada valor, y los valores ya aplanados. */
const consultaDe = (call: unknown[]) => {
  const q = call[0] as { strings: string[]; values: unknown[] }
  return { sql: q.strings.join('?'), valores: q.values }
}

describe('sincronizarRespuestas: lo que contestan', () => {
  it('guarda la respuesta como ENTRADA RECIBIDO con su evento (sólo ids) y el mensaje propio no cuenta', async () => {
    await sincronizarRespuestas(NOW)

    expect(mockThreadsGet).toHaveBeenCalledWith(
      { userId: 'me', id: 'th-1', format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Message-ID'] },
      { timeout: 30_000 },
    )
    const { data, skipDuplicates } = prismaMock.crmEmailMessage.createManyAndReturn.mock.calls[0][0]
    expect(skipDuplicates).toBe(true)
    expect(data).toEqual([
      {
        accountId: ACCOUNT,
        contactId: CONTACT,
        staffId: STAFF,
        direction: 'ENTRADA',
        fromEmail: 'brenda@cafe.mx',
        toEmail: 'rafa.ventas@gmail.com',
        gmailMessageId: 'gm-r1',
        gmailThreadId: 'th-1',
        subject: 'Re: Hola Brenda',
        snippet: 'respuesta gm-r1',
        status: 'RECIBIDO',
        sentAt: new Date(NOW.getTime() - 60_000),
      },
    ])
    const evento = prismaMock.crmTimelineEvent.createMany.mock.calls[0][0]
    expect(evento).toEqual({
      data: [
        {
          accountId: ACCOUNT,
          kind: 'EMAIL_RECEIVED',
          actorStaffId: null,
          data: { messageId: expect.any(String) },
          sourceKey: 'gmail:gm-r1',
        },
      ],
      skipDuplicates: true,
    })
    // El hilo queda revisado: pasa al final de la fila.
    expect(prismaMock.crmEmailMessage.updateMany).toHaveBeenCalledWith({
      where: { staffId: STAFF, direction: 'SALIDA', gmailThreadId: 'th-1' },
      data: { lastCheckedAt: NOW },
    })
  })

  it('🔴 una respuesta es un toque: «Estancado» cuenta desde la más nueva de las recién guardadas, nunca hacia atrás', async () => {
    const vieja = mensaje('gm-vieja', 'Brenda <brenda@cafe.mx>', { internalDate: String(NOW.getTime() - 40 * 86_400_000) })
    const nueva = mensaje('gm-nueva', 'Brenda <brenda@cafe.mx>', { internalDate: String(NOW.getTime() - 60_000) })
    mockThreadsGet.mockResolvedValue({ data: { id: 'th-1', messages: [propio(), vieja, nueva] } })

    await sincronizarRespuestas(NOW)

    const masNueva = new Date(NOW.getTime() - 60_000)
    // El mismo ayudante del módulo: sólo mueve `lastTouchAt` si el que tiene es ANTERIOR; una respuesta vieja que apenas se
    // leyó nunca le quita a la cuenta un toque más reciente.
    expect(prismaMock.crmAccount.updateMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.crmAccount.updateMany).toHaveBeenCalledWith({
      where: { id: ACCOUNT, lastTouchAt: { lt: masNueva } },
      data: { lastTouchAt: masNueva },
    })
  })

  it('una respuesta ya guardada no vuelve a tocar la cuenta', async () => {
    prismaMock.crmEmailMessage.createManyAndReturn.mockResolvedValue([])
    await sincronizarRespuestas(NOW)
    expect(prismaMock.crmAccount.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 una respuesta leída dos veces deja un solo EMAIL_RECEIVED', async () => {
    await sincronizarRespuestas(NOW)
    // La segunda vez la fila ya existe: `skipDuplicates` no devuelve nada nuevo y no se agrega otro evento.
    prismaMock.crmEmailMessage.createManyAndReturn.mockResolvedValue([])
    await sincronizarRespuestas(NOW)
    expect(prismaMock.crmTimelineEvent.createMany).toHaveBeenCalledTimes(1)
  })

  it('el mensaje propio del vendedor no se registra como recibido (también si lo mandó con otro nombre)', async () => {
    mockThreadsGet.mockResolvedValue({
      data: { id: 'th-1', messages: [propio(), mensaje('gm-borrador', 'otro@alias.mx', { labelIds: ['DRAFT'] })] },
    })
    await sincronizarRespuestas(NOW)
    expect(prismaMock.crmEmailMessage.createManyAndReturn).not.toHaveBeenCalled()
    expect(prismaMock.crmTimelineEvent.createMany).not.toHaveBeenCalled()
  })

  it('sólo guarda si el hilo sigue teniendo alguna SALIDA', async () => {
    prismaMock.crmEmailMessage.findFirst.mockResolvedValue(null)
    await sincronizarRespuestas(NOW)
    expect(prismaMock.crmEmailMessage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { staffId: STAFF, direction: 'SALIDA', gmailThreadId: 'th-1' } }),
    )
    expect(prismaMock.crmEmailMessage.createManyAndReturn).not.toHaveBeenCalled()
  })
})

describe('sincronizarRespuestas: qué hilos se leen', () => {
  it('🔴 tras pasar de A a B, sólo se le piden a Google los hilos de B', async () => {
    prismaMock.crmGmailConnection.findMany.mockResolvedValue([conexion({ googleEmail: 'b@gmail.com' })])
    await sincronizarRespuestas(NOW)
    const { sql, valores } = consultaDe(prismaMock.$queryRaw.mock.calls[0])
    expect(sql).toMatch(/"fromEmail" = \?/)
    expect(valores).toContain('b@gmail.com')
    expect(valores).toContain(STAFF)
    expect(valores).not.toContain('a@gmail.com')
  })

  it('sin fecha de corte: los recientes cada 5 min, los de más de 30 días cada 24 h, primero los nunca revisados; hasta 50', async () => {
    await sincronizarRespuestas(NOW)
    const { sql, valores } = consultaDe(prismaMock.$queryRaw.mock.calls[0])
    expect(sql).toMatch(/"status" = 'ENVIADO'/)
    expect(sql).toMatch(/"direction" = 'SALIDA'/)
    expect(sql).toMatch(/GROUP BY "gmailThreadId"/)
    expect(sql).toMatch(/LIMIT 50/)
    expect(sql).toMatch(/ORDER BY .*"revisado" ASC NULLS FIRST/s)
    // Las tres fronteras: hace 30 días, hace 5 min y hace 24 h — y ninguna fecha de corte sobre el envío más allá de eso.
    const fechas = valores.filter(v => v instanceof Date) as Date[]
    const fronteras = [...new Set(fechas.map(d => NOW.getTime() - d.getTime()))].sort((a, b) => a - b)
    expect(fronteras).toEqual([5 * 60_000, 24 * 3_600_000, 30 * 86_400_000])
  })
})

describe('sincronizarRespuestas: los errores son por hilo y por conexión', () => {
  it('🔴 un hilo que da 404 se retira y el siguiente hilo de la misma conexión se lee en la misma pasada', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ threadId: 'th-borrado' }, { threadId: 'th-1' }])
    mockThreadsGet.mockRejectedValueOnce(http(404)).mockResolvedValueOnce({ data: { id: 'th-1', messages: [respuesta()] } })

    await sincronizarRespuestas(NOW)

    expect(prismaMock.crmEmailMessage.updateMany).toHaveBeenCalledWith({
      where: { staffId: STAFF, direction: 'SALIDA', gmailThreadId: 'th-borrado' },
      data: { gmailThreadId: null, lastCheckedAt: NOW },
    })
    expect(mockThreadsGet).toHaveBeenCalledTimes(2)
    expect(prismaMock.crmEmailMessage.createManyAndReturn).toHaveBeenCalledTimes(1)
  })

  it('otro error de un hilo se registra, el hilo pasa al final de la fila y sigue con los demás', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ threadId: 'th-falla' }, { threadId: 'th-1' }])
    mockThreadsGet.mockRejectedValueOnce(http(500)).mockResolvedValueOnce({ data: { id: 'th-1', messages: [respuesta()] } })

    await sincronizarRespuestas(NOW)

    expect(prismaMock.crmEmailMessage.updateMany).toHaveBeenCalledWith({
      where: { staffId: STAFF, direction: 'SALIDA', gmailThreadId: 'th-falla' },
      data: { lastCheckedAt: NOW },
    })
    expect(prismaMock.crmEmailMessage.createManyAndReturn).toHaveBeenCalledTimes(1)
  })

  it('🔴 invalid_grant en una conexión la deja REVOCADA (con su versión) y no impide sincronizar la siguiente', async () => {
    prismaMock.crmGmailConnection.findMany.mockResolvedValue([
      conexion(),
      conexion({ staffId: OTRA, googleEmail: 'otra@gmail.com', version: 5 }),
    ])
    mockThreadsGet.mockRejectedValueOnce(invalidGrant()).mockResolvedValueOnce({ data: { id: 'th-1', messages: [respuesta()] } })

    await sincronizarRespuestas(NOW)

    expect(prismaMock.crmGmailConnection.updateMany).toHaveBeenCalledWith({
      where: { staffId: STAFF, version: 2, status: 'ACTIVA' },
      data: { status: 'REVOCADA', revokedAt: NOW, lastError: 'invalid_grant' },
    })
    expect(prismaMock.crmEmailMessage.createManyAndReturn).toHaveBeenCalledTimes(1)
    expect(prismaMock.crmEmailMessage.createManyAndReturn.mock.calls[0][0].data[0].staffId).toBe(OTRA)
  })

  it('🔴 un invalid_grant de las credenciales viejas tras reconectar no apaga la conexión nueva (CAS por versión)', async () => {
    mockThreadsGet.mockRejectedValue(invalidGrant())
    prismaMock.crmGmailConnection.updateMany.mockResolvedValue({ count: 0 })
    await sincronizarRespuestas(NOW)
    expect(prismaMock.crmGmailConnection.updateMany.mock.calls[0][0].where).toEqual({ staffId: STAFF, version: 2, status: 'ACTIVA' })
  })

  it('una conexión cuyo token no se puede leer se registra y no frena a la siguiente', async () => {
    prismaMock.crmGmailConnection.findMany.mockResolvedValue([
      conexion({ refreshTokenCiphertext: Buffer.from('basura') }),
      conexion({ staffId: OTRA, googleEmail: 'otra@gmail.com' }),
    ])
    mockThreadsGet.mockResolvedValue({ data: { id: 'th-1', messages: [respuesta()] } })
    await sincronizarRespuestas(NOW)
    expect(prismaMock.crmGmailConnection.updateMany).toHaveBeenCalledWith({
      where: { staffId: STAFF, version: 2 },
      data: { lastError: expect.any(String) },
    })
    expect(prismaMock.crmEmailMessage.createManyAndReturn).toHaveBeenCalledTimes(1)
  })

  it('sin la app configurada no hace nada', async () => {
    process.env.CRM_GMAIL_TOKEN_KEY = 'no-es-hex'
    await sincronizarRespuestas(NOW)
    expect(prismaMock.crmGmailConnection.findMany).not.toHaveBeenCalled()
  })
})
