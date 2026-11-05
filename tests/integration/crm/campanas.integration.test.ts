/**
 * Las campañas masivas del CRM contra un Postgres real (fase 2, plan tarea 5): lo que sólo contesta la base.
 *
 *  - La cola: dos remitentes a la vez nunca se llevan la misma delivery (lease + `FOR UPDATE SKIP LOCKED`); una delivery que
 *    se quedó a medias se vuelve a mandar con la MISMA llave dentro de la ventana de 23 h y, fuera de ella, queda
 *    DESCONOCIDO sin tocar Resend; el tope diario cuenta por `sendAttemptAt` (un rebote o una respuesta perdida no devuelven
 *    el lugar) y sólo frena los primeros intentos, nunca un reintento.
 *  - El encolado: todo en una transacción con la fila bloqueada. Una edición a la vez, dos envíos a la vez, un público que
 *    creció o una falla a la mitad nunca dejan salir algo que no se probó ni se confirmó, ni una campaña a medias.
 *
 * 🔴 Aquí no sale ningún correo: el servicio de correo está simulado de punta a punta.
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://<user>:<password>@localhost:5432/<disposable database>' \
 *     npx jest --selectProjects=integration --runTestsByPath tests/integration/crm/campanas.integration.test.ts --ci
 */
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendEmailWithResult: jest.fn() } }))
// El cupo de Resend lo decide el medidor del `fetch`, que aquí no corre (el correo está simulado): la pausa se fija a mano.
jest.mock('@/services/email/resendQuota', () => ({
  ...jest.requireActual('@/services/email/resendQuota'),
  campanasPausadasPorCupo: jest.fn(() => false),
}))

import { aparcarLaSiguienteTransaccion, aTiempo, esperarBloqueado } from '@tests/__helpers__/candadosDePostgres'
import { env } from '@/config/env'
import type { CrmAccess } from '@/services/crm/access.service'
import * as audience from '@/services/crm/email/audience.service'
import {
  cancelCampaign,
  createCampaign,
  enqueueCampaign,
  getCampaign,
  previewSend,
  sendCampaignTest,
  updateCampaign,
} from '@/services/crm/email/campaigns.service'
import { correrEnvioDeCampanas, reclamarLote } from '@/services/crm/email/campaignSender.service'
import { procesarAvisoCrm } from '@/services/crm/email/campaignWebhook.service'
import { contentHash } from '@/services/crm/email/templates.service'
import emailService from '@/services/email.service'
import { campanasPausadasPorCupo } from '@/services/email/resendQuota'
import prisma from '@/utils/prismaClient'

const send = emailService.sendEmailWithResult as jest.Mock
const pausa = campanasPausadasPorCupo as jest.Mock

const suffix = `cmp${Date.now()}`
const correo = (alias: string) => `${alias}-${suffix}@test.mx`
const HORA = 3_600_000

const campaignIds: string[] = []
const accountIds: string[] = []
const consentEmails: string[] = []
let stageId: string
let templateId: string
let rafa: CrmAccess

const ENV = { ...process.env }
const CAP = env.CRM_CAMPAIGN_DAILY_CAP

const settle = <T>(results: PromiseSettledResult<T>[]) => ({
  fulfilled: results.filter(r => r.status === 'fulfilled'),
  rejected: results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason),
})

beforeAll(async () => {
  const staff = await prisma.staff.create({ data: { email: correo('rafa'), firstName: 'Rafa', lastName: 'Campañas' } })
  rafa = {
    staffId: staff.id,
    isSuperadmin: false,
    ver: null,
    editar: null,
    contactar: false,
    campanas: true,
    exportar: false,
    ventas: false,
    admin: false,
    cerrar: false,
    bajas: false,
    plantillas: true,
    preparar: true,
    mandar: true,
    verCampanas: true,
    equipo: false,
    configurar: false,
  }
  stageId = (await prisma.crmStage.create({ data: { name: `Etapa ${suffix}`, order: 900, kind: 'ABIERTA' } })).id
  templateId = (
    await prisma.crmEmailTemplate.create({
      data: {
        name: `Novedades ${suffix}`,
        subject: 'Hola {{nombre}}',
        blocks: [{ type: 'paragraph', text: 'Te escribe {{vendedor}}' }],
        createdById: staff.id,
        updatedById: staff.id,
      },
    })
  ).id
  // Tres prospectos con consentimiento en la etapa de este archivo: el público de las campañas que se encolan aquí.
  for (const alias of ['ana', 'beto', 'caro']) await prospecto(alias)
})

