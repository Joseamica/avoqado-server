/**
 * La entrega de tarjetas (1b S3) con dobles: qué se manda, con qué llave, qué se escribe y qué queda en el log. El reclamo con
 * Postgres de verdad (dos a la vez, vencido, elegibles) vive en `tests/integration/giftCards/entrega.integration.test.ts`.
 */
jest.mock('@/services/whatsapp.service', () => ({
  ...jest.requireActual('@/services/whatsapp.service'),
  sendGiftCardDeliveryWhatsApp: jest.fn(),
  whatsappConfigurado: jest.fn(() => true),
}))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendGiftCardDeliveryEmail: jest.fn() } }))
jest.mock('@/services/giftCards/giftCardFallosTempranos', () => {
  const real = jest.requireActual('@/services/giftCards/giftCardFallosTempranos')
  return { ...real, anotarFalloTemprano: jest.fn(real.anotarFalloTemprano) }
})

import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import emailService from '@/services/email.service'
import { WhatsappCloudApiError, sendGiftCardDeliveryWhatsApp, whatsappConfigurado } from '@/services/whatsapp.service'
import { anotarFalloTemprano, reiniciarFallosTempranosParaPruebas } from '@/services/giftCards/giftCardFallosTempranos'
import {
  type EntregaReclamada,
  entregarTarjetas,
  hayEntregasPendientes,
  marcarEntregaFallidaPorMensaje,
} from '@/services/giftCards/giftCardDelivery.service'
import { prismaMock } from '../../../__helpers__/setup'

const AHORA = new Date('2026-10-21T15:00:00.000Z')
const RECLAMADO_EN = new Date(AHORA)
const h = (token: string) => createHash('sha256').update(token).digest('hex').slice(0, 8)
const wa = sendGiftCardDeliveryWhatsApp as jest.Mock
const correo = emailService.sendGiftCardDeliveryEmail as jest.Mock
const configurado = whatsappConfigurado as jest.Mock

function reclamada(over: Partial<EntregaReclamada> = {}): EntregaReclamada {
  return {
    id: 'gc1',
    venueId: 'v1',
    deliveryChannel: 'WHATSAPP',
    recipientPhone: '5512345678',
    recipientEmail: null,
    recipientName: null,
    purchaserName: 'Luis',
    codeLast4: 'JKMN',
    pageToken: 'tok',
    initialAmount: new Prisma.Decimal(1000),
    deliveryAttempts: 1,
    deliveryOperationKey: null,
    deliveryClaimedAt: RECLAMADO_EN,
    ...over,
  }
}

const porCorreo = (over: Partial<EntregaReclamada> = {}) =>
  reclamada({ deliveryChannel: 'EMAIL', recipientPhone: null, recipientEmail: 'ana@correo.mx', recipientName: 'Ana', ...over })

/** Un fragmento `Prisma.sql` (sus anidados ya vienen aplanados en `strings`/`values`). */
const esFragmento = (v: any): v is { strings: string[] } =>
  v != null && typeof v === 'object' && Array.isArray(v.strings) && Array.isArray(v.values)

/** El SQL de una llamada a `$queryRaw` (tagged template), con los fragmentos anidados ya puestos y `?` por cada valor. */
function textoDe([strings, ...values]: any[]): string {
  return strings.reduce(
    (t: string, s: string, i: number) => t + s + (i < values.length ? (esFragmento(values[i]) ? values[i].strings.join('?') : '?') : ''),
    '',
  )
}

/** El texto de cada `$queryRaw` decide qué responde: atoradas, reclamo o «¿hay pendientes?». */
function armar(p: { reclamadas?: EntregaReclamada[]; atoradas?: Array<{ id: string; venueId: string; deliveryChannel: string }> }) {
  prismaMock.$queryRaw.mockReset().mockImplementation(async (...args: any[]) => {
    const sql = textoDe(args)
    if (sql.includes("'UNCONFIRMED'")) return p.atoradas ?? []
    if (sql.includes('"deliveryAttempts" + 1')) return p.reclamadas ?? []
    return []
  })
  prismaMock.venue.findMany.mockReset().mockResolvedValue([{ id: 'v1', name: 'IQ Collection' }])
  prismaMock.giftCard.updateMany.mockReset().mockResolvedValue({ count: 1 })
  prismaMock.giftCard.findMany.mockReset().mockResolvedValue([])
}

