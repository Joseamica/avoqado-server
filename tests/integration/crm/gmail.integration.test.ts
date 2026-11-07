/**
 * El Gmail del vendedor contra un Postgres real (fase 2, plan tarea 7): lo que sólo contesta la base.
 *
 *  - 🔴 El cruce: `mandarCorreo` reserva mientras `completarConexion` cambia la cuenta de A a B. El mensaje queda o con
 *    `fromEmail` A y marcado «cuenta reemplazada», o con `fromEmail` B. Nunca ENVIANDO/DESCONOCIDO con A sin que nadie lo
 *    revise (la reconciliación sólo busca en el buzón actual). Lo garantiza el `SELECT … FOR UPDATE` de la fila de la
 *    conexión, que toman los dos.
 *  - El tope de 100 cuentas: conectar la misma cuenta tres veces y otra una vez cuenta DOS (llave única + skipDuplicates).
 *  - Qué hilos lee el trabajo de respuestas: sólo los del buzón actual, sin fecha de corte (una respuesta a los 31 días
 *    entra), al ritmo de su edad, y una respuesta leída dos veces deja UN evento.
 *
 * 🔴 Aquí no sale nada a Google: `googleapis` está simulado de punta a punta.
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://<user>:<password>@localhost:5432/<disposable database>' \
 *     npx jest --selectProjects=integration --runTestsByPath tests/integration/crm/gmail.integration.test.ts --ci
 */
const mockGetToken = jest.fn()
const mockVerifyIdToken = jest.fn()
const mockSend = jest.fn()
const mockList = jest.fn()
const mockThreadsGet = jest.fn()
jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        getToken: (...a: unknown[]) => mockGetToken(...a),
        verifyIdToken: (...a: unknown[]) => mockVerifyIdToken(...a),
        setCredentials: jest.fn(),
      })),
    },
    gmail: jest.fn(() => ({
      users: {
        messages: { send: (...a: unknown[]) => mockSend(...a), list: (...a: unknown[]) => mockList(...a) },
        threads: { get: (...a: unknown[]) => mockThreadsGet(...a) },
      },
    })),
  },
}))

/** Una pausa que el cruce mete en la SEGUNDA revisión de bajas, la que corre bajo el candado de la conexión. */
let mockPausaBajoCandado: null | (() => Promise<void>) = null
jest.mock('@/services/crm/email/optOut.service', () => {
  const actual = jest.requireActual('@/services/crm/email/optOut.service')
  return {
    ...actual,
    isBlocked: async (email: string, db?: unknown) => {
      if (db && mockPausaBajoCandado) await mockPausaBajoCandado()
      return actual.isBlocked(email, db)
    },
  }
})

import jwt from 'jsonwebtoken'
import { createTokenCipher } from '@/lib/token-encryption'
import type { CrmAccess } from '@/services/crm/access.service'
import { completarConexion, estadoGmail } from '@/services/crm/email/gmailOAuth.service'
import { sincronizarRespuestas } from '@/services/crm/email/gmailReplies.service'
import { mandarCorreo } from '@/services/crm/email/gmailSend.service'
import prisma from '@/utils/prismaClient'

const suffix = `gml${Date.now()}`
const correo = (alias: string) => `${alias}-${suffix}@test.mx`
const gmailDe = (alias: string) => `${alias}-${suffix}@gmail.com`
const SEND = 'https://www.googleapis.com/auth/gmail.send'
const READ = 'https://www.googleapis.com/auth/gmail.readonly'
const MIN = 60_000
const DIA = 86_400_000

const ENV = { ...process.env }
const staffIds: string[] = []
const accountIds: string[] = []
const accessIds: string[] = []
const seenEmails: string[] = []
let stageId: string

const settle = <T>(p: Promise<T>) =>
  p.then(
    value => ({ value }),
    (error: unknown) => ({ error }),
  )
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => (resolve = r))
  return { promise, resolve }
}

const stateDe = (staffId: string) =>
  jwt.sign({ intent: 'crm-gmail', staffId, nonce: `n-${Math.random()}` }, process.env.OAUTH_STATE_SECRET!, {
    algorithm: 'HS256',
    expiresIn: 600,
  })

/** Google contesta con la cuenta `email` y los dos permisos. */
function googleConcede(email: string) {
  seenEmails.push(email)
  mockGetToken.mockResolvedValue({
    tokens: { access_token: 'at', refresh_token: `rt-${email}`, id_token: 'idt', scope: `openid ${SEND} ${READ}` },
  })
  mockVerifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: email, email, email_verified: true }) })
}

