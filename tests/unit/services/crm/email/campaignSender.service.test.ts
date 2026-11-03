/**
 * El remitente de las campañas del CRM, correo por correo (fase 2, plan tarea 5). Lo que decide AL BORDE de cada envío: la
 * baja que llegó después de encolar, la campaña cancelada a media cola, la lista de prueba, y qué queda escrito cuando Resend
 * acepta pero nuestro guardado falla (DESCONOCIDO, nunca otro intento). Resend está simulado: aquí no sale ningún correo.
 *
 * La cola concurrente (lease, SKIP LOCKED, tope diario, la ventana de 23 h) vive en `tests/integration/crm/campanas.integration.test.ts`.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { env } from '@/config/env'
import logger from '@/config/logger'
import { BACKOFF_MS, correrEnvioDeCampanas, enviarDelivery, LEASE_MS } from '@/services/crm/email/campaignSender.service'
import emailService from '@/services/email.service'
import { campanasPausadasPorCupo } from '@/services/email/resendQuota'
import { verifyPlatformUnsubscribeToken } from '@/utils/platformUnsubscribeToken'

jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendEmailWithResult: jest.fn() } }))
jest.mock('@/services/email/resendQuota', () => ({
  ...jest.requireActual('@/services/email/resendQuota'),
  campanasPausadasPorCupo: jest.fn(() => false),
}))

const send = emailService.sendEmailWithResult as jest.Mock
const pausa = campanasPausadasPorCupo as jest.Mock

const DELIVERY = 'cdeliverycrm0000000000001'
const ACCOUNT = 'caccountcrm00000000000001'
const AHORA = new Date('2026-11-02T18:00:00.000Z')
const ENCOLADA = new Date(AHORA.getTime() - 3_600_000)
const LEASE = new Date(AHORA.getTime() + 4 * 60_000)

const fila = (over: Record<string, unknown> = {}, campana: Record<string, unknown> = {}) => ({
  id: DELIVERY,
  email: 'ana@cafeteria.mx',
  reason: 'PROSPECTO',
  reasonVenueName: null,
  vars: { nombre: 'Ana', negocio: 'Cafetería La Esquina', vendedor: 'Rafa Pérez' },
  status: 'ENVIANDO',
  attempts: 1,
  leaseUntil: LEASE,
  sendAttemptAt: AHORA,
  resendId: null,
  accountId: null,
  campaign: {
    status: 'ENVIANDO',
    enqueuedAt: ENCOLADA,
    subject: 'Hola {{nombre}}',
    blocks: [{ type: 'paragraph', text: 'Te escribe {{vendedor}} <script>x</script>' }],
    ...campana,
  },
  ...over,
})

/** El CAS que toda escritura del remitente lleva: la fila sigue siendo nuestra (estado, intento y lease). */
const CAS = { id: DELIVERY, status: 'ENVIANDO', attempts: 1, leaseUntil: LEASE }

const ENV = { ...process.env }

beforeEach(() => {
  for (const fn of [
    prismaMock.crmCampaignDelivery.findUnique,
    prismaMock.crmCampaignDelivery.updateMany,
    prismaMock.crmEmailOptOut.findUnique,
    prismaMock.emailSuppression.findUnique,
    prismaMock.crmErased.findFirst,
    prismaMock.crmAccount.findUnique,
    send,
  ])
    fn.mockReset()
  prismaMock.crmCampaignDelivery.findUnique.mockResolvedValue(fila())
  prismaMock.crmCampaignDelivery.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.crmEmailOptOut.findUnique.mockResolvedValue(null)
  prismaMock.emailSuppression.findUnique.mockResolvedValue(null)
  prismaMock.crmErased.findFirst.mockResolvedValue(null)
  prismaMock.crmAccount.findUnique.mockResolvedValue({ id: ACCOUNT })
  send.mockResolvedValue({ ok: true, resendId: 're_123', transient: false })
  pausa.mockReset().mockReturnValue(false)
  process.env.CRM_CORREO_PRUEBAS = 'ana@cafeteria.mx'
})

afterEach(() => {
  if (ENV.CRM_CORREO_PRUEBAS === undefined) delete process.env.CRM_CORREO_PRUEBAS
  else process.env.CRM_CORREO_PRUEBAS = ENV.CRM_CORREO_PRUEBAS
})