afterAll(async () => {
  // Cada borrado va por ids de este archivo: un `where` con un valor indefinido vaciaría la tabla.
  if (campaignIds.length) await prisma.crmCampaign.deleteMany({ where: { id: { in: campaignIds } } })
  if (templateId) await prisma.crmEmailTemplate.deleteMany({ where: { id: templateId } })
  if (consentEmails.length) await prisma.crmEmailConsent.deleteMany({ where: { email: { in: consentEmails } } })
  if (accountIds.length) await prisma.crmAccount.deleteMany({ where: { id: { in: accountIds } } })
  if (stageId) await prisma.crmStage.deleteMany({ where: { id: stageId } })
  await prisma.crmEmailOptOut.deleteMany({ where: { email: { endsWith: `-${suffix}@test.mx` } } })
  if (rafa?.staffId) await prisma.staff.deleteMany({ where: { id: rafa.staffId } })
})

beforeEach(() => {
  pausa.mockReset().mockReturnValue(false)
  send.mockReset()
  send.mockResolvedValue({ ok: true, resendId: `re_${Date.now()}`, transient: false })
  env.MARKETING_KILL_SWITCH = undefined
  env.CRM_CAMPAIGN_DAILY_CAP = CAP
})

afterEach(async () => {
  jest.restoreAllMocks()
  if (ENV.CRM_CORREO_PRUEBAS === undefined) delete process.env.CRM_CORREO_PRUEBAS
  else process.env.CRM_CORREO_PRUEBAS = ENV.CRM_CORREO_PRUEBAS
  env.CRM_CAMPAIGN_DAILY_CAP = CAP
  // Cada prueba arranca con la cola vacía: el tope diario cuenta TODAS las deliveries intentadas hoy.
  if (campaignIds.length) await prisma.crmCampaign.deleteMany({ where: { id: { in: campaignIds } } })
  campaignIds.length = 0
})

async function prospecto(alias: string) {
  const { id } = await prisma.crmAccount.create({ data: { name: `Negocio ${alias} ${suffix}`, source: 'MANUAL', stageId } })
  accountIds.push(id)
  const email = correo(alias)
  await prisma.crmEmailConsent.create({
    data: { email, accountId: id, entryId: `entry-${alias}-${suffix}`, consentAt: new Date(), source: 'LANDING', noticeVersion: 'v1' },
  })
  consentEmails.push(email)
}

const AUDIENCIA = () => ({ segmentos: [{ tipo: 'PROSPECTOS' as const, etapas: [stageId] }] })

/** Una campaña ya ENVIANDO, escrita directo: para probar la cola sin pasar por el encolado. */
async function campanaEnviando() {
  const { id } = await prisma.crmCampaign.create({
    data: {
      name: `Cola ${suffix}`,
      subject: 'Hola {{nombre}}',
      blocks: [{ type: 'paragraph', text: 'Hola' }],
      audience: AUDIENCIA(),
      status: 'ENVIANDO',
      createdById: rafa.staffId,
      enqueuedAt: new Date(),
    },
  })
  campaignIds.push(id)
  return id
}

async function delivery(campaignId: string, alias: string, over: Record<string, unknown> = {}) {
  return prisma.crmCampaignDelivery.create({
    data: { campaignId, email: correo(alias), reason: 'PROSPECTO', vars: { nombre: alias }, ...over },
  })
}

const estado = async (id: string) => prisma.crmCampaignDelivery.findUniqueOrThrow({ where: { id } })

/** Un BORRADOR de la plantilla, con el público de este archivo. */
async function borrador() {
  const campaign = await createCampaign(rafa, { name: `Campaña ${suffix}`, templateId })
  campaignIds.push(campaign.id)
  await updateCampaign(rafa, campaign.id, { audience: AUDIENCIA() })
  return campaign.id
}

/** Un BORRADOR listo para mandar: con su prueba de esta versión y su vista previa. */
async function listaParaMandar() {
  const id = await borrador()
  process.env.CRM_CORREO_PRUEBAS = correo('rafa')
  await expect(sendCampaignTest(rafa, id)).resolves.toMatchObject({ ok: true })
  const vista = await previewSend(rafa, id)
  // Con 0 personas la vista previa no firma (plan B, tarea 4): aquí siempre hay tres prospectos.
  if (!vista.token) throw new Error('La vista previa no firmó: el público de este archivo quedó vacío')
  return { id, vista: { ...vista, token: vista.token } }
}

