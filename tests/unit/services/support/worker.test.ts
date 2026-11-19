jest.mock('@/services/support/store.service', () => ({ readCurrentClaim: jest.fn(), completeClaim: jest.fn().mockResolvedValue(true) }))
jest.mock('@/services/support/budget.service', () => ({
  reserveAiAttempt: jest.fn(),
  startAiAttempt: jest.fn(),
  finishAiAttempt: jest.fn(),
  releaseUnstartedAiAttempt: jest.fn(),
}))
jest.mock('@/services/support/context.service', () => ({
  ...jest.requireActual('@/services/support/context.service'),
  readSupportContext: jest.fn(),
}))
jest.mock('@/services/support/knowledge.service', () => ({
  searchVerifiedHelp: jest.fn(),
  loadVerifiedSections: jest.fn().mockReturnValue([]),
}))
import prisma from '@/utils/prismaClient'
import { prepareSupportAnswer } from '@/services/support/worker.service'
import { readCurrentClaim, completeClaim } from '@/services/support/store.service'
import { reserveAiAttempt, startAiAttempt, finishAiAttempt } from '@/services/support/budget.service'
import { readSupportContext } from '@/services/support/context.service'
import { searchVerifiedHelp, type VerifiedSection } from '@/services/support/knowledge.service'
import { createSupportAiClient } from '@/services/support/answer.service'
import { LUNA_SUPPORT_PRICING as pricing } from '@/config/supportWhatsapp'
import { Prisma } from '@prisma/client'
import { ForbiddenError } from '@/errors/AppError'
const now = new Date(),
  claim = { messageId: 'm', conversationId: 'c', generation: 1, claimToken: 'token', leaseUntil: new Date(now.getTime() + 90000) }