const escrituras = (): Array<{ where: any; data: any }> => prismaMock.giftCard.updateMany.mock.calls.map((c: any[]) => c[0])
const todoLoQueSeLogueo = () =>
  JSON.stringify([
    (logger.info as jest.Mock).mock.calls,
    (logger.warn as jest.Mock).mock.calls,
    (logger.error as jest.Mock).mock.calls,
    (logger.debug as jest.Mock).mock.calls,
  ])

beforeEach(() => {
  reiniciarFallosTempranosParaPruebas()
  configurado.mockReturnValue(true)
  wa.mockReset()
  correo.mockReset()
})

describe('entregarTarjetas — WhatsApp', () => {
  it('WhatsApp aceptado ⇒ SENT, deliveredAt, deliveryMessageId', async () => {
    armar({ reclamadas: [reclamada()] })
    wa.mockResolvedValue({ messageId: 'wamid.1' })

    const r = await entregarTarjetas({ ahora: AHORA })

    expect(wa).toHaveBeenCalledWith('5512345678', {
      negocio: 'IQ Collection',
      monto: '$1,000.00',
      deParteDe: 'Luis',
      folio: 'JKMN',
      pageToken: 'tok',
    })
    expect(escrituras()).toEqual([
      {
        where: { id: 'gc1', deliveryClaimedAt: RECLAMADO_EN, pageToken: 'tok' },
        data: expect.objectContaining({
          deliveryStatus: 'SENT',
          deliveredAt: expect.any(Date),
          deliveryMessageId: 'wamid.1',
          deliveryErrorCode: null,
        }),
      },
    ])
    expect(r).toEqual({ reclamadas: 1, enviadas: 1, reprogramadas: 0, fallidas: 0, atoradas: 0 })
  })

  it('«De parte de» vacío usa el nombre del negocio', async () => {
    armar({ reclamadas: [reclamada({ purchaserName: null }), reclamada({ id: 'gc2', purchaserName: '   ' })] })
    wa.mockResolvedValue({ messageId: 'wamid.1' })

    await entregarTarjetas({ ahora: AHORA })

    expect(wa.mock.calls.map(c => c[1].deParteDe)).toEqual(['IQ Collection', 'IQ Collection'])
  })

  it('deParteDe se recorta a 60', async () => {
    const largo = 'L'.repeat(80)
    armar({ reclamadas: [reclamada({ purchaserName: largo })] })
    wa.mockResolvedValue({ messageId: 'wamid.1' })

    await entregarTarjetas({ ahora: AHORA })

    expect(wa.mock.calls[0][1].deParteDe).toBe('L'.repeat(60))
  })

  it('plantilla no disponible (132001) ⇒ FAILED en el intento 1 con deliveryErrorCode TEMPLATE_NOT_AVAILABLE y sin deliveryNextAttemptAt', async () => {
    armar({ reclamadas: [reclamada()] })
    wa.mockRejectedValue(new WhatsappCloudApiError('Error al enviar WhatsApp: template does not exist', 132001))

    const r = await entregarTarjetas({ ahora: AHORA })

    expect(escrituras()).toEqual([
      {
        where: { id: 'gc1', deliveryClaimedAt: RECLAMADO_EN, pageToken: 'tok' },
        data: expect.objectContaining({
          deliveryStatus: 'FAILED',
          deliveryErrorCode: 'TEMPLATE_NOT_AVAILABLE',
          deliveryNextAttemptAt: null,
        }),
      },
    ])
    expect(r.fallidas).toBe(1)
  })

  it.each([132015, 132016])('plantilla pausada o deshabilitada (%i) ⇒ FAILED sin reintentos', async code => {
    armar({ reclamadas: [reclamada()] })
    wa.mockRejectedValue(new WhatsappCloudApiError('Error al enviar WhatsApp: x', code))

    await entregarTarjetas({ ahora: AHORA })

    expect(escrituras()[0].data).toEqual(expect.objectContaining({ deliveryStatus: 'FAILED', deliveryErrorCode: 'TEMPLATE_NOT_AVAILABLE' }))
  })

  it('WhatsApp sin configurar ⇒ FAILED con TEMPLATE_NOT_AVAILABLE, sin intentar mandar', async () => {
    armar({ reclamadas: [reclamada()] })
    configurado.mockReturnValue(false)

    await entregarTarjetas({ ahora: AHORA })

    expect(wa).not.toHaveBeenCalled()
    expect(escrituras()[0].data).toEqual(
      expect.objectContaining({ deliveryStatus: 'FAILED', deliveryErrorCode: 'TEMPLATE_NOT_AVAILABLE', deliveryNextAttemptAt: null }),
    )
  })

  it('fallas transitorias ⇒ +1, +5 y +30 min; la 4.ª ⇒ FAILED con deliveryErrorCode WHATSAPP_SEND_FAILED', async () => {
    wa.mockRejectedValue(new Error('No se pudo enviar el mensaje de WhatsApp: socket hang up'))
    const datos = []
    for (const intento of [1, 2, 3, 4]) {
      armar({ reclamadas: [reclamada({ deliveryAttempts: intento })] })
      await entregarTarjetas({ ahora: AHORA })
      datos.push(escrituras()[0].data)
    }
    expect(datos.slice(0, 3)).toEqual(
      [60_000, 300_000, 1_800_000].map(ms =>
        expect.objectContaining({
          deliveryNextAttemptAt: new Date(AHORA.getTime() + ms),
          deliveryErrorCode: null,
          deliveryClaimedAt: null,
        }),
      ),
    )
    for (const d of datos.slice(0, 3)) expect(d).not.toHaveProperty('deliveryStatus')
    expect(datos[3]).toEqual(
      expect.objectContaining({ deliveryStatus: 'FAILED', deliveryErrorCode: 'WHATSAPP_SEND_FAILED', deliveryNextAttemptAt: null }),
    )
  })

  it('el resultado de un reclamo viejo no pisa la fila (CAS con deliveryClaimedAt Y pageToken); con count: 0 no lanza', async () => {
    armar({ reclamadas: [reclamada()] })
    prismaMock.giftCard.updateMany.mockResolvedValue({ count: 0 })
    wa.mockResolvedValue({ messageId: 'wamid.1' })

    const r = await entregarTarjetas({ ahora: AHORA })

    expect(escrituras()[0].where).toEqual({ id: 'gc1', deliveryClaimedAt: RECLAMADO_EN, pageToken: 'tok' })
    // Q43: si la fila conserva el reclamo (sólo cambió la liga), la entrega se reinicia; el `where` no lleva la liga.
    expect(escrituras()[1]).toEqual({
      where: { id: 'gc1', deliveryClaimedAt: RECLAMADO_EN },
      data: { deliveryClaimedAt: null, deliveryAttempts: 0, deliveryNextAttemptAt: null },
    })
    expect(r).toEqual({ reclamadas: 1, enviadas: 0, reprogramadas: 0, fallidas: 0, atoradas: 0 })
    expect(logger.warn).toHaveBeenCalled()
  })

  it('Q19: un FAILED deja logger.error con venueName y sin teléfono, correo ni pageToken', async () => {
    const token = 'Xk3pQ9vLmN2rT8wYz5aB7cD1eF4gH6jK0sU'
    armar({ reclamadas: [reclamada({ pageToken: token }), porCorreo({ id: 'gc2', pageToken: token })] })
    wa.mockRejectedValue(new WhatsappCloudApiError('Error al enviar WhatsApp: x', 132001))
    correo.mockResolvedValue({ ok: false, transient: false, errorCode: 'validation_error' })

    await entregarTarjetas({ ahora: AHORA })

    const errores = (logger.error as jest.Mock).mock.calls
    expect(errores.map(c => c[1])).toEqual([
      expect.objectContaining({
        venueId: 'v1',
        venueName: 'IQ Collection',
        giftCardId: 'gc1',
        canal: 'WHATSAPP',
        deliveryErrorCode: 'TEMPLATE_NOT_AVAILABLE',
      }),
      expect.objectContaining({
        venueId: 'v1',
        venueName: 'IQ Collection',
        giftCardId: 'gc2',
        canal: 'EMAIL',
        deliveryErrorCode: 'EMAIL_INVALID_ADDRESS',
      }),
    ])
    const texto = JSON.stringify(errores)
    for (const secreto of ['5512345678', 'ana@correo.mx', token]) expect(texto).not.toContain(secreto)
  })

  it('Q19: una excepción inesperada al entregar deja logger.error con venueName y sigue con la siguiente', async () => {
    armar({ reclamadas: [reclamada(), reclamada({ id: 'gc2' })] })
    wa.mockResolvedValue({ messageId: 'wamid.1' })
    prismaMock.giftCard.updateMany
      .mockRejectedValueOnce(new Error('Invalid `prisma.giftCard.updateMany()` invocation: pageToken: "tok"'))
      .mockResolvedValue({ count: 1 })

    const r = await entregarTarjetas({ ahora: AHORA })

    expect(r.enviadas).toBe(1)
    const [[, aviso]] = (logger.error as jest.Mock).mock.calls
    expect(aviso).toEqual(
      expect.objectContaining({ venueId: 'v1', venueName: 'IQ Collection', giftCardId: 'gc1', canal: 'WHATSAPP', deliveryErrorCode: null }),
    )
    expect(JSON.stringify(aviso)).not.toContain('tok')
  })

  it('nunca escribe pageToken ni código en el log', async () => {
    const token = 'Xk3pQ9vLmN2rT8wYz5aB7cD1eF4gH6jK0sU'
    armar({
      reclamadas: [
        reclamada({ pageToken: token }),
        reclamada({ id: 'gc2', pageToken: token }),
        porCorreo({ id: 'gc3', pageToken: token }),
        porCorreo({ id: 'gc4', pageToken: token }),
      ],
    })
    wa.mockResolvedValueOnce({ messageId: 'wamid.1' }).mockRejectedValueOnce(new Error(`fallo con ${token}`))
    correo.mockResolvedValueOnce({ ok: true, resendId: 're_1', transient: false }).mockResolvedValueOnce({ ok: false, transient: true })

    await entregarTarjetas({ ahora: AHORA })

    expect(todoLoQueSeLogueo()).not.toContain(token)
  })
})

