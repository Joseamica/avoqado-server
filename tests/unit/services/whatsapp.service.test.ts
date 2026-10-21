import {
  CODIGOS_DE_PLANTILLA_NO_DISPONIBLE,
  sendGiftCardDeliveryWhatsApp,
  sendReceiptWhatsApp,
  sendReservationConfirmationWhatsApp,
  sendReservationReminderWhatsApp,
  sendServiceMessage,
  sendVenueChatTemplate,
  WhatsappCloudApiError,
  whatsappConfigurado,
} from '@/services/whatsapp.service'

describe('sendReceiptWhatsApp (backward-compat after refactor)', () => {
  beforeEach(() => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-phone-id'
    process.env.WHATSAPP_ACCESS_TOKEN = 'test-token'
  })

  it('still returns boolean true on success', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.TEST123' }] }),
    }) as unknown as typeof global.fetch
    const result = await sendReceiptWhatsApp('+525512345678', {
      venueName: 'Test',
      totalAmount: '100',
      receiptUrl: 'https://x.io/r',
    })
    expect(result).toBe(true)
  })

  it('still throws on Cloud API failure', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'bad number' } }),
    }) as unknown as typeof global.fetch
    await expect(
      sendReceiptWhatsApp('+525512345678', { venueName: 'T', totalAmount: '100', receiptUrl: 'https://x.io/r' }),
    ).rejects.toThrow(/Error al enviar WhatsApp/)
  })
})

describe('sendVenueChatTemplate', () => {
  beforeEach(() => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-phone-id'
    process.env.WHATSAPP_ACCESS_TOKEN = 'test-token'
  })

  it('sends v2 template with all 5 variables and returns messageId', async () => {
    let capturedBody: any
    global.fetch = jest.fn().mockImplementation(async (_url, opts: any) => {
      capturedBody = JSON.parse(opts.body)
      return {
        ok: true,
        json: async () => ({ messages: [{ id: 'wamid.VENUE_CHAT_123' }] }),
      }
    }) as unknown as typeof global.fetch

    const result = await sendVenueChatTemplate('+525512345678', {
      venueName: 'Gym Pavón',
      customerName: 'Juan',
      shortCode: 'A3F2',
      flowLabel: 'Citas',
      messageBody: 'Hola',
    })

    expect(result.messageId).toBe('wamid.VENUE_CHAT_123')
    expect(capturedBody.template.name).toBe('venue_new_customer_message_v2')
    const params = capturedBody.template.components[0].parameters
    expect(params[0].text).toBe('Gym Pavón')
    expect(params[1].text).toBe('Juan')
    expect(params[2].text).toBe('A3F2')
    expect(params[3].text).toBe('Citas')
    expect(params[4].text).toBe('Hola')
  })

  it('sanitizes user-provided text (strips URLs, control chars, caps length)', async () => {
    let capturedBody: any
    global.fetch = jest.fn().mockImplementation(async (_url, opts: any) => {
      capturedBody = JSON.parse(opts.body)
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.X' }] }) }
    }) as unknown as typeof global.fetch

    await sendVenueChatTemplate('+525512345678', {
      venueName: 'Venue',
      customerName: 'Juan\nMalicioso',
      shortCode: 'ABCD',
      flowLabel: 'Citas',
      messageBody: 'visita https://evil.com hoy',
    })

    const params = capturedBody.template.components[0].parameters
    expect(params[1].text).toBe('Juan Malicioso')
    expect(params[4].text).toBe('visita [enlace] hoy')
  })
})

