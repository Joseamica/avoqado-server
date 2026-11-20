jest.mock('@/services/whatsappWebhook.service', () => ({ processWhatsappWebhook: jest.fn() }))
import { handleWhatsappInbound } from '@/controllers/webhook/whatsapp.webhook.controller'
import { processWhatsappWebhook } from '@/services/whatsappWebhook.service'
import logger from '@/config/logger'
import { WhatsappCloudApiError } from '@/services/whatsapp.service'

it.each(['parser', 'service'])('keeps raw question/credential text out of the %s error log', async path => {
  const secret = 'PRIVATE_QUESTION_PIN_123456'
  const req = { body: Buffer.from(path === 'parser' ? `{ ${secret}` : '{}') } as any
  if (path === 'service') (processWhatsappWebhook as jest.Mock).mockRejectedValueOnce(new Error(secret))
  const res = { sendStatus: jest.fn() } as any
  await handleWhatsappInbound(req, res)
  expect(res.sendStatus).toHaveBeenCalledWith(500)
  expect(logger.error).toHaveBeenCalled()
  expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain(secret)
})

// T-F25 (W11): a failed delivery says its cause (Meta's HTTP status and code, or the network's code), never its text or a phone.
describe('the delivery failure says its cause', () => {
  const phone = '+5215512345678'
  async function logged(err: unknown) {
    ;(processWhatsappWebhook as jest.Mock).mockRejectedValueOnce(err)
    ;(logger.error as jest.Mock).mockClear()
    const res = { sendStatus: jest.fn() } as any
    await handleWhatsappInbound({ body: Buffer.from('{}') } as any, res)
    expect(res.sendStatus).toHaveBeenCalledWith(500)
    const calls = (logger.error as jest.Mock).mock.calls
    expect(JSON.stringify(calls)).not.toContain(phone)
    expect(JSON.stringify(calls)).not.toContain('5512345678')
    return calls[0][1]
  }
  it('Meta rejected it: its HTTP status and error code', async () => {
    const err = new WhatsappCloudApiError(`Error al enviar WhatsApp: (#131047) Re-engagement message to ${phone}`, 131047, 400)
    expect(await logged(err)).toEqual({ code: 'DELIVERY_FAILED', status: 400, metaCode: 131047 })
  })
  it('the network failed: its code, not its message', async () => {
    // What undici's fetch throws when the connection is refused (the tests' lib has no `{ cause }` constructor option).
    const err = Object.assign(new TypeError(`fetch failed ${phone}`), {
      cause: Object.assign(new Error(`connect ECONNREFUSED ${phone}`), { code: 'ECONNREFUSED' }),
    })
    expect(await logged(err)).toEqual({ code: 'DELIVERY_FAILED', cause: 'ECONNREFUSED' })
  })
  it('anything that does not look like a status or a code stays out', async () => {
    const err = Object.assign(new Error(phone), { httpStatus: phone, cloudApiErrorCode: 1.5, cause: { code: `x ${phone}` } })
    expect(await logged(err)).toEqual({ code: 'DELIVERY_FAILED' })
  })
})