const conversation = {
  id: 'c',
  receiverId: 'fixture-worker',
  phone: '+525511112222',
  generation: 1,
  mode: 'PUBLIC',
  noticeAcceptedAt: now,
  app: 'dashboard',
  lastUserMessageAt: now,
  lastActivityAt: now,
}
const message = {
  id: 'm',
  conversationId: 'c',
  sequence: 7,
  generation: 1,
  purpose: 'HELP',
  answer: null,
  body: '¿Cómo cambio productos?',
  conversation,
}
const guide: VerifiedSection = {
  id: 'dashboard/menu/gestionar-productos',
  app: 'dashboard',
  title: 'Productos',
  summary: 'Resumen de prueba',
  steps: ['Paso revisado final'],
  // T-F6 (H3): a verified section's steps go out only with its whole guide.
  whole: '*Pasos*\n\n1. Paso revisado final',
  publicUrl: 'https://avoqado.io/help/dashboard/menu/gestionar-productos',
  requiredPermissions: [],
  keywords: [],
}
function provider(callback?: () => Promise<void>, fail = false) {
  const fetcher = jest.fn(async () => {
    await callback?.()
    if (fail) throw new TypeError('respuesta perdida')
    return new Response(
      JSON.stringify({
        id: 'resp_fixture',
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: JSON.stringify({ sectionIds: [guide.id], needsClarification: false }), annotations: [] },
            ],
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  })
  return {
    fetcher,
    client: createSupportAiClient(
      { apiKey: 'fixture', pricing, monthlyLimitUsd: new Prisma.Decimal(10) },
      fetcher as unknown as typeof fetch,
    ),
  }
}
beforeEach(() => {
  Object.assign(process.env, {
    SUPPORT_WHATSAPP_ENABLED: 'true',
    SUPPORT_WHATSAPP_PHONE_NUMBER_ID: conversation.receiverId,
    WHATSAPP_PHONE_NUMBER_ID: 'fixture-central',
    WHATSAPP_SALES_PHONE_NUMBER_ID: 'sales',
    SUPPORT_WHATSAPP_ENC_KEY: 'e'.repeat(64),
    SUPPORT_AI_ENABLED: 'true',
    SUPPORT_AI_MODEL: pricing.model,
    SUPPORT_AI_PRICING_VERSION: pricing.version,
    SUPPORT_AI_MONTHLY_USD_LIMIT: '10',
    SUPPORT_OPENAI_API_KEY: 'fixture',
  })
  ;(readCurrentClaim as jest.Mock).mockResolvedValue(message)
  ;(readSupportContext as jest.Mock).mockResolvedValue({ context: null, access: null, fingerprint: 'fresh' })
  ;(searchVerifiedHelp as jest.Mock).mockResolvedValue({ kind: 'ANSWER', sections: [guide], access: null })
  ;(reserveAiAttempt as jest.Mock).mockResolvedValue({ id: 'attempt' })
  ;(startAiAttempt as jest.Mock).mockResolvedValue(true)
  ;(prisma.supportMessage.findMany as jest.Mock).mockResolvedValue([])
  // T-F6 (H6): the public notice goes through recordShownSupportAnswer, which guards the row with updateMany.
  ;(prisma.supportMessage.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
})
it('reserves and persists STARTED before one SDK fetch, saves only verified steps and sources', async () => {
  const p = provider(async () => {
    expect(reserveAiAttempt).toHaveBeenCalledTimes(1)
    expect(startAiAttempt).toHaveBeenCalledTimes(1)
  })
  expect(await prepareSupportAnswer(claim, p, now)).toBe('READY')
  expect(p.fetcher).toHaveBeenCalledTimes(1)
  expect(completeClaim).toHaveBeenCalledWith(
    claim,
    expect.objectContaining({
      status: 'ANSWER_READY',
      answer: expect.stringContaining(guide.steps[0]),
      sourceIds: [guide.id],
      accessFingerprint: 'fresh',
    }),
    expect.any(Date),
  )
  expect(finishAiAttempt).toHaveBeenCalledWith('attempt', expect.objectContaining({ input_tokens: 10 }), undefined, expect.any(Date))
})
it.each(['disabled', 'no-guide', 'no-budget', 'before-consent', 'window-expired', 'already-composed'])(
  'makes no AI request for %s',
  async kind => {
    if (kind === 'disabled') process.env.SUPPORT_AI_ENABLED = 'false'
    if (kind === 'no-guide') (searchVerifiedHelp as jest.Mock).mockResolvedValue({ kind: 'NO_COVERAGE', sections: [], access: null })
    if (kind === 'no-budget') (reserveAiAttempt as jest.Mock).mockResolvedValue(null)
    if (kind === 'before-consent')
      (readCurrentClaim as jest.Mock).mockResolvedValue({ ...message, conversation: { ...conversation, noticeAcceptedAt: null } })
    if (kind === 'window-expired')
      (readCurrentClaim as jest.Mock).mockResolvedValue({
        ...message,
        conversation: { ...conversation, lastUserMessageAt: new Date(now.getTime() - 86400001) },
      })
    if (kind === 'already-composed') (readCurrentClaim as jest.Mock).mockResolvedValue({ ...message, answer: 'respuesta guardada' })
    const p = provider()
    await prepareSupportAnswer(claim, p, now)
    expect(p.fetcher).not.toHaveBeenCalled()
    expect(startAiAttempt).not.toHaveBeenCalled()
  },
)
// T-F14 (ruling T-P1): a conversation that is not on the support number (here, on the central) is never answered.
it('T-F14: a conversation on the central number is cancelled without any AI request', async () => {
  process.env.SUPPORT_WHATSAPP_PHONE_NUMBER_ID = 'fixture-support'
  process.env.WHATSAPP_PHONE_NUMBER_ID = conversation.receiverId
  const p = provider()
  expect(await prepareSupportAnswer(claim, p, now)).toBe('CANCELLED')
  expect(p.fetcher).not.toHaveBeenCalled()
  expect(completeClaim).toHaveBeenCalledWith(claim, { status: 'CANCELLED' }, expect.any(Date))
})
it('provider uncertainty retains accounting and saves a deterministic fallback, without retrying', async () => {
  const p = provider(undefined, true)
  expect(await prepareSupportAnswer(claim, p, now)).toBe('UNKNOWN')
  expect(p.fetcher).toHaveBeenCalledTimes(1)
  expect(finishAiAttempt).toHaveBeenCalledWith('attempt', null, undefined, expect.any(Date))
  expect(completeClaim).toHaveBeenCalledWith(
    claim,
    expect.objectContaining({ status: 'ANSWER_READY', answer: expect.stringContaining('REINTENTAR') }),
    expect.any(Date),
  )
})
it('a changed permission fingerprint after AI never persists the stale guide', async () => {
  const p = provider(async () => {
    ;(readSupportContext as jest.Mock).mockResolvedValue({ context: null, access: null, fingerprint: 'changed' })
  })
  ;(prisma.supportConversation.update as jest.Mock).mockResolvedValue({ ...conversation, generation: 2 })
  await prepareSupportAnswer(claim, p, now)
  expect(prisma.supportMessage.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: 'm' },
      data: expect.objectContaining({ answer: expect.stringContaining('acceso cambió'), sourceIds: [], generation: 2 }),
    }),
  )
  expect(completeClaim).not.toHaveBeenCalledWith(claim, expect.objectContaining({ sourceIds: [guide.id] }), expect.any(Date))
})
it('revocation or cancellation between reservation and STARTED does not call the provider', async () => {
  const p = provider()
  ;(readSupportContext as jest.Mock)
    .mockResolvedValueOnce({ context: null, access: null, fingerprint: 'fresh' })
    .mockResolvedValueOnce({ context: null, access: null, fingerprint: 'fresh' })
    .mockRejectedValue(new ForbiddenError('revocado', 'SUPPORT_ACCESS_REVOKED'))
  ;(prisma.supportConversation.update as jest.Mock).mockResolvedValue({ ...conversation, generation: 2 })
  await prepareSupportAnswer(claim, p, now)
  expect(p.fetcher).not.toHaveBeenCalled()
})
it('a retry command without an owned unknown attempt never creates another provider request', async () => {
  ;(readCurrentClaim as jest.Mock).mockResolvedValue({ ...message, body: 'REINTENTAR' })
  ;(prisma.supportMessage.findFirst as jest.Mock).mockResolvedValue(null)
  const p = provider()
  await prepareSupportAnswer(claim, p, now)
  expect(p.fetcher).not.toHaveBeenCalled()
  expect(reserveAiAttempt).not.toHaveBeenCalled()
})
it('recovery with no saved guide does not ask the model to invent one', async () => {
  ;(readCurrentClaim as jest.Mock).mockResolvedValue({ ...message, body: 'RECUPERAR' })
  ;(prisma.supportMessage.findFirst as jest.Mock).mockResolvedValue(null)
  const p = provider()
  await prepareSupportAnswer(claim, p, now)
  expect(p.fetcher).not.toHaveBeenCalled()
  expect(reserveAiAttempt).not.toHaveBeenCalled()
})