describe('reservation manage-button (gated on env + cancelSecret)', () => {
  beforeEach(() => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-phone-id'
    process.env.WHATSAPP_ACCESS_TOKEN = 'test-token'
    delete process.env.WHATSAPP_TEMPLATE_RESERVATION_CONFIRMATION_MANAGE
    delete process.env.WHATSAPP_TEMPLATE_RESERVATION_REMINDER_MANAGE
  })

  const baseData = {
    customerName: 'Catalina',
    venueName: 'Amaena',
    date: '03/06/2026',
    time: '11:30',
    venueSlug: 'amaena',
    cancelSecret: 'a8a9aa9c-9912-4382-840c-c02f642543a7',
  }

  it('CONFIRMATION: uses manage template + URL button when env set and cancelSecret present', async () => {
    process.env.WHATSAPP_TEMPLATE_RESERVATION_CONFIRMATION_MANAGE = 'reservation_confirmation_manage'
    let capturedBody: any
    global.fetch = jest.fn().mockImplementation(async (_url, opts: any) => {
      capturedBody = JSON.parse(opts.body)
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.CONF_MANAGE' }] }) }
    }) as unknown as typeof global.fetch

    const ok = await sendReservationConfirmationWhatsApp('+525591986192', { ...baseData, extras: 'Gel semipermanente' })
    expect(ok).toBe(true)
    expect(capturedBody.template.name).toBe('reservation_confirmation_manage')
    // Body: 5 params, extras carried through
    const body = capturedBody.template.components.find((c: any) => c.type === 'body')
    expect(body.parameters).toHaveLength(5)
    expect(body.parameters[4].text).toBe('Gel semipermanente')
    // Button: dynamic URL suffix is "<slug>?manage=<encoded secret>"
    const button = capturedBody.template.components.find((c: any) => c.type === 'button')
    expect(button.sub_type).toBe('url')
    expect(button.index).toBe('0')
    expect(button.parameters[0].text).toBe('amaena?manage=a8a9aa9c-9912-4382-840c-c02f642543a7')
  })

  it('CONFIRMATION: fills extras with "—" when none so a single manage template covers both cases', async () => {
    process.env.WHATSAPP_TEMPLATE_RESERVATION_CONFIRMATION_MANAGE = 'reservation_confirmation_manage'
    let capturedBody: any
    global.fetch = jest.fn().mockImplementation(async (_url, opts: any) => {
      capturedBody = JSON.parse(opts.body)
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.X' }] }) }
    }) as unknown as typeof global.fetch

    await sendReservationConfirmationWhatsApp('+525591986192', { ...baseData, extras: '' })
    const body = capturedBody.template.components.find((c: any) => c.type === 'body')
    expect(body.parameters[4].text).toBe('—')
  })

  it('CONFIRMATION: falls back to legacy template (no button) when env var is NOT set', async () => {
    let capturedBody: any
    global.fetch = jest.fn().mockImplementation(async (_url, opts: any) => {
      capturedBody = JSON.parse(opts.body)
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.X' }] }) }
    }) as unknown as typeof global.fetch

    await sendReservationConfirmationWhatsApp('+525591986192', { ...baseData, extras: 'Gel' })
    expect(capturedBody.template.name).toBe('reservation_confirmation_with_extras')
    expect(capturedBody.template.components.some((c: any) => c.type === 'button')).toBe(false)
  })

  it('CONFIRMATION: falls back (no button) when env set but cancelSecret missing', async () => {
    process.env.WHATSAPP_TEMPLATE_RESERVATION_CONFIRMATION_MANAGE = 'reservation_confirmation_manage'
    let capturedBody: any
    global.fetch = jest.fn().mockImplementation(async (_url, opts: any) => {
      capturedBody = JSON.parse(opts.body)
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.X' }] }) }
    }) as unknown as typeof global.fetch

    await sendReservationConfirmationWhatsApp('+525591986192', { ...baseData, cancelSecret: null, extras: '' })
    expect(capturedBody.template.name).toBe('reservation_confirmation')
    expect(capturedBody.template.components.some((c: any) => c.type === 'button')).toBe(false)
  })

  it('REMINDER: uses manage template + URL button when env set and cancelSecret present', async () => {
    process.env.WHATSAPP_TEMPLATE_RESERVATION_REMINDER_MANAGE = 'reservation_reminder_manage'
    let capturedBody: any
    global.fetch = jest.fn().mockImplementation(async (_url, opts: any) => {
      capturedBody = JSON.parse(opts.body)
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.REM_MANAGE' }] }) }
    }) as unknown as typeof global.fetch

    const ok = await sendReservationReminderWhatsApp('+525591986192', baseData)
    expect(ok).toBe(true)
    expect(capturedBody.template.name).toBe('reservation_reminder_manage')
    const button = capturedBody.template.components.find((c: any) => c.type === 'button')
    expect(button.parameters[0].text).toBe('amaena?manage=a8a9aa9c-9912-4382-840c-c02f642543a7')
  })

  it('REMINDER: falls back to plain reminder (no button) when env var is NOT set', async () => {
    let capturedBody: any
    global.fetch = jest.fn().mockImplementation(async (_url, opts: any) => {
      capturedBody = JSON.parse(opts.body)
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.X' }] }) }
    }) as unknown as typeof global.fetch

    await sendReservationReminderWhatsApp('+525591986192', baseData)
    expect(capturedBody.template.name).toBe('reservation_reminder')
    expect(capturedBody.template.components.some((c: any) => c.type === 'button')).toBe(false)
  })
})

