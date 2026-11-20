jest.mock('@/services/demo/candadoDemo', () => ({ omitirPorDemo: jest.fn().mockResolvedValue(null) }))
import { markSupportMessageReadTyping, sendServiceMessage } from '@/services/whatsapp.service'
import { omitirPorDemo } from '@/services/demo/candadoDemo'
import logger from '@/config/logger'
const options = { timeoutMs: 20000, safeSupportLogs: true }
const phone = '+525511112222',
  secretBody = 'Código privado 123456'
beforeEach(() => {
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'fixture-central'
  process.env.WHATSAPP_ACCESS_TOKEN = 'fixture-token'
  process.env.SUPPORT_WHATSAPP_PHONE_NUMBER_ID = 'fixture-support'
  delete process.env.SUPPORT_WHATSAPP_ACCESS_TOKEN
  delete process.env.WHATSAPP_SALES_PHONE_NUMBER_ID
})
it.each(['wamid.HBgNNTEyMzQ1Njc4OTABAgASGBQzQUE=', 'wamid.HBgNNTEyMzQ1Njc4OTABAgASGBQzQUE=='])(
  'accepts a provider opaque id with valid base64 padding: %s',
  async messageId => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ messages: [{ id: messageId }] }) })
    expect(await sendServiceMessage(phone, secretBody, options)).toEqual({ messageId })
  },
)
it('runs the final support guard after the asynchronous demo lookup, before fetch', async () => {
  let revoked = false
  ;(omitirPorDemo as jest.Mock).mockImplementationOnce(async () => {
    await Promise.resolve()
    revoked = true
    return null
  })
  global.fetch = jest.fn()
  await expect(
    sendServiceMessage(phone, secretBody, {
      ...options,
      beforeSend: async () => {
        if (revoked) throw new Error('SUPPORT_SEND_CANCELLED')
      },
    }),
  ).rejects.toThrow('SUPPORT_SEND_CANCELLED')
  expect(global.fetch).not.toHaveBeenCalled()
})
it.each([1499, 1500])('sends the exact complete %d-character message including its last step and source', async length => {
  const tail = '\nÚltimo paso revisado\nhttps://avoqado.io/help/dashboard/menu/gestionar-productos'
  const body = 'a'.repeat(length - tail.length) + tail
  const fetcher = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.fixture' }] }) })
  global.fetch = fetcher
  await (sendServiceMessage as any)(phone, body, options)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(JSON.parse(fetcher.mock.calls[0][1].body).text.body).toBe(body)
  expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
})
// T-F10c + T-F13: the sender's last guard is what any support text may measure: within the drafted cap (1,500) or, longer, the
// literal guide's SUPPORT_LITERAL_CAP (3,500; WhatsApp takes 4,096). The drafted cap is kept where drafted answers are composed
// (renderSupportAnswer). A paragraph «Importante:» bought 2,000 in T-F8.3; since T-F13 it buys nothing. Over 3,500 nothing is sent.
it.each([
  [1500, false, true],
  [1501, false, true],
  [3500, false, true],
  [3501, false, false],
  [2001, true, true],
  [3501, true, false],
])('a support text of %d characters (with an «Importante:» paragraph: %s) is sent: %s', async (length, important, sent) => {
  const block = important
    ? '\n\nImportante: Si no aparece, revisa que esté activo.'
    : '\nhttps://avoqado.io/help/dashboard/menu/gestionar-productos'
  const body = 'a'.repeat(length - block.length) + block
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.fixture' }] }) })
  const send = (sendServiceMessage as any)(phone, body, options)
  if (sent) await expect(send).resolves.toEqual({ messageId: 'wamid.fixture' })
  else await expect(send).rejects.toThrow()
  expect(global.fetch).toHaveBeenCalledTimes(sent ? 1 : 0)
})
it('rejects 3501 characters before fetch, rather than truncating the final step or source', async () => {
  global.fetch = jest.fn()
  await expect((sendServiceMessage as any)(phone, 'a'.repeat(3501), options)).rejects.toThrow()
  expect(global.fetch).not.toHaveBeenCalled()
})
it.each(['success', 'rejected', 'missing-wamid', 'transport'])(
  'does not log raw phone, body, code or provider response on %s',
  async kind => {
    global.fetch = jest.fn().mockImplementation(async () => {
      if (kind === 'transport') throw new Error(`${secretBody} ${phone}`)
      return {
        ok: kind !== 'rejected',
        status: kind === 'rejected' ? 400 : 200,
        json: async () =>
          kind === 'success'
            ? { messages: [{ id: 'wamid.fixture' }] }
            : { error: { code: 131047, message: `${secretBody} ${phone}` }, privateData: secretBody },
      }
    })
    const result = await (sendServiceMessage as any)(phone, secretBody, options).catch((e: Error) => e)
    const logged = JSON.stringify([
      (logger.info as jest.Mock).mock.calls,
      (logger.error as jest.Mock).mock.calls,
      (logger.warn as jest.Mock).mock.calls,
    ])
    for (const value of [phone, phone.slice(1), secretBody, '123456', 'privateData']) expect(logged).not.toContain(value)
    if (result instanceof Error) {
      expect(result.message).not.toContain(secretBody)
      expect(result.message).not.toContain(phone)
    }
    expect(global.fetch).toHaveBeenCalledTimes(1)
  },
)
it('a demo suppression is never reported as a real support delivery', async () => {
  ;(omitirPorDemo as jest.Mock).mockResolvedValueOnce('demo')
  global.fetch = jest.fn()
  await expect((sendServiceMessage as any)(phone, secretBody, options)).rejects.toThrow()
  expect(global.fetch).not.toHaveBeenCalled()
})
it('aborts once after twenty seconds and makes no implicit retry', async () => {
  jest.useFakeTimers()
  try {
    global.fetch = jest.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new TypeError('lost response')))
        }),
    ) as typeof fetch
    let settled = false
    const outcome = (sendServiceMessage as any)(phone, secretBody, options).then(
      () => {
        settled = true
        return null
      },
      (error: Error) => {
        settled = true
        return error
      },
    )
    await jest.advanceTimersByTimeAsync(19999)
    expect(settled).toBe(false)
    await jest.advanceTimersByTimeAsync(2)
    expect(await outcome).toBeInstanceOf(Error)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  } finally {
    jest.useRealTimers()
  }
})