const seller = (staffId: string): CrmAccess => ({
  staffId,
  isSuperadmin: false,
  ver: 'todos',
  editar: 'todos',
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
})

/** Un vendedor con «Ver negocios» y «Mandar correo» de verdad (la vuelta de Google relee sus llaves) y su negocio. */
async function nuevoVendedor(alias: string) {
  const email = correo(alias)
  const staff = await prisma.staff.create({ data: { email, firstName: 'Rafa', lastName: alias, emailVerified: true } })
  staffIds.push(staff.id)
  const row = await prisma.platformAccess.create({
    data: { email, staffId: staff.id, verScope: 'todos', contactar: true, createdById: staff.id },
  })
  accessIds.push(row.id)
  const account = await prisma.crmAccount.create({
    data: {
      name: `Café ${suffix}`,
      source: 'MANUAL',
      stageId,
      contacts: { create: [{ name: 'Brenda', email: correo(`brenda-${alias}`) }] },
    },
    select: { id: true, contacts: { select: { id: true, email: true } } },
  })
  accountIds.push(account.id)
  return { staffId: staff.id, accountId: account.id, contact: account.contacts[0] }
}

async function conectarDirecto(staffId: string, googleEmail: string) {
  await prisma.crmGmailConnection.create({
    data: {
      staffId,
      googleEmail,
      refreshTokenCiphertext: new Uint8Array(createTokenCipher('CRM_GMAIL_TOKEN_KEY').encrypt('rt-inicial')),
      scopes: `${SEND} ${READ}`,
    },
  })
}

beforeAll(async () => {
  Object.assign(process.env, {
    CRM_GMAIL_CLIENT_ID: 'client-id',
    CRM_GMAIL_CLIENT_SECRET: 'client-secret',
    CRM_GMAIL_REDIRECT_URI: 'https://api.avoqado.test/api/v1/crm/gmail/callback',
    CRM_GMAIL_TOKEN_KEY: '0f'.repeat(32),
    OAUTH_STATE_SECRET: 'state-secret-integracion',
    SUPERADMIN_URL: 'https://superadmin.test',
  })
  stageId = (await prisma.crmStage.create({ data: { name: `Prospecto ${suffix}`, order: 1, kind: 'ABIERTA', staleDays: 3 } })).id
})

afterAll(async () => {
  process.env = ENV
  // Todo borrado por ids de este archivo: un `where` con un valor indefinido vaciaría la tabla.
  // Borrar la cuenta se lleva sus contactos, sus correos y su línea de tiempo.
  if (accountIds.length) await prisma.crmAccount.deleteMany({ where: { id: { in: accountIds } } })
  if (staffIds.length) await prisma.crmGmailConnection.deleteMany({ where: { staffId: { in: staffIds } } })
  if (seenEmails.length) await prisma.crmGmailAccountSeen.deleteMany({ where: { googleEmail: { in: seenEmails } } })
  if (accessIds.length) await prisma.platformAccess.deleteMany({ where: { id: { in: accessIds } } })
  if (stageId) await prisma.crmStage.deleteMany({ where: { id: stageId } })
  if (staffIds.length) await prisma.staff.deleteMany({ where: { id: { in: staffIds } } })
})

beforeEach(() => {
  for (const fn of [mockGetToken, mockVerifyIdToken, mockSend, mockList, mockThreadsGet]) fn.mockReset()
  mockPausaBajoCandado = null
})