describe('sendServiceMessage', () => {
  beforeEach(() => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-phone-id'
    process.env.WHATSAPP_ACCESS_TOKEN = 'test-token'
  })

  it('sends a non-template text message and returns messageId', async () => {
    let capturedBody: any
    global.fetch = jest.fn().mockImplementation(async (_url, opts: any) => {
      capturedBody = JSON.parse(opts.body)
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.SVC_1' }] }) }
    }) as unknown as typeof global.fetch

    const result = await sendServiceMessage('+525512345678', 'hola')
    expect(result.messageId).toBe('wamid.SVC_1')
    expect(capturedBody.type).toBe('text')
    expect(capturedBody.text.body).toBe('hola')
  })

  it('truncates messages over 1500 chars', async () => {
    let capturedBody: any
    global.fetch = jest.fn().mockImplementation(async (_url, opts: any) => {
      capturedBody = JSON.parse(opts.body)
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.X' }] }) }
    }) as unknown as typeof global.fetch

    await sendServiceMessage('+525512345678', 'a'.repeat(2000))
    expect(capturedBody.text.body.endsWith('… [mensaje truncado]')).toBe(true)
    expect(capturedBody.text.body.length).toBeLessThanOrEqual(1500 + ' … [mensaje truncado]'.length)
  })

  it('surfaces Cloud API window-closed errors as WhatsappCloudApiError with code', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: 131047, message: 'Re-engagement message' } }),
    }) as unknown as typeof global.fetch

    let caught: unknown
    try {
      await sendServiceMessage('+525512345678', 'hi')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(WhatsappCloudApiError)
    expect((caught as WhatsappCloudApiError).message).toContain('Re-engagement')
    expect((caught as WhatsappCloudApiError).cloudApiErrorCode).toBe(131047)
  })
})