// T-F14 (ruling T-P1): the support sends from its own number (SUPPORT_WHATSAPP_PHONE_NUMBER_ID), with its own token if set; the
// central sends (templates, relay, the old bot) are byte-identical to before.
describe('T-F14: which number a send leaves from', () => {
  const ok = () => jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.fixture' }] }) })
  it('a support send posts to the support number, with the central token when the support has none', async () => {
    const fetcher = ok()
    global.fetch = fetcher
    await sendServiceMessage(phone, secretBody, options)
    expect(fetcher.mock.calls[0][0]).toBe('https://graph.facebook.com/v21.0/fixture-support/messages')
    expect(fetcher.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer fixture-token' })
  })
  it('a support send uses the support token when it is set', async () => {
    process.env.SUPPORT_WHATSAPP_ACCESS_TOKEN = 'fixture-support-token'
    const fetcher = ok()
    global.fetch = fetcher
    await sendServiceMessage(phone, secretBody, options)
    expect(fetcher.mock.calls[0][0]).toBe('https://graph.facebook.com/v21.0/fixture-support/messages')
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer fixture-support-token')
  })
  it.each([
    ['unset', undefined],
    ['equal to the central', 'fixture-central'],
    ['equal to sales', 'fixture-sales'],
  ])('a support send with the support number %s never leaves, not even from the central', async (_case, value) => {
    process.env.WHATSAPP_SALES_PHONE_NUMBER_ID = 'fixture-sales'
    if (value === undefined) delete process.env.SUPPORT_WHATSAPP_PHONE_NUMBER_ID
    else process.env.SUPPORT_WHATSAPP_PHONE_NUMBER_ID = value
    global.fetch = jest.fn()
    await expect(sendServiceMessage(phone, secretBody, options)).rejects.toThrow()
    expect(global.fetch).not.toHaveBeenCalled()
  })
  it('a central send is byte-identical: central number, central token, same body, even with a support token set', async () => {
    process.env.SUPPORT_WHATSAPP_ACCESS_TOKEN = 'fixture-support-token'
    const fetcher = ok()
    global.fetch = fetcher
    await sendServiceMessage(phone, 'Hola, tu reservación está confirmada.')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]).toEqual([
      'https://graph.facebook.com/v21.0/fixture-central/messages',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-token' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: '525511112222',
          type: 'text',
          text: { body: 'Hola, tu reservación está confirmada.' },
        }),
      },
    ])
  })
  it('the typing indicator goes from the support number, with the support token', async () => {
    process.env.SUPPORT_WHATSAPP_ACCESS_TOKEN = 'fixture-support-token'
    const fetcher = jest.fn().mockResolvedValue({ ok: true, status: 200 })
    global.fetch = fetcher
    await markSupportMessageReadTyping('wamid.inbound')
    expect(fetcher.mock.calls[0][0]).toBe('https://graph.facebook.com/v21.0/fixture-support/messages')
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer fixture-support-token')
    delete process.env.SUPPORT_WHATSAPP_PHONE_NUMBER_ID
    fetcher.mockClear()
    await markSupportMessageReadTyping('wamid.inbound')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