describe('la cola: lease, SKIP LOCKED y la ventana de 23 h', () => {
  it('dos reclamarLote a la vez sobre 120 deliveries devuelven 120 ids distintos en total', async () => {
    const campaignId = await campanaEnviando()
    await prisma.crmCampaignDelivery.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({ campaignId, email: correo(`d${i}`), reason: 'PROSPECTO', vars: {} })),
    })
    const ahora = new Date()

    const [a, b] = await Promise.all([reclamarLote(60, ahora), reclamarLote(60, ahora)])

    expect(a.length + b.length).toBe(120)
    expect(new Set([...a, ...b]).size).toBe(120)
    expect(await prisma.crmCampaignDelivery.count({ where: { campaignId, status: 'ENVIANDO', attempts: 1 } })).toBe(120)
  })

  it('🔴 mientras otro remitente tiene 60 filas bloqueadas, reclamarLote se lleva las OTRAS 60 sin esperarlo', async () => {
    const campaignId = await campanaEnviando()
    await prisma.crmCampaignDelivery.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({ campaignId, email: correo(`l${i}`), reason: 'PROSPECTO', vars: {} })),
    })
    // El «otro remitente»: bloquea las 60 primeras (el mismo orden que reclama la cola) y las retiene hasta que se le suelte.
    let soltar!: () => void
    const suelto = new Promise<void>(resolve => (soltar = resolve))
    let avisar!: (ids: string[]) => void
    const bloqueadas = new Promise<string[]>(resolve => (avisar = resolve))
    const otro = prisma.$transaction(
      async tx => {
        const filas = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "CrmCampaignDelivery" WHERE "campaignId" = ${campaignId} ORDER BY "createdAt", "id" LIMIT 60 FOR UPDATE`
        avisar(filas.map(f => f.id))
        await suelto
      },
      { timeout: 30_000 },
    )
    const deOtro = await bloqueadas

    try {
      // Si el reclamo esperara al candado del otro (o lo ignorara), no contestaría mientras el otro siga ahí.
      const mias = await Promise.race([
        reclamarLote(60, new Date()),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('reclamarLote esperó al otro remitente')), 10_000)),
      ])
      expect(deOtro).toHaveLength(60)
      expect(mias).toHaveLength(60)
      expect(mias.filter(id => deOtro.includes(id))).toEqual([])
    } finally {
      soltar()
      await otro
    }
  })

  it('una ENVIANDO con el lease vencido y el primer intento hace 2 h se vuelve a mandar con la MISMA llave', async () => {
    const campaignId = await campanaEnviando()
    const primerIntento = new Date(Date.now() - 2 * HORA)
    const d = await delivery(campaignId, 'lease', {
      status: 'ENVIANDO',
      attempts: 1,
      leaseUntil: new Date(Date.now() - 60_000),
      sendAttemptAt: primerIntento,
    })
    process.env.CRM_CORREO_PRUEBAS = correo('lease')

    await correrEnvioDeCampanas({ ahora: new Date(), pausaMs: 0 })

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toMatchObject({ idempotencyKey: d.id, to: correo('lease') })
    const fila = await estado(d.id)
    expect(fila).toMatchObject({ status: 'ENVIADO', attempts: 2 })
    expect(fila.sendAttemptAt).toEqual(primerIntento)
  })

  it.each(['ENVIANDO', 'REINTENTO'])('una %s con el primer intento hace 25 h queda DESCONOCIDO sin llamar a Resend', async status => {
    const campaignId = await campanaEnviando()
    const d = await delivery(campaignId, `vieja-${status}`, {
      status,
      attempts: 2,
      leaseUntil: status === 'ENVIANDO' ? new Date(Date.now() - 60_000) : null,
      nextAttemptAt: status === 'REINTENTO' ? new Date(Date.now() - 60_000) : null,
      sendAttemptAt: new Date(Date.now() - 25 * HORA),
    })
    process.env.CRM_CORREO_PRUEBAS = correo(`vieja-${status}`)

    await correrEnvioDeCampanas({ ahora: new Date(), pausaMs: 0 })
    // Y ya nadie la vuelve a tomar.
    await correrEnvioDeCampanas({ ahora: new Date(Date.now() + 10 * 60_000), pausaMs: 0 })

    expect(send).not.toHaveBeenCalled()
    expect(await estado(d.id)).toMatchObject({ status: 'DESCONOCIDO', attempts: 2, leaseUntil: null })
  })
})

describe('el tope diario', () => {
  it('con el tope alcanzado, el trabajo no reclama ninguna PENDIENTE', async () => {
    env.CRM_CAMPAIGN_DAILY_CAP = 2
    const campaignId = await campanaEnviando()
    for (const alias of ['hoy1', 'hoy2']) await delivery(campaignId, alias, { status: 'ENVIADO', attempts: 1, sendAttemptAt: new Date() })
    const pendiente = await delivery(campaignId, 'espera')
    process.env.CRM_CORREO_PRUEBAS = correo('espera')

    await correrEnvioDeCampanas({ ahora: new Date(), pausaMs: 0 })

    expect(send).not.toHaveBeenCalled()
    expect(await estado(pendiente.id)).toMatchObject({ status: 'PENDIENTE', attempts: 0, sendAttemptAt: null })
  })

  it('con el tope alcanzado, un rebote que pasa una delivery a FALLIDO no deja reclamar otra', async () => {
    env.CRM_CAMPAIGN_DAILY_CAP = 1
    const campaignId = await campanaEnviando()
    const primera = await delivery(campaignId, 'rebota')
    const segunda = await delivery(campaignId, 'despues', { createdAt: new Date(Date.now() + 1000) })
    process.env.CRM_CORREO_PRUEBAS = `${correo('rebota')},${correo('despues')}`
    send.mockResolvedValue({ ok: true, resendId: `re_rebote_${suffix}`, transient: false })

    await correrEnvioDeCampanas({ ahora: new Date(), pausaMs: 0 })
    await expect(
      procesarAvisoCrm({
        type: 'email.bounced',
        data: { email_id: `re_rebote_${suffix}`, to: [correo('rebota')], bounce: { type: 'Permanent' } },
      }),
    ).resolves.toEqual({ manejado: true })
    await correrEnvioDeCampanas({ ahora: new Date(), pausaMs: 0 })

    expect(send).toHaveBeenCalledTimes(1)
    expect(await estado(primera.id)).toMatchObject({ status: 'FALLIDO' })
    expect(await estado(segunda.id)).toMatchObject({ status: 'PENDIENTE', attempts: 0 })
  })

  it('con un lugar libre, una delivery cuya respuesta se perdió (REINTENTO) lo sigue ocupando', async () => {
    env.CRM_CAMPAIGN_DAILY_CAP = 2
    const campaignId = await campanaEnviando()
    await delivery(campaignId, 'yasalio', { status: 'ENVIADO', attempts: 1, sendAttemptAt: new Date() })
    const perdida = await delivery(campaignId, 'perdida')
    const otra = await delivery(campaignId, 'otra', { createdAt: new Date(Date.now() + 1000) })
    process.env.CRM_CORREO_PRUEBAS = `${correo('perdida')},${correo('otra')}`
    // Sin respuesta HTTP: puede que haya salido, puede que no.
    send.mockResolvedValue({ ok: false, transient: true })

    await correrEnvioDeCampanas({ ahora: new Date(), pausaMs: 0 })
    await correrEnvioDeCampanas({ ahora: new Date(Date.now() + 1000), pausaMs: 0 })

    expect(send).toHaveBeenCalledTimes(1)
    expect(await estado(perdida.id)).toMatchObject({ status: 'REINTENTO', attempts: 1 })
    expect(await estado(otra.id)).toMatchObject({ status: 'PENDIENTE', attempts: 0 })
  })

  it('con el tope de 1 y el primer intento en 429, el tope queda lleno pero el reintento sí se reclama al minuto', async () => {
    env.CRM_CAMPAIGN_DAILY_CAP = 1
    const campaignId = await campanaEnviando()
    const limitada = await delivery(campaignId, 'limitada')
    const otra = await delivery(campaignId, 'fila', { createdAt: new Date(Date.now() + 1000) })
    process.env.CRM_CORREO_PRUEBAS = `${correo('limitada')},${correo('fila')}`
    const t0 = new Date()
    send.mockResolvedValueOnce({ ok: false, transient: true, errorCode: 'rate_limit_exceeded' })

    await correrEnvioDeCampanas({ ahora: t0, pausaMs: 0 })
    expect(await estado(limitada.id)).toMatchObject({ status: 'REINTENTO', nextAttemptAt: new Date(t0.getTime() + 60_000) })

    await correrEnvioDeCampanas({ ahora: new Date(t0.getTime() + 61_000), pausaMs: 0 })

    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls.map(([arg]) => arg.idempotencyKey)).toEqual([limitada.id, limitada.id])
    expect(await estado(limitada.id)).toMatchObject({ status: 'ENVIADO', attempts: 2 })
    expect(await estado(otra.id)).toMatchObject({ status: 'PENDIENTE', attempts: 0 })
  })
})

// El cupo de Resend (3-nov): con 80 de 100 en el día, lo reclamado que ya no se manda vuelve a la cola sin gastar un intento y
// para cuando Resend reinicia su día (medianoche UTC, las 18:00 de CDMX). Contra la base real: el CAS por el lease de la vuelta,
// y que nada de lo devuelto sale antes.
describe('el cupo de Resend', () => {
  /** 3-nov-2026, 12:00 en CDMX: fijo, para que la ventana de 23 h nunca dependa de la hora en que corre la prueba. */
  const T0 = new Date('2026-11-03T18:00:00.000Z')
  /** Cuando Resend reinicia el día tras T0: la medianoche UTC, las 18:00 de CDMX del mismo 3-nov. */
  const MEDIANOCHE = new Date('2026-11-04T00:00:00.000Z')

  it('🔴 la pausa a media vuelta devuelve lo reclamado sin gastar intento; nada sale antes del reinicio del cupo y luego sale una vez', async () => {
    const campaignId = await campanaEnviando()
    const primerIntento = new Date(T0.getTime() - 2 * HORA)
    const ids = [
      (await delivery(campaignId, 'cupo-a')).id,
      (await delivery(campaignId, 'cupo-b', { createdAt: new Date(Date.now() + 1000) })).id,
    ]
    const reintento = await delivery(campaignId, 'cupo-c', {
      status: 'REINTENTO',
      attempts: 2,
      nextAttemptAt: new Date(T0.getTime() - 60_000),
      sendAttemptAt: primerIntento,
    })
    ids.push(reintento.id)
    process.env.CRM_CORREO_PRUEBAS = ['cupo-a', 'cupo-b', 'cupo-c'].map(correo).join(',')
    // Libre al empezar y antes del primer correo; ese correo cruza el 80.
    pausa.mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true)

    await correrEnvioDeCampanas({ ahora: T0, pausaMs: 0 })

    expect(send).toHaveBeenCalledTimes(1)
    const enviada = send.mock.calls[0][0].idempotencyKey as string
    const devueltas = ids.filter(id => id !== enviada)
    for (const id of devueltas) {
      const fila = await estado(id)
      expect(fila).toMatchObject({ leaseUntil: null, nextAttemptAt: MEDIANOCHE })
      // El reintento conserva su primer intento y su intento; el primer intento vuelve PENDIENTE y suelta su lugar del día.
      if (id === reintento.id) expect(fila).toMatchObject({ status: 'REINTENTO', attempts: 2, sendAttemptAt: primerIntento })
      else expect(fila).toMatchObject({ status: 'PENDIENTE', attempts: 0, sendAttemptAt: null })
    }

    // Sin pausa (p. ej. el proceso se reinició y su memoria está vacía), antes del reinicio del cupo nada de lo devuelto sale.
    pausa.mockReturnValue(false)
    await correrEnvioDeCampanas({ ahora: new Date(T0.getTime() + 60_000), pausaMs: 0 })
    expect(send).toHaveBeenCalledTimes(1)

    // Al reiniciarse el cupo sale lo devuelto, una vez cada una y con su llave.
    await correrEnvioDeCampanas({ ahora: new Date(MEDIANOCHE.getTime() + 60_000), pausaMs: 0 })
    expect(
      send.mock.calls
        .slice(1)
        .map(([arg]) => arg.idempotencyKey)
        .sort(),
    ).toEqual([...devueltas].sort())
    for (const id of ids) expect(await estado(id)).toMatchObject({ status: 'ENVIADO' })
    // El reintento gastó exactamente los intentos que sí salieron a Resend: 2 de antes + 1 (la devolución no contó).
    expect(await estado(reintento.id)).toMatchObject({ attempts: 3, sendAttemptAt: primerIntento })
  })
})

describe('encolar: una transacción con la fila bloqueada', () => {
  it('sin la prueba de la versión actual da 409 «Mándate la prueba de esta versión antes»', async () => {
    const id = await borrador()
    const { token } = await previewSend(rafa, id)

    await expect(enqueueCampaign(rafa, id, token!)).rejects.toMatchObject({
      statusCode: 409,
      message: 'Mándate la prueba de esta versión antes',
    })
    expect(await prisma.crmCampaignDelivery.count({ where: { campaignId: id } })).toBe(0)
  })

  it('una prueba omitida por la lista no escribe testSentHash y el envío sigue con 409', async () => {
    const id = await borrador()
    process.env.CRM_CORREO_PRUEBAS = 'otra@avoqado.io'

    await expect(sendCampaignTest(rafa, id)).resolves.toMatchObject({ ok: false, motivo: 'fuera de la lista de prueba' })

    expect((await prisma.crmCampaign.findUniqueOrThrow({ where: { id } })).testSentHash).toBeNull()
    const { token } = await previewSend(rafa, id)
    await expect(enqueueCampaign(rafa, id, token!)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('una prueba rechazada por Resend no escribe testSentHash', async () => {
    const id = await borrador()
    process.env.CRM_CORREO_PRUEBAS = correo('rafa')
    send.mockResolvedValue({ ok: false, transient: false, errorCode: 'validation_error' })

    await expect(sendCampaignTest(rafa, id)).resolves.toMatchObject({ ok: false })

    expect((await prisma.crmCampaign.findUniqueOrThrow({ where: { id } })).testSentHash).toBeNull()
  })

  it('con prueba y confirmación encola a cada persona una vez, en PENDIENTE, y el trabajo la termina', async () => {
    const { id, vista } = await listaParaMandar()
    expect(vista).toMatchObject({ total: 3, porSegmento: { PROSPECTOS: 3, CLIENTES: 0, USUARIOS: 0 }, bloqueados: 0 })

    await expect(enqueueCampaign(rafa, id, vista.token)).resolves.toEqual({ total: 3 })

    const campana = await prisma.crmCampaign.findUniqueOrThrow({ where: { id } })
    expect(campana).toMatchObject({ status: 'ENVIANDO', total: 3 })
    expect(campana.enqueuedAt).not.toBeNull()
    const filas = await prisma.crmCampaignDelivery.findMany({ where: { campaignId: id }, orderBy: { email: 'asc' }, take: 10 })
    expect(filas.map(f => [f.email, f.status, f.reason])).toEqual([
      [correo('ana'), 'PENDIENTE', 'PROSPECTO'],
      [correo('beto'), 'PENDIENTE', 'PROSPECTO'],
      [correo('caro'), 'PENDIENTE', 'PROSPECTO'],
    ])

    process.env.CRM_CORREO_PRUEBAS = ['ana', 'beto', 'caro'].map(correo).join(',')
    send.mockReset()
    send.mockImplementation(async ({ idempotencyKey }) => ({ ok: true, resendId: `re_${idempotencyKey}`, transient: false }))
    await correrEnvioDeCampanas({ ahora: new Date(), pausaMs: 0 })

    expect(send).toHaveBeenCalledTimes(3)
    expect(await prisma.crmCampaignDelivery.count({ where: { campaignId: id, status: 'ENVIADO' } })).toBe(3)
    const terminada = await prisma.crmCampaign.findUniqueOrThrow({ where: { id } })
    expect(terminada.status).toBe('ENVIADA')
    expect(terminada.finishedAt).not.toBeNull()
  })

  it('dos envíos a la vez: uno gana y el otro da 409; cada persona queda una sola vez', async () => {
    const { id, vista } = await listaParaMandar()

    const { fulfilled, rejected } = settle(
      await Promise.allSettled([enqueueCampaign(rafa, id, vista.token), enqueueCampaign(rafa, id, vista.token)]),
    )

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ statusCode: 409 })
    expect(await prisma.crmCampaignDelivery.count({ where: { campaignId: id } })).toBe(3)
  })

  it('una edición y un envío a la vez: gana uno y el otro da 409; nunca sale un contenido sin probar', async () => {
    const { id, vista } = await listaParaMandar()

    const { fulfilled, rejected } = settle(
      await Promise.allSettled([
        updateCampaign(rafa, id, { blocks: [{ type: 'paragraph', text: 'Versión 2, sin probar' }] }),
        enqueueCampaign(rafa, id, vista.token),
      ]),
    )

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ statusCode: 409 })
    const campana = await prisma.crmCampaign.findUniqueOrThrow({ where: { id } })
    const deliveries = await prisma.crmCampaignDelivery.count({ where: { campaignId: id } })
    if (campana.status === 'ENVIANDO') {
      // Ganó el envío: salió exactamente la versión probada, y la edición no entró.
      expect(campana.testSentHash).toBe(contentHash(campana.subject, campana.blocks as never))
      expect(JSON.stringify(campana.blocks)).not.toContain('Versión 2')
      expect(deliveries).toBe(3)
    } else {
      // Ganó la edición: la campaña sigue en BORRADOR, sin nada en la cola.
      expect(campana.status).toBe('BORRADOR')
      expect(JSON.stringify(campana.blocks)).toContain('Versión 2')
      expect(deliveries).toBe(0)
    }
  })

  it('si el público creció entre la vista previa y el envío: 409 y la campaña sigue en BORRADOR sin deliveries', async () => {
    const { id, vista } = await listaParaMandar()
    await prospecto('nuevo')
    try {
      await expect(enqueueCampaign(rafa, id, vista.token)).rejects.toMatchObject({
        statusCode: 409,
        message: 'El público creció (3 → 4): revísalo y confirma otra vez',
      })

      expect((await prisma.crmCampaign.findUniqueOrThrow({ where: { id } })).status).toBe('BORRADOR')
      expect(await prisma.crmCampaignDelivery.count({ where: { campaignId: id } })).toBe(0)
    } finally {
      // Deja el público como estaba para las demás pruebas, también si ésta falla.
      await prisma.crmEmailConsent.deleteMany({ where: { email: correo('nuevo') } })
    }
  })

  it('una falla a mitad de la inserción deja la campaña en BORRADOR y sin deliveries', async () => {
    const { id, vista } = await listaParaMandar()
    jest.spyOn(audience, 'recorrerAudiencia').mockImplementationOnce(async (_aud, alLote) => {
      await alLote([{ email: correo('ana'), reason: 'PROSPECTO', vars: {} }])
      throw new Error('se cayó a la mitad')
    })

    await expect(enqueueCampaign(rafa, id, vista.token)).rejects.toThrow('se cayó a la mitad')

    expect((await prisma.crmCampaign.findUniqueOrThrow({ where: { id } })).status).toBe('BORRADOR')
    expect(await prisma.crmCampaignDelivery.count({ where: { campaignId: id } })).toBe(0)
  })

  it('cancelar a media cola deja lo pendiente OMITIDO «campaña cancelada» y el trabajo ya no manda nada', async () => {
    const { id, vista } = await listaParaMandar()
    await enqueueCampaign(rafa, id, vista.token)
    send.mockReset()

    await cancelCampaign(rafa, id)
    await correrEnvioDeCampanas({ ahora: new Date(), pausaMs: 0 })

    expect(send).not.toHaveBeenCalled()
    expect((await prisma.crmCampaign.findUniqueOrThrow({ where: { id } })).status).toBe('CANCELADA')
    expect(await prisma.crmCampaignDelivery.count({ where: { campaignId: id, status: 'OMITIDO', skipReason: 'campaña cancelada' } })).toBe(
      3,
    )
  })

  // Familia C (pasada r2): una REINTENTO ya tuvo un intento que pudo llegar a Resend (su respuesta se perdió). Cancelar no la vuelve
  // «omitida»: queda DESCONOCIDO con el motivo, y el trabajo tampoco la manda.
  it('cancelar con una REINTENTO la deja DESCONOCIDO «campaña cancelada» y la PENDIENTE OMITIDO; ninguna sale', async () => {
    const campaignId = await campanaEnviando()
    const perdida = await delivery(campaignId, 'cancelperdida', {
      status: 'REINTENTO',
      attempts: 1,
      sendAttemptAt: new Date(),
      lastError: 'Sin respuesta de Resend',
      nextAttemptAt: new Date(Date.now() - 60_000),
    })
    const pendiente = await delivery(campaignId, 'cancelpendiente')
    process.env.CRM_CORREO_PRUEBAS = `${correo('cancelperdida')},${correo('cancelpendiente')}`
    send.mockReset()

    await cancelCampaign(rafa, campaignId)
    await correrEnvioDeCampanas({ ahora: new Date(), pausaMs: 0 })

    expect(send).not.toHaveBeenCalled()
    expect(await estado(perdida.id)).toMatchObject({
      status: 'DESCONOCIDO',
      skipReason: 'campaña cancelada',
      lastError: 'No sabemos si salió: un intento anterior pudo llegar a Resend',
      nextAttemptAt: null,
    })
    expect(await estado(pendiente.id)).toMatchObject({ status: 'OMITIDO', skipReason: 'campaña cancelada' })
  })
})

// Plan B, tarea 4 (ajustes tras Codex r3 y r4): guardar el público corre bajo el candado de la campaña y con `basePublico` (la huella
// del público que leyó la pantalla). Las intercalaciones se FUERZAN (la primera transacción se aparca antes del commit con el candado
// tomado) y se COMPRUEBAN en `pg_blocking_pids`, no se suponen por tiempos. «El viejo lee → el nuevo escribe → el viejo escribe» ya no
// existe: el viejo lee CON el candado, así que la prueba se parte en sus dos órdenes posibles.
describe('guardar el público: candado y basePublico', () => {
  const conExcluida = (alias: string) => ({ ...AUDIENCIA(), excluir: [correo(alias)] })
  const conClientes = () => ({ segmentos: [...AUDIENCIA().segmentos, { tipo: 'CLIENTES' as const }] })
  const guardado = async (id: string) =>
    (await prisma.crmCampaign.findUniqueOrThrow({ where: { id }, select: { audience: true } })).audience
  const POR_EL_CANDADO = /FROM "CrmCampaign" WHERE "id" = \$1 FOR UPDATE/

  /** Corre `primero` aparcado con el candado tomado, lanza `segundo`, comprueba que espera ESE candado y suelta. */
  async function cruzar<A, B>(primero: () => Promise<A>, segundo: () => Promise<B>) {
    const aparcada = aparcarLaSiguienteTransaccion(prisma)
    let a: Promise<A> | undefined
    let b: Promise<B> | undefined
    try {
      a = primero()
      const pid = await aTiempo(aparcada.pid, 8_000, 'el primer PATCH no llegó al commit')
      b = segundo()
      expect(await esperarBloqueado(prisma, { bloqueadoPor: [pid], consulta: POR_EL_CANDADO })).not.toBeNull()
    } finally {
      aparcada.soltar()
      aparcada.restaurar()
    }
    return Promise.allSettled([a!, b!])
  }

  it('🔴 nuevo primero: el nuevo toma el candado y guarda la exclusión; el viejo espera, relee y recibe 409 PANTALLA_VIEJA; la exclusión sigue', async () => {
    const id = await borrador()
    const { huellaPublico } = await getCampaign(id)

    const [nuevo, viejo] = await cruzar(
      () => updateCampaign(rafa, id, { audience: conExcluida('ana'), basePublico: huellaPublico }),
      () => updateCampaign(rafa, id, { audience: conClientes() }),
    )

    expect(nuevo).toMatchObject({ status: 'fulfilled', value: { publico: { excluir: [correo('ana')] } } })
    expect(viejo).toMatchObject({ status: 'rejected', reason: { statusCode: 409, code: 'CRM_CAMPANA_PANTALLA_VIEJA' } })
    expect(await guardado(id)).toEqual({ v: 2, publicos: AUDIENCIA().segmentos, excluir: [correo('ana')], incluir: [] })
  })

  it('🔴 viejo primero y cambió el público: el viejo guarda; el nuevo espera, relee y recibe 409 CAMBIO (nada se pierde en silencio)', async () => {
    const id = await borrador()
    const { huellaPublico } = await getCampaign(id)

    const [viejo, nuevo] = await cruzar(
      () => updateCampaign(rafa, id, { audience: conClientes() }),
      () => updateCampaign(rafa, id, { audience: conExcluida('ana'), basePublico: huellaPublico }),
    )

    expect(viejo.status).toBe('fulfilled')
    expect(nuevo).toMatchObject({ status: 'rejected', reason: { statusCode: 409, code: 'CRM_CAMPANA_CAMBIO' } })
    expect(await guardado(id)).toEqual(conClientes())
    // La pantalla nueva recarga la campaña y vuelve a quitar a Ana: ahora sí queda, sobre el público del viejo.
    const recargada = await getCampaign(id)
    await updateCampaign(rafa, id, { audience: { ...conClientes(), excluir: [correo('ana')] }, basePublico: recargada.huellaPublico })
    expect(await guardado(id)).toEqual({ v: 2, publicos: conClientes().segmentos, excluir: [correo('ana')], incluir: [] })
  })

  it('viejo primero sin cambiar el público: los dos guardan y la exclusión queda', async () => {
    const id = await borrador()
    const { huellaPublico } = await getCampaign(id)

    const [viejo, nuevo] = await cruzar(
      () => updateCampaign(rafa, id, { name: `Renombrada ${suffix}`, audience: AUDIENCIA() }),
      () => updateCampaign(rafa, id, { audience: conExcluida('beto'), basePublico: huellaPublico }),
    )

    expect(viejo.status).toBe('fulfilled')
    expect(nuevo.status).toBe('fulfilled')
    expect(await guardado(id)).toEqual({ v: 2, publicos: AUDIENCIA().segmentos, excluir: [correo('beto')], incluir: [] })
  })

  it('🔴 dos PATCH nuevos a la vez con el mismo basePublico: uno guarda y el otro es 409 CAMBIO', async () => {
    const id = await borrador()
    const { huellaPublico } = await getCampaign(id)

    const { fulfilled, rejected } = settle(
      await Promise.allSettled([
        updateCampaign(rafa, id, { audience: conExcluida('ana'), basePublico: huellaPublico }),
        updateCampaign(rafa, id, { audience: conExcluida('beto'), basePublico: huellaPublico }),
      ]),
    )

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ statusCode: 409, code: 'CRM_CAMPANA_CAMBIO' })
    const ganador = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof updateCampaign>>>).value.publico.excluir
    expect(await guardado(id)).toMatchObject({ v: 2, excluir: ganador })
  })

  it('🔴 prueba terminada + GET demorado + guardar el público con el basePublico de antes: sin 409 (la prueba y el contenido no tocan el público)', async () => {
    const id = await borrador()
    const vistaVieja = await getCampaign(id)
    process.env.CRM_CORREO_PRUEBAS = correo('rafa')
    await expect(sendCampaignTest(rafa, id)).resolves.toMatchObject({ ok: true })
    await updateCampaign(rafa, id, { subject: 'Hola otra vez {{nombre}}' })

    await expect(updateCampaign(rafa, id, { audience: conExcluida('caro'), basePublico: vistaVieja.huellaPublico })).resolves.toMatchObject(
      {
        publico: { excluir: [correo('caro')] },
      },
    )
  })

  it('agregar a alguien sin contacto en el CRM es 400 PERSONA_SIN_PERMISO dentro de la transacción; con su contacto, se guarda', async () => {
    const id = await borrador()
    // Ana marcó la casilla, pero su negocio no tiene ningún contacto con su correo: no es agregable.
    await expect(
      updateCampaign(rafa, id, {
        audience: { ...AUDIENCIA(), incluir: [correo('ana')] },
        basePublico: (await getCampaign(id)).huellaPublico,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'CRM_CAMPANA_PERSONA_SIN_PERMISO', details: { correos: [correo('ana')] } })
    expect(await guardado(id)).toEqual(AUDIENCIA())

    const { accountId } = await prisma.crmEmailConsent.findUniqueOrThrow({ where: { email: correo('ana') } })
    await prisma.crmContact.create({ data: { accountId: accountId!, name: 'Ana', email: correo('ana'), isPrimary: true } })
    await updateCampaign(rafa, id, {
      audience: { ...AUDIENCIA(), incluir: [correo('ana')] },
      basePublico: (await getCampaign(id)).huellaPublico,
    })
    expect(await guardado(id)).toEqual({ v: 2, publicos: AUDIENCIA().segmentos, excluir: [], incluir: [correo('ana')] })
  })
})
