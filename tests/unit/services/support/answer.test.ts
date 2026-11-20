import { Prisma } from '@prisma/client'
import { createSupportAiClient, selectSections, composeSupportAnswer, supportWarnings } from '@/services/support/answer.service'
import { resolvePermissions } from '@/lib/permissions'
import { LUNA_SUPPORT_PRICING as pricing } from '@/config/supportWhatsapp'
import { SUPPORT_GUIDE_TOO_LONG, SUPPORT_LINK, SUPPORT_LITERAL_CAP, SUPPORT_NO_COVERAGE } from '@/services/support/texts'
import type { VerifiedSection } from '@/services/support/knowledge.service'
import type { HelpAccess } from '@/services/support/access.service'

const guide: VerifiedSection = {
  id: 'dashboard/menu/gestionar-productos',
  app: 'dashboard',
  title: 'Guía de prueba',
  summary: 'Resumen verificado de prueba.',
  steps: ['Paso verificado uno.', 'Paso verificado dos.'],
  publicUrl: 'https://avoqado.io/help/dashboard/menu/gestionar-productos',
  requiredPermissions: ['menu:update'],
  keywords: [],
}
const config = { apiKey: 'fixture-only', monthlyLimitUsd: new Prisma.Decimal('1'), pricing }
const input = { topic: '¿Cómo lo hago?', candidates: [guide], history: [] }
const usage = { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }
function clientReturning(text: string, status = 'completed') {
  const fetcher = jest.fn(
    async (..._args: unknown[]) =>
      new Response(
        JSON.stringify({
          id: 'resp_fixture',
          model: pricing.model,
          status,
          usage,
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }],
        }),
        { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req_fixture' } },
      ),
  )
  return { client: createSupportAiClient(config, fetcher as unknown as typeof fetch), fetcher }
}
it('uses an isolated SDK client with no retries and a twenty second timeout', () => {
  const { client } = clientReturning('{}')
  expect(client.maxRetries).toBe(0)
  expect(client.timeout).toBe(20000)
})
it('captures the real SDK request and accepts only a candidate ID, never free-form operating instructions', async () => {
  const { client, fetcher } = clientReturning(JSON.stringify({ sectionIds: [guide.id], needsClarification: false }))
  expect(await selectSections(client, input, pricing)).toMatchObject({
    sectionIds: [guide.id],
    valid: true,
    needsClarification: false,
    usage,
  })
  expect(fetcher).toHaveBeenCalledTimes(1)
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
  expect(String(url)).toBe('https://api.openai.com/v1/responses')
  const body = JSON.parse(String(init.body))
  expect(body).toMatchObject({
    model: pricing.model,
    store: false,
    stream: false,
    background: false,
    max_output_tokens: 1000,
    service_tier: 'default',
    truncation: 'disabled',
    text: { format: { type: 'json_schema', strict: true } },
  })
  for (const key of ['tools', 'previous_response_id', 'metadata', 'user']) expect(body).not.toHaveProperty(key)
  expect(body.text.format.schema.properties.sectionIds.items.enum).toEqual([guide.id])
})
it.each([
  ['not json', 'completed'],
  [JSON.stringify({ sectionIds: ['dashboard/private/other'], needsClarification: false }), 'completed'],
  [JSON.stringify({ sectionIds: [guide.id], needsClarification: false, answer: 'Ya cobré la tarjeta.' }), 'completed'],
  [JSON.stringify({ sectionIds: [guide.id], needsClarification: false }), 'incomplete'],
])('rejects untrusted model output %s / %s while preserving numeric usage', async (text, status) => {
  const { client, fetcher } = clientReturning(text, status)
  const result = await selectSections(client, input, pricing)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(result).toMatchObject({ valid: false, sectionIds: [], needsClarification: true, usage })
  expect(JSON.stringify(result)).not.toContain('Ya cobré')
})
it('a lost provider response results in one fetch, without an implicit retry', async () => {
  const fetcher = jest.fn(async () => {
    throw new TypeError('fixture lost response')
  })
  const client = createSupportAiClient(config, fetcher as unknown as typeof fetch)
  await expect(selectSections(client, input, pricing)).rejects.toBeDefined()
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it.each(['mi correo es persona@ejemplo.mx', 'mi teléfono +525566778899', 'mi usuario c123456789012345678901234', 'token=sk-never-send'])(
  'does not send recognizable private identifiers or credentials: %s',
  async topic => {
    const { client, fetcher } = clientReturning('{}')
    expect(await selectSections(client, { ...input, topic }, pricing)).toMatchObject({ valid: false, sectionIds: [] })
    expect(fetcher).not.toHaveBeenCalled()
  },
)
it('sends at most six whole, redacted history messages and eight thousand bytes', async () => {
  const { client, fetcher } = clientReturning(JSON.stringify({ sectionIds: [], needsClarification: true }))
  const history = Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, text: `${i} ${'x'.repeat(1700)}` }))
  history[9].text = 'pin: 123456'
  await selectSections(client, { ...input, history }, pricing)
  expect(fetcher).toHaveBeenCalledTimes(1)
  const init = fetcher.mock.calls[0][1] as unknown as RequestInit
  const payload = JSON.parse(JSON.parse(String(init.body)).input)
  expect(payload.history.length).toBeLessThanOrEqual(6)
  expect(Buffer.byteLength(JSON.stringify(payload.history))).toBeLessThanOrEqual(8000)
  expect(JSON.stringify(payload.history)).not.toContain('123456')
})
// T-F6 (Codex H3): a verified section's steps never go out without the rest of its guide: whole (`whole`), or its card.
it('composes the whole guide or its card, never the steps alone, with independent permission and core-activation warnings', () => {
  const access: HelpAccess = {
    permissions: [],
    features: {},
    activations: { enableShifts: false },
    fingerprint: 'fixture',
    role: 'MANAGER',
  }
  const card = composeSupportAnswer([{ ...guide, activationKey: 'enableShifts' }], access)
  expect(card).toContain('administrador')
  expect(card).toContain('apagada')
  expect(card).toContain(SUPPORT_GUIDE_TOO_LONG)
  expect(card).not.toContain(guide.steps[0])
  expect(card).not.toContain(guide.summary)
  expect(card).toContain(guide.publicUrl)
  expect(card).not.toContain('menu:update')
  const whole = '*Pasos*\n\n1. Paso verificado uno.\n2. Paso verificado dos.\n\n*Problemas frecuentes*\n\n- No repitas el cambio.'
  const body = composeSupportAnswer([{ ...guide, activationKey: 'enableShifts', whole }], access)
  expect(body).toContain('apagada')
  expect(body).toContain(whole)
  expect(body).toContain(guide.publicUrl)
})
// T-F10c: «cannot fit» is now over SUPPORT_LITERAL_CAP (3,500), not over 1,500.
it('uses the card if the whole guide cannot fit, never its summary nor a partial procedure', () => {
  const whole = `PRIMER_PASO ${'a'.repeat(1800)}\nULTIMO_PASO ${'b'.repeat(1800)}`
  const body = composeSupportAnswer([{ ...guide, whole }], null)
  expect(body.length).toBeLessThanOrEqual(1500)
  expect(body).toContain(SUPPORT_GUIDE_TOO_LONG)
  expect(body).not.toContain(guide.summary)
  expect(body).toContain(guide.publicUrl)
  expect(body).not.toMatch(/PRIMER_PASO|ULTIMO_PASO|mensaje truncado/)
})
// T-F10c: a whole guide of ~2,800 goes whole (in 1,500 it went as its card).
it('a section whose whole guide measures ~2,800 goes whole, with its warnings and link', () => {
  const whole = `PRIMER_PASO ${'a'.repeat(1350)}\nULTIMO_PASO ${'b'.repeat(1350)}`
  const body = composeSupportAnswer([{ ...guide, whole }], null)
  expect(body).toBe([guide.title, 'Ayuda pública: tus permisos y funciones pueden variar.', whole, guide.publicUrl].join('\n'))
  expect(body.length).toBeGreaterThan(2800)
  expect(body.length).toBeLessThanOrEqual(SUPPORT_LITERAL_CAP)
})
it('never trusts an arbitrary source URL even if supplied by a caller', () => {
  const body = composeSupportAnswer([{ ...guide, publicUrl: 'https://outside.invalid/data' }], null)
  expect(body).not.toContain('outside.invalid')
  expect(body).toContain('hola@avoqado.io')
})