describe('entregarTarjetas — correo', () => {
  it('correo aceptado ⇒ SENT con deliveryMessageId = resendId y la llave giftcard:gc1:auto:<huella>:1', async () => {
    armar({ reclamadas: [porCorreo()] })
    correo.mockResolvedValue({ ok: true, resendId: 're_1', transient: false })

    await entregarTarjetas({ ahora: AHORA })

    expect(correo).toHaveBeenCalledWith(
      'ana@correo.mx',
      {
        negocio: 'IQ Collection',
        monto: '$1,000.00',
        deParteDe: 'Luis',
        para: 'Ana',
        folio: 'JKMN',
        url: 'https://pay.avoqado.io/tarjeta/tok',
      },
      'giftcard:gc1:auto:' + h('tok') + ':1',
    )
    expect(escrituras()[0].data).toEqual(expect.objectContaining({ deliveryStatus: 'SENT', deliveryMessageId: 're_1' }))
  })

  it('tras un reenvío a mano la llave lleva la del reenvío; con otro pageToken y el mismo intento, otra llave', async () => {
    armar({ reclamadas: [porCorreo({ deliveryOperationKey: 'reenvia-abc' }), porCorreo({ id: 'gc1', pageToken: 'tok2' })] })
    correo.mockResolvedValue({ ok: true, resendId: 're_1', transient: false })

    await entregarTarjetas({ ahora: AHORA })

    expect(correo.mock.calls.map(c => c[2])).toEqual([
      'giftcard:gc1:reenvia-abc:' + h('tok') + ':1',
      'giftcard:gc1:auto:' + h('tok2') + ':1',
    ])
    expect(h('tok')).not.toBe(h('tok2'))
  })

  it('correo con transient=false ⇒ FAILED con EMAIL_INVALID_ADDRESS al primer intento', async () => {
    armar({ reclamadas: [porCorreo()] })
    correo.mockResolvedValue({ ok: false, transient: false, errorCode: 'UNDELIVERABLE_RECIPIENT' })

    await entregarTarjetas({ ahora: AHORA })

    expect(escrituras()[0].data).toEqual(
      expect.objectContaining({ deliveryStatus: 'FAILED', deliveryErrorCode: 'EMAIL_INVALID_ADDRESS', deliveryNextAttemptAt: null }),
    )
  })

  it('correo con transient=true ⇒ reprograma con deliveryErrorCode null; la 4.ª ⇒ EMAIL_SEND_FAILED', async () => {
    correo.mockResolvedValue({ ok: false, transient: true })
    armar({ reclamadas: [porCorreo({ deliveryAttempts: 1 })] })
    await entregarTarjetas({ ahora: AHORA })
    expect(escrituras()[0].data).toEqual({
      deliveryNextAttemptAt: new Date(AHORA.getTime() + 60_000),
      deliveryErrorCode: null,
      deliveryClaimedAt: null,
    })

    armar({ reclamadas: [porCorreo({ deliveryAttempts: 4 })] })
    await entregarTarjetas({ ahora: AHORA })
    expect(escrituras()[0].data).toEqual(expect.objectContaining({ deliveryStatus: 'FAILED', deliveryErrorCode: 'EMAIL_SEND_FAILED' }))
  })
})

