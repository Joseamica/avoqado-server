/**
 * Guardar lo que DiDi manda, antes de intentar entenderlo.
 */
import crypto from 'crypto'
import { DeliveryProvider } from '@prisma/client'

import prisma from '../../../../src/utils/prismaClient'
import { persistDidiWebhookEvent } from '../../../../src/services/delivery-channels/providers/didi-food/didi.webhookIngress'

const SECRETO = 'b0919c644bddc031c59288884954cf5c'
const ID_PEDIDO = '5764607801871631353'

/**
 * 🔴 El sobre se arma como TEXTO CRUDO, no con `JSON.stringify`.
 *
 * Un literal numérico como `5764607801871631353` en JavaScript YA viene redondeado antes de
 * que `JSON.stringify` lo toque: el fixture se corrompería solo y el test pasaría por la
 * razón equivocada. (Pasó en el primer intento: comparaba 5764607801871631000 contra sí
 * mismo.) Así llega de verdad el webhook: bytes con todos los dígitos.
 */
function sobre(opts: { type?: string; timestamp?: number; appShopId?: string } = {}): Buffer {
  const tipo = opts.type ?? 'orderNew'
  const ts = opts.timestamp ?? 1615432308
  const tienda = opts.appShopId ?? 'venue-abc'
  return Buffer.from(
    `{"app_id":5764607584567296012,"app_shop_id":"${tienda}","type":"${tipo}","timestamp":${ts},` + `"data":{"order_id":${ID_PEDIDO}}}`,
    'utf8',
  )
}

const firmar = (b: Buffer) =>
  crypto
    .createHash('md5')
    .update(Buffer.concat([b, Buffer.from(SECRETO, 'utf8')]))
    .digest('hex')