const escrito = (n = 0) => prismaMock.crmCampaignDelivery.updateMany.mock.calls[n]?.[0]

describe('enviarDelivery — lo que se revisa al borde', () => {
  it('quien se dio de baja DESPUÉS de encolar queda OMITIDO «BAJA» y no se llama a Resend', async () => {
    prismaMock.crmEmailOptOut.findUnique.mockResolvedValue({ id: 'coptout00000000000000001' })

    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('OMITIDO')

    expect(send).not.toHaveBeenCalled()
    expect(escrito()).toEqual({
      where: CAS,
      data: expect.objectContaining({ status: 'OMITIDO', skipReason: 'BAJA', leaseUntil: null }),
    })
  })

  it('un rebote o una queja ya suprimidos también quedan OMITIDO con su motivo', async () => {
    prismaMock.emailSuppression.findUnique.mockResolvedValue({ reason: 'COMPLAINT' })

    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('OMITIDO')

    expect(send).not.toHaveBeenCalled()
    expect(escrito().data).toMatchObject({ status: 'OMITIDO', skipReason: 'QUEJA' })
  })

  it('con la campaña CANCELADA a media cola, la que sigue queda OMITIDO «campaña cancelada»', async () => {
    prismaMock.crmCampaignDelivery.findUnique.mockResolvedValue(fila({}, { status: 'CANCELADA' }))

    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('OMITIDO')

    expect(send).not.toHaveBeenCalled()
    expect(escrito().data).toMatchObject({ status: 'OMITIDO', skipReason: 'campaña cancelada' })
  })

  it('fuera de producción, una dirección fuera de la lista de prueba queda OMITIDO y no sale', async () => {
    process.env.CRM_CORREO_PRUEBAS = 'otra@avoqado.io'

    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('OMITIDO')

    expect(send).not.toHaveBeenCalled()
    expect(escrito().data).toMatchObject({ status: 'OMITIDO', skipReason: 'fuera de la lista de prueba' })
  })

  it('si la revisión de bajas falla, no se manda a ciegas: queda REINTENTO', async () => {
    prismaMock.crmEmailOptOut.findUnique.mockRejectedValue(new Error('se cayó la base'))

    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('REINTENTO')

    expect(send).not.toHaveBeenCalled()
  })

  // I1 (revisión final): «Eliminar» (D7) corre mientras la campaña se manda. La eliminación deja OMITIDO lo que encuentra en la
  // cola; esto es lo que ella no alcanza a ver (un encolado que leyó el público antes de que terminara).
  it('🔴 una persona eliminada del CRM después de encolar queda OMITIDO «persona eliminada» y no se llama a Resend', async () => {
    prismaMock.crmErased.findFirst.mockResolvedValue({ erasedAt: AHORA })

    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('OMITIDO')

    expect(send).not.toHaveBeenCalled()
    expect(escrito().data).toMatchObject({ status: 'OMITIDO', skipReason: 'persona eliminada' })
    // La lápida guarda el hash, nunca el correo; y sólo cuenta lo eliminado desde que se encoló (con margen).
    const { where } = prismaMock.crmErased.findFirst.mock.calls[0][0]
    expect(JSON.stringify(where)).not.toContain('ana@cafeteria.mx')
    expect(where.erasedAt.gte.getTime()).toBeLessThan(ENCOLADA.getTime())
  })

  it('🔴 su cuenta del CRM ya no existe (se eliminó): OMITIDO «persona eliminada», aunque su correo no esté en la lápida', async () => {
    prismaMock.crmCampaignDelivery.findUnique.mockResolvedValue(fila({ accountId: ACCOUNT }))
    prismaMock.crmAccount.findUnique.mockResolvedValue(null)

    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('OMITIDO')

    expect(send).not.toHaveBeenCalled()
    expect(escrito().data).toMatchObject({ status: 'OMITIDO', skipReason: 'persona eliminada' })
  })

  it('con su cuenta viva y sin lápida, sale', async () => {
    prismaMock.crmCampaignDelivery.findUnique.mockResolvedValue(fila({ accountId: ACCOUNT }))

    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('ENVIADO')

    expect(prismaMock.crmAccount.findUnique).toHaveBeenCalledWith({ where: { id: ACCOUNT }, select: { id: true } })
  })

  it('si la lápida no se puede revisar, no se manda a ciegas: queda REINTENTO', async () => {
    prismaMock.crmErased.findFirst.mockRejectedValue(new Error('se cayó la base'))

    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('REINTENTO')

    expect(send).not.toHaveBeenCalled()
  })

  // Familia C: en un REINTENTO (intento 2 en adelante) un intento anterior pudo haber llegado a Resend (respuesta perdida, o un
  // proceso que murió a media llamada). Lo que lo frena ahora no prueba que no salió: DESCONOCIDO con su motivo, nunca OMITIDO.
  it.each([
    ['la baja (quien la recibió y le dio «baja»)', () => prismaMock.crmEmailOptOut.findUnique.mockResolvedValue({ id: 'cbaja' }), 'BAJA'],
    [
      'la campaña cancelada',
      () => prismaMock.crmCampaignDelivery.findUnique.mockResolvedValue(fila({ attempts: 2 }, { status: 'CANCELADA' })),
      'campaña cancelada',
    ],
    ['la persona eliminada', () => prismaMock.crmErased.findFirst.mockResolvedValue({ erasedAt: AHORA }), 'persona eliminada'],
  ] as const)('en el intento 2, %s deja DESCONOCIDO con su motivo y no llama a Resend', async (_caso, preparar, motivo) => {
    prismaMock.crmCampaignDelivery.findUnique.mockResolvedValue(fila({ attempts: 2 }))
    preparar()

    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('DESCONOCIDO')

    expect(send).not.toHaveBeenCalled()
    expect(escrito()).toEqual({
      where: { ...CAS, attempts: 2 },
      data: {
        status: 'DESCONOCIDO',
        skipReason: motivo,
        lastError: 'No sabemos si salió: un intento anterior pudo llegar a Resend',
        nextAttemptAt: null,
        leaseUntil: null,
      },
    })
  })

  it('una fila que ya no es nuestra (lease vencido u otro estado) no se toca ni se manda', async () => {
    prismaMock.crmCampaignDelivery.findUnique.mockResolvedValue(fila({ leaseUntil: new Date(AHORA.getTime() - 1) }))

    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('DESCONOCIDO')

    expect(send).not.toHaveBeenCalled()
    expect(prismaMock.crmCampaignDelivery.updateMany).not.toHaveBeenCalled()
  })
})