describe('reclamo atorado en el 4.º intento', () => {
  it('reclamo atorado en el 4.º intento ⇒ FAILED con UNCONFIRMED (y su logger.error de Q19)', async () => {
    armar({ atoradas: [{ id: 'gc9', venueId: 'v1', deliveryChannel: 'EMAIL' }] })

    const r = await entregarTarjetas({ ahora: AHORA })

    const sql = prismaMock.$queryRaw.mock.calls.map(textoDe).find((t: string) => t.includes("'UNCONFIRMED'"))!
    expect(sql).toContain(`"deliveryStatus" = 'FAILED'`)
    expect(sql).toContain('"deliveryAttempts" >= ')
    expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(r).toEqual({ reclamadas: 0, enviadas: 0, reprogramadas: 0, fallidas: 0, atoradas: 1 })
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ venueName: 'IQ Collection', giftCardId: 'gc9', canal: 'EMAIL', deliveryErrorCode: 'UNCONFIRMED' }),
    )
  })

  it('sólo una atorada y nada más ⇒ hayEntregasPendientes da true y la vuelta la pasa a FAILED', async () => {
    // La lectura cuenta las reclamables O las atoradas: el `EXISTS` lleva las dos condiciones.
    prismaMock.$queryRaw.mockReset().mockResolvedValue([{ hay: true }])
    expect(await hayEntregasPendientes(AHORA)).toBe(true)
    const sql = textoDe(prismaMock.$queryRaw.mock.calls[0])
    expect(sql).toMatch(/EXISTS/)
    expect(sql).toContain('"deliveryAttempts" >= ')
    expect(sql).toContain('"deliveryAttempts" < ')

    armar({ atoradas: [{ id: 'gc9', venueId: 'v1', deliveryChannel: 'WHATSAPP' }] })
    const r = await entregarTarjetas({ ahora: AHORA })
    expect(r.atoradas).toBe(1)
  })
})