describe('invitation to link the phone (free text)', () => {
  const previous = process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED
  const access: HelpAccess = { permissions: ['menu:update'], features: {}, activations: {}, fingerprint: 'fixture', role: 'MANAGER' }
  afterEach(() => {
    if (previous === undefined) delete process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED
    else process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED = previous
  })
  const flag = (on: boolean) => {
    if (on) process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED = 'true'
    else delete process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED
  }
  // T-F6 (H3): without `whole`, the card.
  const publicBody = [
    'Guía de prueba',
    'Ayuda pública: tus permisos y funciones pueden variar.',
    SUPPORT_GUIDE_TOO_LONG,
    guide.publicUrl,
  ].join('\n')

  it("with the flag off the text is exactly today's, link or not", () => {
    flag(false)
    expect(composeSupportAnswer([guide], null)).toBe(publicBody)
  })
  it('without access and with required permissions, ends with the link invitation', () => {
    flag(true)
    expect(composeSupportAnswer([guide], null)).toBe(`${publicBody}\n\n${SUPPORT_LINK}`)
  })
  it('does not invite when the guide asks for no permissions', () => {
    flag(true)
    expect(composeSupportAnswer([{ ...guide, requiredPermissions: [] }], null)).toBe(publicBody)
  })
  it('does not invite when the person already has access', () => {
    flag(true)
    const body = composeSupportAnswer([guide], access)
    expect(body).not.toContain(SUPPORT_LINK)
    expect(body).toContain(SUPPORT_GUIDE_TOO_LONG)
  })
  it('does not add the link to the no-coverage fallback', () => {
    flag(true)
    expect(composeSupportAnswer([{ ...guide, publicUrl: 'https://outside.invalid/data' }], null)).toBe(SUPPORT_NO_COVERAGE)
  })
  // T-F10c: the literal's cap is SUPPORT_LITERAL_CAP (3,500) for the invitation too.
  it('omits the link, never cuts or downgrades the guide, when both do not fit in the literal cap', () => {
    const whole = `PRIMER_PASO ${'a'.repeat(1600)}\nULTIMO_PASO ${'b'.repeat(1600)}`
    flag(false)
    const without = composeSupportAnswer([{ ...guide, whole }], null)
    expect(without.length).toBeLessThanOrEqual(SUPPORT_LITERAL_CAP)
    expect(without.length + 2 + SUPPORT_LINK.length).toBeGreaterThan(SUPPORT_LITERAL_CAP)
    expect(without).toContain('ULTIMO_PASO')
    flag(true)
    expect(composeSupportAnswer([{ ...guide, whole }], null)).toBe(without)
  })
  it('T-F10c: adds the link after a whole guide of more than 1,500 while both fit in the literal cap', () => {
    const whole = `PRIMER_PASO ${'a'.repeat(700)}\nULTIMO_PASO ${'b'.repeat(700)}`
    flag(true)
    const body = composeSupportAnswer([{ ...guide, whole }], null)
    expect(body).toBe(
      `${[guide.title, 'Ayuda pública: tus permisos y funciones pueden variar.', whole, guide.publicUrl].join('\n')}\n\n${SUPPORT_LINK}`,
    )
    expect(body.length).toBeGreaterThan(1500)
  })
  it('keeps the card intact and adds the link when it fits', () => {
    const whole = `PRIMER_PASO ${'a'.repeat(1800)}\nULTIMO_PASO ${'b'.repeat(1800)}`
    flag(true)
    const body = composeSupportAnswer([{ ...guide, whole }], null)
    expect(body.length).toBeLessThanOrEqual(1500)
    expect(body).toBe(`${publicBody}\n\n${SUPPORT_LINK}`)
  })
})

it('warns when the already-resolved permission list lacks the permission, without expanding it twice', () => {
  // goals:org-manage implica commissions:read; expandir la lista YA resuelta otra vez daría payments:read, que el panel niega.
  const permissions = Array.from(resolvePermissions(['goals:org-manage']))
  expect(permissions).toContain('commissions:read')
  expect(permissions).not.toContain('payments:read')
  const access: HelpAccess = { permissions, features: {}, activations: {}, fingerprint: 'fixture', role: 'MANAGER' }
  expect(supportWarnings({ requiredPermissions: ['payments:read'] }, access)).toContain('pide acceso a tu administrador')
  expect(supportWarnings({ requiredPermissions: ['commissions:read'] }, access)).toBe('')
})