describe('🔴 mandarCorreo reserva mientras completarConexion cambia de A a B', () => {
  it('el mensaje queda con A y «cuenta reemplazada», o con B; nunca pendiente con A sin que nadie lo revise', async () => {
    const { staffId, accountId, contact } = await nuevoVendedor('cruce')
    const A = gmailDe('a')
    const B = gmailDe('b')
    await conectarDirecto(staffId, A)
    seenEmails.push(A)
    process.env.CRM_CORREO_PRUEBAS = contact.email!
    // Google nunca contesta el envío: el caso incierto, el que la reconciliación tendría que revisar.
    mockSend.mockRejectedValue(Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ETIMEDOUT' }))

    const bajoCandado = deferred()
    const soltar = deferred()
    mockPausaBajoCandado = async () => {
      mockPausaBajoCandado = null
      bajoCandado.resolve()
      await soltar.promise
    }

    const clientRequestId = `cruce-${suffix}`
    const antesDeMandar = new Date()
    const envio = settle(
      mandarCorreo(seller(staffId), {
        accountId,
        contactId: contact.id,
        subject: 'Hola {{nombre}}',
        blocks: [{ type: 'paragraph', text: 'Te escribo' }],
        clientRequestId,
      }),
    )
    // El envío ya leyó la conexión (A) y está a punto de reservar.
    await bajoCandado.promise

    googleConcede(B)
    const conexion = completarConexion('code-b', stateDe(staffId), staffId)
    // Con el candado, la reconexión espera aquí al envío; sin él, termina antes de que el envío reserve.
    const temprano = await Promise.race([conexion.then(() => 'terminó'), sleep(1000).then(() => 'esperando')])
    soltar.resolve()

    const [resultadoEnvio, { redirect }] = await Promise.all([envio, conexion])
    expect(redirect).toBe('https://superadmin.test/crm/gmail?conectado=1')
    // C2 (0B): la respuesta dice a qué dirección fue ese intento.
    expect(resultadoEnvio).toEqual({ value: { status: 'DESCONOCIDO', para: contact.email } })

    const mensaje = await prisma.crmEmailMessage.findUniqueOrThrow({ where: { clientRequestId } })
    const conA = mensaje.fromEmail === A
    if (conA) {
      expect({ status: mensaje.status, error: mensaje.error }).toEqual({ status: 'DESCONOCIDO', error: 'cuenta reemplazada' })
      expect(temprano).toBe('esperando')
    } else {
      expect(mensaje.fromEmail).toBe(B)
    }
    // Y la conexión quedó en B, en otra versión.
    // Mandar es un toque: «Estancado» cuenta desde la reserva.
    const cuenta = await prisma.crmAccount.findUniqueOrThrow({ where: { id: accountId }, select: { lastTouchAt: true } })
    expect(cuenta.lastTouchAt.getTime()).toBeGreaterThanOrEqual(antesDeMandar.getTime())
    const fila = await prisma.crmGmailConnection.findUniqueOrThrow({ where: { staffId } })
    expect(fila).toMatchObject({ googleEmail: B, status: 'ACTIVA', version: 2 })
  })
})

describe('el tope de 100 cuentas de Google de la app', () => {
  it('estadoGmail cuenta 2 cuentas distintas aunque una se haya conectado 3 veces', async () => {
    const { staffId } = await nuevoVendedor('tope')
    const antes = (await estadoGmail(staffId)).cuentasUsadas
    const C = gmailDe('c')
    const D = gmailDe('d')

    for (const email of [C, C.toUpperCase(), C, D]) {
      googleConcede(email)
      await expect(completarConexion('code', stateDe(staffId), staffId)).resolves.toEqual({
        redirect: 'https://superadmin.test/crm/gmail?conectado=1',
      })
    }

    const estado = await estadoGmail(staffId)
    expect(estado.cuentasUsadas - antes).toBe(2)
    expect(estado).toMatchObject({ configurado: true, conectado: true, googleEmail: D, tope: 100 })
  })
})

describe('qué hilos lee el trabajo de respuestas', () => {
  it('sólo los del buzón actual, sin fecha de corte y al ritmo de su edad; una respuesta leída dos veces deja un evento', async () => {
    const { staffId, accountId, contact } = await nuevoVendedor('hilos')
    const A = gmailDe('viejo')
    const B = gmailDe('nuevo')
    await conectarDirecto(staffId, B)
    const ahora = new Date()
    const hilo = (id: string) => `${id}-${suffix}`
    const salida = (threadId: string, fromEmail: string, sentAt: Date, lastCheckedAt: Date | null) => ({
      accountId,
      contactId: contact.id,
      staffId,
      direction: 'SALIDA',
      fromEmail,
      toEmail: contact.email!,
      subject: 'Hola',
      status: 'ENVIADO',
      gmailMessageId: `gm-${threadId}`,
      gmailThreadId: threadId,
      sentAt,
      lastCheckedAt,
    })
    await prisma.crmEmailMessage.createMany({
      data: [
        // De la cuenta anterior: ya no se lee.
        salida(hilo('de-a'), A, new Date(ahora.getTime() - 2 * DIA), null),
        // Hace 31 días, revisado hace 25 h: le toca (sin fecha de corte).
        salida(hilo('31-dias'), B, new Date(ahora.getTime() - 31 * DIA), new Date(ahora.getTime() - 25 * 60 * MIN)),
        // Hace 40 días, nunca revisado: le toca, y primero.
        salida(hilo('nunca'), B, new Date(ahora.getTime() - 40 * DIA), null),
        // De ayer, revisado hace 2 min: todavía no.
        salida(hilo('reciente'), B, new Date(ahora.getTime() - DIA), new Date(ahora.getTime() - 2 * MIN)),
        // Hace 31 días, revisado hace 2 h: los viejos van cada 24 h.
        salida(hilo('viejo-revisado'), B, new Date(ahora.getTime() - 31 * DIA), new Date(ahora.getTime() - 120 * MIN)),
      ],
    })
    // Cada hilo trae el mensaje propio y una respuesta de Brenda.
    mockThreadsGet.mockImplementation(async ({ id }: { id: string }) => ({
      data: {
        id,
        messages: [
          { id: `gm-${id}`, labelIds: ['SENT'], payload: { headers: [{ name: 'From', value: B }] } },
          {
            id: `resp-${id}`,
            labelIds: ['INBOX'],
            snippet: 'Sí me interesa',
            // La respuesta del hilo «31 días» es VIEJA (de hace 40 días) y se lee DESPUÉS de la de «nunca», que es de ahora.
            internalDate: String(id === hilo('31-dias') ? ahora.getTime() - 40 * DIA : ahora.getTime()),
            payload: {
              headers: [
                { name: 'From', value: `Brenda <${contact.email}>` },
                { name: 'Subject', value: 'Re: Hola' },
              ],
            },
          },
        ],
      },
    }))

    // La cuenta llevaba 50 días sin tocar.
    await prisma.crmAccount.update({ where: { id: accountId }, data: { lastTouchAt: new Date(ahora.getTime() - 50 * DIA) } })

    await sincronizarRespuestas(ahora)

    // 🔴 Una respuesta es un toque, y nunca hacia atrás: la de ahora movió «Estancado» y la vieja, leída después, no lo regresó.
    const tocada = await prisma.crmAccount.findUniqueOrThrow({ where: { id: accountId }, select: { lastTouchAt: true } })
    expect(tocada.lastTouchAt.getTime()).toBe(ahora.getTime())

    const pedidos = mockThreadsGet.mock.calls.map(([args]) => args.id).filter((id: string) => id.endsWith(suffix))
    expect(pedidos).toEqual([hilo('nunca'), hilo('31-dias')])

    const recibidos = await prisma.crmEmailMessage.findMany({
      where: { accountId, direction: 'ENTRADA' },
      select: { gmailMessageId: true, status: true, fromEmail: true },
      orderBy: { gmailMessageId: 'asc' },
      take: 10,
    })
    expect(recibidos).toEqual([
      { gmailMessageId: `resp-${hilo('31-dias')}`, status: 'RECIBIDO', fromEmail: contact.email },
      { gmailMessageId: `resp-${hilo('nunca')}`, status: 'RECIBIDO', fromEmail: contact.email },
    ])

    // Recién revisados: una pasada inmediata no vuelve a pedir nada de este vendedor.
    mockThreadsGet.mockClear()
    await sincronizarRespuestas(new Date(ahora.getTime() + MIN))
    expect(mockThreadsGet.mock.calls.map(([args]) => args.id).filter((id: string) => id.endsWith(suffix))).toEqual([])

    // Un día después los mismos hilos vuelven a tocar, y la misma respuesta no se duplica.
    await sincronizarRespuestas(new Date(ahora.getTime() + DIA + MIN))
    expect(mockThreadsGet.mock.calls.map(([args]) => args.id)).toEqual(expect.arrayContaining([hilo('nunca'), hilo('31-dias')]))
    const claves = [hilo('nunca'), hilo('31-dias')].map(id => `gmail:resp-${id}`)
    expect(await prisma.crmTimelineEvent.count({ where: { accountId, kind: 'EMAIL_RECEIVED', sourceKey: { in: claves } } })).toBe(2)
    expect(
      await prisma.crmEmailMessage.count({ where: { gmailMessageId: { in: [hilo('nunca'), hilo('31-dias')].map(id => `resp-${id}`) } } }),
    ).toBe(2)
  })
})