describe('Q103/Q105 — el aviso de fallo que llega antes de guardar', () => {
  it('marcarEntregaFallidaPorMensaje anota ANTES del updateMany y el CAS lleva deliveryMessageId y deliveryStatus SENT', async () => {
    prismaMock.giftCard.updateMany.mockReset().mockResolvedValue({ count: 0 })

    expect(await marcarEntregaFallidaPorMensaje('wamid.X')).toBe(false)

    const anotar = anotarFalloTemprano as jest.Mock
    expect(anotar).toHaveBeenCalledWith('wamid.X', 'WHATSAPP_UNDELIVERED')
    expect(anotar.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.giftCard.updateMany.mock.invocationCallOrder[0])
    expect(escrituras()).toEqual([
      {
        where: { deliveryMessageId: 'wamid.X', deliveryStatus: 'SENT' },
        data: { deliveryStatus: 'FAILED', deliveryErrorCode: 'WHATSAPP_UNDELIVERED' },
      },
    ])
  })

  it('tras escribir SENT con wamid.T y con wamid.T anotado ⇒ un segundo updateMany con ese CAS a FAILED y el logger.error de Q19', async () => {
    armar({ reclamadas: [reclamada()] })
    prismaMock.giftCard.findMany.mockResolvedValue([
      { id: 'gc1', venueId: 'v1', deliveryChannel: 'WHATSAPP', venue: { name: 'IQ Collection' } },
    ])
    // El aviso llega mientras el envío espera la respuesta de Meta: ninguna fila tiene aún el id.
    wa.mockImplementation(async () => {
      expect(await marcarEntregaFallidaPorMensaje('wamid.T')).toBe(false)
      return { messageId: 'wamid.T' }
    })
    prismaMock.giftCard.updateMany.mockReset().mockResolvedValueOnce({ count: 0 }).mockResolvedValue({ count: 1 })

    const r = await entregarTarjetas({ ahora: AHORA })

    expect(escrituras().map(w => [w.where, w.data.deliveryStatus])).toEqual([
      [{ deliveryMessageId: 'wamid.T', deliveryStatus: 'SENT' }, 'FAILED'],
      [{ id: 'gc1', deliveryClaimedAt: RECLAMADO_EN, pageToken: 'tok' }, 'SENT'],
      [{ deliveryMessageId: 'wamid.T', deliveryStatus: 'SENT' }, 'FAILED'],
    ])
    expect(escrituras()[2].data).toEqual({ deliveryStatus: 'FAILED', deliveryErrorCode: 'WHATSAPP_UNDELIVERED' })
    expect(r.fallidas).toBe(1)
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ venueName: 'IQ Collection', giftCardId: 'gc1', deliveryErrorCode: 'WHATSAPP_UNDELIVERED' }),
    )
  })

  it('sin aviso ⇒ ningún segundo updateMany', async () => {
    armar({ reclamadas: [reclamada()] })
    wa.mockResolvedValue({ messageId: 'wamid.T' })

    await entregarTarjetas({ ahora: AHORA })

    expect(escrituras()).toHaveLength(1)
  })

  it('con count: 0 (reclamo viejo) ⇒ no se consulta el mapa', async () => {
    armar({ reclamadas: [reclamada()] })
    anotarFalloTemprano('wamid.T', 'WHATSAPP_UNDELIVERED')
    wa.mockResolvedValue({ messageId: 'wamid.T' })
    prismaMock.giftCard.updateMany.mockResolvedValue({ count: 0 })

    await entregarTarjetas({ ahora: AHORA })

    expect(escrituras().some(w => w.where.deliveryMessageId)).toBe(false)
  })

  it('Q105: el correo re_T anotado con EMAIL_INVALID_ADDRESS ⇒ FAILED con ese código', async () => {
    armar({ reclamadas: [porCorreo()] })
    anotarFalloTemprano('re_T', 'EMAIL_INVALID_ADDRESS')
    correo.mockResolvedValue({ ok: true, resendId: 're_T', transient: false })

    const r = await entregarTarjetas({ ahora: AHORA })

    expect(escrituras()[1]).toEqual({
      where: { deliveryMessageId: 're_T', deliveryStatus: 'SENT' },
      data: { deliveryStatus: 'FAILED', deliveryErrorCode: 'EMAIL_INVALID_ADDRESS' },
    })
    expect(r.fallidas).toBe(1)
  })
})
