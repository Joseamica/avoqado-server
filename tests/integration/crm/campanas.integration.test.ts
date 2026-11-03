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

import { env } from '@/config/env'
import type { CrmAccess } from '@/services/crm/access.service'
import * as audience from '@/services/crm/email/audience.service'
import {
  cancelCampaign,
  createCampaign,
  enqueueCampaign,
  previewSend,
  sendCampaignTest,
  updateCampaign,
} from '@/services/crm/email/campaigns.service'
import { correrEnvioDeCampanas, reclamarLote } from '@/services/crm/email/campaignSender.service'
import { procesarAvisoCrm } from '@/services/crm/email/campaignWebhook.service'
import { contentHash } from '@/services/crm/email/templates.service'
import emailService from '@/services/email.service'
import prisma from '@/utils/prismaClient'

const send = emailService.sendEmailWithResult as jest.Mock

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
  return { id, vista }
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

describe('encolar: una transacción con la fila bloqueada', () => {
  it('sin la prueba de la versión actual da 409 «Mándate la prueba de esta versión antes»', async () => {
    const id = await borrador()
    const { token } = await previewSend(rafa, id)

    await expect(enqueueCampaign(rafa, id, token)).rejects.toMatchObject({
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
    await expect(enqueueCampaign(rafa, id, token)).rejects.toMatchObject({ statusCode: 409 })
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
})