describe('tarjetas de regalo (1b S3)', () => {
  const D = { negocio: 'IQ Collection', monto: '$1,000.00', deParteDe: 'Luis', folio: 'JKMN', pageToken: 'tok' }
  const plantillaOriginal = process.env.WHATSAPP_TEMPLATE_GIFT_CARD_DELIVERY

  beforeEach(() => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-phone-id'
    process.env.WHATSAPP_ACCESS_TOKEN = 'test-token'
    delete process.env.WHATSAPP_TEMPLATE_GIFT_CARD_DELIVERY
  })
  afterAll(() => {
    if (plantillaOriginal === undefined) delete process.env.WHATSAPP_TEMPLATE_GIFT_CARD_DELIVERY
    else process.env.WHATSAPP_TEMPLATE_GIFT_CARD_DELIVERY = plantillaOriginal
  })

  function capturar() {
    const enviado: { body?: any } = {}
    global.fetch = jest.fn().mockImplementation(async (_url, opts: any) => {
      enviado.body = JSON.parse(opts.body)
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.GC' }] }) }
    }) as unknown as typeof global.fetch
    return enviado
  }

  it('sendTemplateMessage lanza WhatsappCloudApiError con cloudApiErrorCode (y el mensaje sigue empezando con «Error al enviar WhatsApp»)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: 132001, message: 'Template name does not exist in the translation' } }),
    }) as unknown as typeof global.fetch

    const caught = await sendGiftCardDeliveryWhatsApp('5512345678', D).catch((e: unknown) => e)

    expect(caught).toBeInstanceOf(WhatsappCloudApiError)
    expect((caught as WhatsappCloudApiError).cloudApiErrorCode).toBe(132001)
    expect((caught as Error).message).toMatch(/^Error al enviar WhatsApp/)
    expect(CODIGOS_DE_PLANTILLA_NO_DISPONIBLE.has(132001)).toBe(true)
  })

  it('las plantillas pausada (132015) y deshabilitada (132016) también son «no disponible»', () => {
    expect([...CODIGOS_DE_PLANTILLA_NO_DISPONIBLE].sort()).toEqual([132001, 132015, 132016])
  })

  it('sendGiftCardDeliveryWhatsApp usa gift_card_delivery es_MX con 4 parámetros y el botón', async () => {
    const enviado = capturar()

    const r = await sendGiftCardDeliveryWhatsApp('5512345678', D)

    expect(r).toEqual({ messageId: 'wamid.GC' })
    expect(enviado.body.to).toBe('525512345678')
    expect(enviado.body.template.name).toBe('gift_card_delivery')
    expect(enviado.body.template.language).toEqual({ code: 'es_MX' })
    expect(enviado.body.template.components).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'IQ Collection' },
          { type: 'text', text: '$1,000.00' },
          { type: 'text', text: 'Luis' },
          { type: 'text', text: 'JKMN' },
        ],
      },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'tok' }] },
    ])
  })

  it('el nombre sale de WHATSAPP_TEMPLATE_GIFT_CARD_DELIVERY', async () => {
    process.env.WHATSAPP_TEMPLATE_GIFT_CARD_DELIVERY = 'gift_card_delivery_v2'
    const enviado = capturar()

    await sendGiftCardDeliveryWhatsApp('5512345678', D)

    expect(enviado.body.template.name).toBe('gift_card_delivery_v2')
  })

  it('«de parte de» se recorta a 60 y sin saltos de línea (Meta rechaza los parámetros con saltos)', async () => {
    const enviado = capturar()

    await sendGiftCardDeliveryWhatsApp('5512345678', { ...D, deParteDe: 'Luis\ny Ana ' + 'x'.repeat(80) })

    const texto = enviado.body.template.components[0].parameters[2].text
    expect(texto.length).toBeLessThanOrEqual(60)
    expect(texto).not.toMatch(/\n/)
  })

  it('I1: la entrega de la tarjeta corta a los 20 s y el aborto sale como fallo de red (transitorio), no como error de Meta', async () => {
    const corte = new AbortController()
    const tope = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(corte.signal)
    // Un Meta colgado: la petición sólo termina cuando su `signal` la aborta.
    global.fetch = jest.fn(
      (_url, opts: any) => new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason))),
    ) as unknown as typeof global.fetch

    let caught: unknown
    let topes: unknown[][] = []
    try {
      const enVuelo = sendGiftCardDeliveryWhatsApp('5512345678', D).catch((e: unknown) => e)
      corte.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
      caught = await enVuelo
      topes = [...tope.mock.calls] // `mockRestore` borra las llamadas
    } finally {
      tope.mockRestore()
    }

    expect(topes).toEqual([[20_000]])
    expect(caught).not.toBeInstanceOf(WhatsappCloudApiError)
    expect((caught as Error).message).toBe('No se pudo enviar el mensaje de WhatsApp: The operation was aborted due to timeout')
  })

  it('I1: los demás envíos de plantilla siguen sin tope propio (sin signal)', async () => {
    const tope = jest.spyOn(AbortSignal, 'timeout')
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: 'wamid.R' }] }) })
    global.fetch = fetchMock as unknown as typeof global.fetch

    let topes: unknown[][] = []
    try {
      await sendReceiptWhatsApp('5512345678', { venueName: 'T', totalAmount: '100', receiptUrl: 'https://x.io/r' })
      await sendReservationReminderWhatsApp('5512345678', { customerName: 'Ana', venueName: 'T', date: 'hoy', time: '10:00' })
      topes = [...tope.mock.calls] // `mockRestore` borra las llamadas
    } finally {
      tope.mockRestore()
    }

    expect(topes).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [, opts] of fetchMock.mock.calls) expect(opts).not.toHaveProperty('signal')
  })

  it('whatsappConfigurado refleja las dos variables', () => {
    expect(whatsappConfigurado()).toBe(true)
    delete process.env.WHATSAPP_ACCESS_TOKEN
    expect(whatsappConfigurado()).toBe(false)
  })
})