describe('persistDidiWebhookEvent', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue({ id: 'link1', venueId: 'venue1' })
    ;(prisma.deliveryOrderEvent.create as jest.Mock).mockResolvedValue({ id: 'evt1' })
  })

  it('firma inválida → ni siquiera se lee el cuerpo', async () => {
    const b = sobre()
    const r = await persistDidiWebhookEvent({ rawBody: b, signatureHeader: 'a'.repeat(32), appSecret: SECRETO })

    expect(r.outcome).toBe('INVALID_SIGNATURE')
    expect(prisma.deliveryOrderEvent.create).not.toHaveBeenCalled()
    expect(prisma.deliveryChannelLink.findUnique).not.toHaveBeenCalled()
  })

  // ── El id del pedido, que es lo que no se puede perder ─────────────────────────────
  it('🔴 guarda el order_id de 64 bits EXACTO, sin redondear', async () => {
    const b = sobre()
    await persistDidiWebhookEvent({ rawBody: b, signatureHeader: firmar(b), appSecret: SECRETO })

    const data = (prisma.deliveryOrderEvent.create as jest.Mock).mock.calls[0][0].data
    expect(data.externalOrderId).toBe(ID_PEDIDO)
    // Y también dentro del payload guardado: si ahí se rompiera, la evidencia quedaría mal
    // y nadie lo notaría hasta conciliar.
    expect(String(data.payload.data.order_id)).toBe(ID_PEDIDO)
  })

  it('resuelve el venue por app_shop_id — el id que NOSOTROS elegimos al ligar la tienda', async () => {
    const b = sobre()
    await persistDidiWebhookEvent({ rawBody: b, signatureHeader: firmar(b), appSecret: SECRETO })

    expect(prisma.deliveryChannelLink.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider_externalLocationId: { provider: DeliveryProvider.DIDI_FOOD, externalLocationId: 'venue-abc' } },
      }),
    )
    const data = (prisma.deliveryOrderEvent.create as jest.Mock).mock.calls[0][0].data
    expect(data.venueId).toBe('venue1')
  })

  it('🔴 una tienda DESCONOCIDA igual se guarda, con venue nulo', async () => {
    // Un pedido que el cliente ya pagó no se tira porque no encontremos su venue. Queda
    // guardado y reprocesable.
    ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue(null)
    const b = sobre()

    const r = await persistDidiWebhookEvent({ rawBody: b, signatureHeader: firmar(b), appSecret: SECRETO })

    expect(r.outcome).toBe('STORED')
    const data = (prisma.deliveryOrderEvent.create as jest.Mock).mock.calls[0][0].data
    expect(data.venueId).toBeNull()
    expect(data.externalOrderId).toBe(ID_PEDIDO)
  })

  // ── Deduplicar sin id de evento ────────────────────────────────────────────────────
  it('🔴 el REINTENTO del mismo aviso se deduplica (misma clave)', async () => {
    // DiDi reintenta cuando no alcanza a leer nuestro `errno:0`. El mismo aviso trae el
    // mismo timestamp, así que la clave coincide.
    const b = sobre()
    await persistDidiWebhookEvent({ rawBody: b, signatureHeader: firmar(b), appSecret: SECRETO })
    const primera = (prisma.deliveryOrderEvent.create as jest.Mock).mock.calls[0][0].data.dedupKey

    ;(prisma.deliveryOrderEvent.create as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }))
    const r = await persistDidiWebhookEvent({ rawBody: b, signatureHeader: firmar(b), appSecret: SECRETO })

    expect(r.outcome).toBe('DUPLICATE')
    expect(primera).toBe(`DIDI_FOOD:orderNew:${ID_PEDIDO}:1615432308`)
  })

  it('🔴 pero los 6 avisos de orderCancelApply NO se pisan entre sí', async () => {
    // `orderCancelApply` llega 6 veces cada 2 min y `orderRefundApply` 25 veces cada hora:
    // son avisos DISTINTOS del mismo pedido. Si la clave los colapsara, perderíamos el
    // rastro de que el cliente insistió — y con el reembolso eso es dinero.
    const uno = sobre({ type: 'orderCancelApply', timestamp: 1615432308 })
    const dos = sobre({ type: 'orderCancelApply', timestamp: 1615432428 })

    await persistDidiWebhookEvent({ rawBody: uno, signatureHeader: firmar(uno), appSecret: SECRETO })
    await persistDidiWebhookEvent({ rawBody: dos, signatureHeader: firmar(dos), appSecret: SECRETO })

    const llaves = (prisma.deliveryOrderEvent.create as jest.Mock).mock.calls.map(c => c[0].data.dedupKey)
    expect(llaves[0]).not.toBe(llaves[1])
  })

  // ── Tipos nuevos ───────────────────────────────────────────────────────────────────
  it('🔴 un `type` DESCONOCIDO se guarda igual — DiDi avisa que agregará eventos', async () => {
    const b = sobre({ type: 'orderSomethingNuevo' })
    const r = await persistDidiWebhookEvent({ rawBody: b, signatureHeader: firmar(b), appSecret: SECRETO })

    expect(r.outcome).toBe('STORED')
    expect((prisma.deliveryOrderEvent.create as jest.Mock).mock.calls[0][0].data.eventType).toBe('orderSomethingNuevo')
  })

  it('sin `type` sí se descarta — no hay nada que hacer con eso', async () => {
    const b = Buffer.from(JSON.stringify({ app_id: 1, data: {} }), 'utf8')
    const r = await persistDidiWebhookEvent({ rawBody: b, signatureHeader: firmar(b), appSecret: SECRETO })

    expect(r.outcome).toBe('MALFORMED')
    expect(prisma.deliveryOrderEvent.create).not.toHaveBeenCalled()
  })

  it('JSON inválido → MALFORMED, no una excepción que tumbe el endpoint', async () => {
    const b = Buffer.from('{no soy json', 'utf8')
    const r = await persistDidiWebhookEvent({ rawBody: b, signatureHeader: firmar(b), appSecret: SECRETO })

    expect(r.outcome).toBe('MALFORMED')
  })

  it('un fallo de base que NO sea duplicado se propaga — ahí sí queremos que DiDi reintente', async () => {
    ;(prisma.deliveryOrderEvent.create as jest.Mock).mockRejectedValueOnce(new Error('la base no responde'))
    const b = sobre()

    await expect(persistDidiWebhookEvent({ rawBody: b, signatureHeader: firmar(b), appSecret: SECRETO })).rejects.toThrow()
  })
})