describe('enviarDelivery — lo que sale y cómo se guarda', () => {
  it('manda desde el remitente de campañas con la llave de idempotencia, el tag, la baja de un clic y el texto escapado', async () => {
    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('ENVIADO')

    expect(send).toHaveBeenCalledTimes(1)
    const correo = send.mock.calls[0][0]
    expect(correo).toMatchObject({
      to: 'ana@cafeteria.mx',
      subject: 'Hola Ana',
      from: env.CRM_CAMPAIGN_FROM,
      replyTo: env.CRM_CAMPAIGN_REPLY_TO,
      idempotencyKey: DELIVERY,
      tags: [{ name: 'crmDeliveryId', value: DELIVERY }],
    })
    expect(correo.html).toContain('Te escribe Rafa Pérez &lt;script&gt;')
    expect(correo.html).not.toContain('<script>')
    expect(correo.html).toContain('Te llega porque pediste recibir novedades de Avoqado.')
    const baja = /<(.+)>/.exec(correo.headers['List-Unsubscribe'])![1]
    expect(verifyPlatformUnsubscribeToken(new URL(baja).searchParams.get('token'))).toEqual({ email: 'ana@cafeteria.mx' })
    expect(correo.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')

    expect(escrito()).toEqual({
      where: CAS,
      data: expect.objectContaining({ status: 'ENVIADO', resendId: 're_123', sentAt: AHORA, leaseUntil: null }),
    })
  })

  it('el pie de un USUARIO dice en qué negocio usa Avoqado', async () => {
    prismaMock.crmCampaignDelivery.findUnique.mockResolvedValue(fila({ reason: 'USUARIO', reasonVenueName: 'Tacos <b>El Güero</b>' }))

    await enviarDelivery(DELIVERY, AHORA)

    expect(send.mock.calls[0][0].html).toContain('Te llega porque usas Avoqado en Tacos &lt;b&gt;El Güero&lt;/b&gt;.')
  })

  it('🔴 si Resend aceptó y el CAS final no aplica, queda DESCONOCIDO con su resendId y no se reintenta', async () => {
    prismaMock.crmCampaignDelivery.updateMany.mockRejectedValueOnce(new Error('se cayó la base')).mockResolvedValueOnce({ count: 1 })

    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('DESCONOCIDO')

    expect(send).toHaveBeenCalledTimes(1)
    expect(escrito(1)).toEqual({
      where: CAS,
      data: expect.objectContaining({ status: 'DESCONOCIDO', resendId: 're_123', sentAt: AHORA, leaseUntil: null }),
    })
    const estados = prismaMock.crmCampaignDelivery.updateMany.mock.calls.map(([arg]: any[]) => arg.data.status)
    expect(estados).not.toContain('REINTENTO')
  })

  it('también si el CAS cuenta 0 (otro tomó la fila): DESCONOCIDO, nunca otro envío', async () => {
    prismaMock.crmCampaignDelivery.updateMany.mockResolvedValue({ count: 0 })

    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('DESCONOCIDO')

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('un 429 pasa a REINTENTO con el siguiente intento en 1 minuto', async () => {
    send.mockResolvedValue({ ok: false, transient: true, errorCode: 'rate_limit_exceeded' })

    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('REINTENTO')

    expect(escrito()).toEqual({
      where: CAS,
      data: expect.objectContaining({
        status: 'REINTENTO',
        nextAttemptAt: new Date(AHORA.getTime() + 60_000),
        lastError: 'rate_limit_exceeded',
        leaseUntil: null,
      }),
    })
  })

  // Ruling 11 (Codex código r2 P3): seis transitorios no prueban que ninguno llegó a Resend (una respuesta perdida sí salió), y la fila
  // no guarda qué pasó en cada intento. Al agotarlos queda DESCONOCIDO («no sabemos si salió»), nunca FALLIDO («no salió»).
  it('las esperas son 1 m, 5 m, 30 m, 2 h y 6 h; el sexto transitorio queda DESCONOCIDO, sin otro intento', async () => {
    expect(BACKOFF_MS).toEqual([60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000])
    send.mockResolvedValue({ ok: false, transient: true, errorCode: 'internal_server_error' })
    prismaMock.crmCampaignDelivery.findUnique.mockResolvedValue(fila({ attempts: 6 }))

    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('DESCONOCIDO')
    expect(escrito()).toEqual({
      where: { ...CAS, attempts: 6 },
      data: expect.objectContaining({ status: 'DESCONOCIDO', nextAttemptAt: null, leaseUntil: null }),
    })
    expect(escrito().data.lastError).toMatch(/^No sabemos si salió: se agotaron los 6 intentos \(internal_server_error\)$/)
  })

  it('la respuesta perdida del primer intento y luego fallas de red: al sexto, DESCONOCIDO (no «No salieron»)', async () => {
    send.mockRejectedValue(new Error('socket hang up'))
    prismaMock.crmCampaignDelivery.findUnique.mockResolvedValue(fila({ attempts: 6 }))

    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('DESCONOCIDO')
    expect(escrito().data).toMatchObject({ status: 'DESCONOCIDO' })
  })

  it('aunque el sexto falle ANTES de Resend (al revisar las bajas), los cinco anteriores pudieron salir: DESCONOCIDO', async () => {
    prismaMock.crmEmailOptOut.findUnique.mockRejectedValue(new Error('se cayó la base'))
    prismaMock.crmCampaignDelivery.findUnique.mockResolvedValue(fila({ attempts: 6 }))

    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('DESCONOCIDO')
    expect(send).not.toHaveBeenCalled()
    expect(escrito().data).toMatchObject({ status: 'DESCONOCIDO' })
  })

  // Familia C: un 409 de idempotencia en un reintento dice que Resend YA tiene una petición con esta llave (la que pudo salir).
  it('invalid_idempotent_request (la llave ya se usó con otro contenido, p. ej. tras un deploy) queda DESCONOCIDO, nunca FALLIDO', async () => {
    send.mockResolvedValue({ ok: false, transient: false, errorCode: 'invalid_idempotent_request' })
    prismaMock.crmCampaignDelivery.findUnique.mockResolvedValue(fila({ attempts: 2 }))

    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('DESCONOCIDO')
    expect(escrito().data).toMatchObject({ status: 'DESCONOCIDO', nextAttemptAt: null })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('concurrent_idempotent_requests (la primera sigue en vuelo) se reintenta con la misma llave: Resend contestará lo que pasó', async () => {
    send.mockResolvedValue({ ok: false, transient: false, errorCode: 'concurrent_idempotent_requests' })
    prismaMock.crmCampaignDelivery.findUnique.mockResolvedValue(fila({ attempts: 2 }))

    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('REINTENTO')
    expect(escrito().data).toMatchObject({ status: 'REINTENTO', nextAttemptAt: new Date(AHORA.getTime() + 5 * 60_000) })
  })

  it('un error que no se arregla solo (422) queda FALLIDO a la primera', async () => {
    send.mockResolvedValue({ ok: false, transient: false, errorCode: 'validation_error' })

    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('FALLIDO')
    expect(escrito().data).toMatchObject({ status: 'FALLIDO', lastError: 'validation_error' })
  })

  // Codex código r3: un rechazo en un REINTENTO no borra la duda del intento anterior (respuesta perdida y luego, p. ej., la
  // credencial revocada: Resend rechaza antes de mirar la llave). Pudo haber salido: DESCONOCIDO, nunca «No salieron».
  it('el mismo rechazo en un reintento (respuesta perdida y luego credencial inválida) queda DESCONOCIDO', async () => {
    send.mockResolvedValue({ ok: false, transient: false, errorCode: 'validation_error' })
    prismaMock.crmCampaignDelivery.findUnique.mockResolvedValue(fila({ attempts: 2 }))

    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('DESCONOCIDO')
    expect(escrito().data).toMatchObject({ status: 'DESCONOCIDO', nextAttemptAt: null })
    expect(escrito().data.lastError).toContain('validation_error')
  })
})

describe('correrEnvioDeCampanas — el trabajo', () => {
  const killSwitch = env.MARKETING_KILL_SWITCH
  afterEach(() => {
    env.MARKETING_KILL_SWITCH = killSwitch
  })

  it('con MARKETING_KILL_SWITCH prendido no hace nada: ni una consulta, ni un correo', async () => {
    env.MARKETING_KILL_SWITCH = 'true'
    prismaMock.crmCampaignDelivery.count.mockReset()
    prismaMock.$queryRaw.mockReset()

    await expect(correrEnvioDeCampanas({ ahora: AHORA, pausaMs: 0 })).resolves.toBeNull()

    expect(prismaMock.crmCampaignDelivery.count).not.toHaveBeenCalled()
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})

/**
 * El cupo de Resend (promesa `docs/audit/2026-11-03-cupo-de-resend/promesa.md`): con 80 de 100 en el día las campañas esperan a la
 * medianoche de Ciudad de México para dejarle lugar al login y a los recibos. Lo que vuelve a la cola no gasta un intento (no debe
 * acercarse al agotamiento del Ruling 11) y nunca sale dos veces: el lease y el CAS de siempre.
 */
describe('el cupo de Resend', () => {
  /** La medianoche de CDMX que sigue a AHORA (2-nov, 12:00 en CDMX). */
  const MEDIANOCHE = new Date('2026-11-03T06:00:00.000Z')
  const VACIO = { ENVIADO: 0, REINTENTO: 0, FALLIDO: 0, OMITIDO: 0, DESCONOCIDO: 0 }

  beforeEach(() => {
    prismaMock.crmCampaignDelivery.count.mockReset().mockResolvedValue(0)
    prismaMock.$queryRaw.mockReset()
    prismaMock.crmCampaign.updateMany.mockReset().mockResolvedValue({ count: 0 })
    ;(logger.info as jest.Mock).mockClear()
  })

  it('pausado por el cupo: la vuelta no reclama nada (ni el conteo, ni la cola) y lo dice en el log', async () => {
    pausa.mockReturnValue(true)

    await expect(correrEnvioDeCampanas({ ahora: AHORA, pausaMs: 0 })).resolves.toEqual(VACIO)

    expect(prismaMock.crmCampaignDelivery.count).not.toHaveBeenCalled()
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('cupo de Resend'))
  })

  it('al cruzar el 80 a media vuelta la siguiente no sale: lo reclamado vuelve sin gastar intento, para la medianoche', async () => {
    // Libre al empezar y antes del primer correo; ese correo cruza el 80.
    pausa.mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true)
    prismaMock.$queryRaw.mockResolvedValue([{ id: DELIVERY }, { id: 'cotra000000000000000000001' }, { id: 'cotra000000000000000000002' }])

    await correrEnvioDeCampanas({ ahora: AHORA, pausaMs: 0 })

    expect(send).toHaveBeenCalledTimes(1)
    // CAS por el lease de ESTA vuelta: si otro ya la reclamó, no se toca.
    const nuestras = {
      id: { in: ['cotra000000000000000000001', 'cotra000000000000000000002'] },
      status: 'ENVIANDO',
      leaseUntil: new Date(AHORA.getTime() + LEASE_MS),
    }
    // Un primer intento nunca llegó a la red: vuelve PENDIENTE y suelta su lugar del día.
    expect(prismaMock.crmCampaignDelivery.updateMany).toHaveBeenCalledWith({
      where: { ...nuestras, attempts: 1 },
      data: { status: 'PENDIENTE', attempts: 0, sendAttemptAt: null, leaseUntil: null, nextAttemptAt: MEDIANOCHE },
    })
    // Un reintento conserva su primer intento (la ventana de 23 h y la llave siguen): sólo se le regresa el intento.
    expect(prismaMock.crmCampaignDelivery.updateMany).toHaveBeenCalledWith({
      where: { ...nuestras, attempts: { gt: 1 } },
      data: { status: 'REINTENTO', attempts: { decrement: 1 }, leaseUntil: null, nextAttemptAt: MEDIANOCHE },
    })
  })

  it('sin pausa, la vuelta manda todo lo reclamado como hoy y no devuelve nada a la cola', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ id: DELIVERY }, { id: DELIVERY }])

    const resumen = await correrEnvioDeCampanas({ ahora: AHORA, pausaMs: 0 })

    expect(send).toHaveBeenCalledTimes(2)
    expect(resumen).toEqual({ ...VACIO, ENVIADO: 2 })
    const devoluciones = prismaMock.crmCampaignDelivery.updateMany.mock.calls.filter(([arg]) => arg.where?.id?.in)
    expect(devoluciones).toHaveLength(0)
  })

  it('un 429 de cupo en el PRIMER intento: vuelve PENDIENTE sin gastar el intento ni su lugar del día', async () => {
    send.mockResolvedValue({ ok: false, transient: true, errorCode: 'daily_quota_exceeded' })

    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('REINTENTO')
    expect(escrito()).toEqual({
      where: CAS,
      data: { leaseUntil: null, status: 'PENDIENTE', attempts: 0, sendAttemptAt: null, nextAttemptAt: MEDIANOCHE },
    })
  })

  it('un 429 de cupo del mes en un reintento: vuelve REINTENTO con un intento menos y su primer intento intacto', async () => {
    send.mockResolvedValue({ ok: false, transient: true, errorCode: 'monthly_quota_exceeded' })
    prismaMock.crmCampaignDelivery.findUnique.mockResolvedValue(fila({ attempts: 3 }))

    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('REINTENTO')
    expect(escrito()).toEqual({
      where: { ...CAS, attempts: 3 },
      data: { leaseUntil: null, status: 'REINTENTO', attempts: 2, nextAttemptAt: MEDIANOCHE },
    })
  })

  it('el 429 de RITMO (rate_limit_exceeded) sigue como hoy: un reintento al minuto que sí gasta el intento', async () => {
    send.mockResolvedValue({ ok: false, transient: true, errorCode: 'rate_limit_exceeded' })

    await expect(enviarDelivery(DELIVERY, AHORA)).resolves.toBe('REINTENTO')
    expect(escrito().data).toMatchObject({ status: 'REINTENTO', nextAttemptAt: new Date(AHORA.getTime() + BACKOFF_MS[0]) })
    expect(escrito().data).not.toHaveProperty('attempts')
  })
})
