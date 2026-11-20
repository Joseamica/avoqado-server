import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { finishAiAttempt, startAiAttempt } from '@/services/support/budget.service'
import { LUNA_SUPPORT_PRICING as pricing } from '@/config/supportWhatsapp'
it('stores numeric provider usage only, never arbitrary extra fields supplied by a provider', async () => {
  const reservation = { monthKey: 'AI:MONTH:fixture', countKeys: ['AI:PHONE_DAY:fixture'] }
  ;(prisma.supportAttempt.findUnique as jest.Mock).mockResolvedValue({
    id: 'attempt',
    messageId: 'message',
    kind: 'AI',
    state: 'STARTED',
    pricingVersion: pricing.version,
    reservedUsd: new Prisma.Decimal('1'),
    usage: { reservation },
  })
  await finishAiAttempt('attempt', {
    input_tokens: 100,
    output_tokens: 20,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0, privateField: 'NO_GUARDAR' },
    privateField: 'NO_GUARDAR',
  })
  const data = (prisma.supportAttempt.update as jest.Mock).mock.calls[0][0].data
  expect(data.state).toBe('SUCCEEDED')
  expect(data.actualUsd.toString()).toBe('0.00002')
  expect(JSON.stringify(data.usage)).not.toContain('NO_GUARDAR')
  expect(data.usage.reservation).toEqual(reservation)
})
it('settles late numeric usage once while preserving the durable lost-result marker', async () => {
  const reservation = { monthKey: 'AI:MONTH:fixture', countKeys: ['AI:PHONE_DAY:fixture'] }
  ;(prisma.supportAttempt.findUnique as jest.Mock).mockResolvedValue({
    id: 'attempt',
    kind: 'AI',
    state: 'UNKNOWN',
    pricingVersion: pricing.version,
    reservedUsd: new Prisma.Decimal('1'),
    usage: { reservation, resultUnavailable: true },
  })
  await finishAiAttempt('attempt', {
    input_tokens: 100,
    output_tokens: 20,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  })
  const data = (prisma.supportAttempt.update as jest.Mock).mock.calls[0][0].data
  expect(data.state).toBe('SUCCEEDED')
  expect(data.usage).toMatchObject({ reservation, resultUnavailable: true, provider: { input_tokens: 100 } })
})
it.each(['window', 'idle'])('refuses STARTED when %s expires after reservation but the lease remains valid', async kind => {
  Object.assign(process.env, {
    SUPPORT_WHATSAPP_ENABLED: 'true',
    SUPPORT_WHATSAPP_PHONE_NUMBER_ID: 'fixture',
    WHATSAPP_SALES_PHONE_NUMBER_ID: 'sales',
    SUPPORT_WHATSAPP_ENC_KEY: 'e'.repeat(64),
    SUPPORT_AI_ENABLED: 'true',
    SUPPORT_AI_MODEL: pricing.model,
    SUPPORT_AI_PRICING_VERSION: pricing.version,
    SUPPORT_OPENAI_API_KEY: 'fixture',
    SUPPORT_AI_MONTHLY_USD_LIMIT: '1',
  })
  const now = new Date(),
    conversation = { mode: 'PUBLIC', app: 'dashboard', noticeAcceptedAt: now, lastActivityAt: now, lastUserMessageAt: now }
  if (kind === 'window') conversation.lastUserMessageAt = new Date(now.getTime() - 86400000)
  else conversation.lastActivityAt = new Date(now.getTime() - 1800000)
  ;(prisma.supportMessage.findFirst as jest.Mock).mockResolvedValue({ conversation })
  ;(prisma.supportAttempt.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
  expect(
    await startAiAttempt(
      'attempt',
      {
        messageId: 'message',
        conversationId: 'conversation',
        generation: 1,
        claimToken: 'claim',
        leaseUntil: new Date(now.getTime() + 90000),
      },
      now,
    ),
  ).toBe(false)
  expect(prisma.supportAttempt.updateMany).not.toHaveBeenCalled()
})
it('checks the actual time after waiting for the budget lock, rather than reusing the entry timestamp', async () => {
  jest.useFakeTimers()
  try {
    Object.assign(process.env, {
      SUPPORT_WHATSAPP_ENABLED: 'true',
      SUPPORT_WHATSAPP_PHONE_NUMBER_ID: 'fixture',
      WHATSAPP_SALES_PHONE_NUMBER_ID: 'sales',
      SUPPORT_WHATSAPP_ENC_KEY: 'e'.repeat(64),
      SUPPORT_AI_ENABLED: 'true',
      SUPPORT_AI_MODEL: pricing.model,
      SUPPORT_AI_PRICING_VERSION: pricing.version,
      SUPPORT_OPENAI_API_KEY: 'fixture',
      SUPPORT_AI_MONTHLY_USD_LIMIT: '1',
    })
    const now = new Date(),
      conversation = {
        mode: 'PUBLIC',
        app: 'dashboard',
        noticeAcceptedAt: now,
        lastActivityAt: now,
        lastUserMessageAt: new Date(now.getTime() - 86400000 + 1000),
      }
    ;(prisma.$executeRaw as jest.Mock).mockImplementationOnce(async () => {
      jest.setSystemTime(new Date(now.getTime() + 2000))
      return 1
    })
    ;(prisma.supportMessage.findFirst as jest.Mock).mockResolvedValue({
      conversation,
      leaseUntil: new Date(now.getTime() + 90000),
      expiresAt: new Date(now.getTime() + 86400000),
    })
    ;(prisma.supportAttempt.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    expect(
      await startAiAttempt(
        'attempt',
        {
          messageId: 'message',
          conversationId: 'conversation',
          generation: 1,
          claimToken: 'claim',
          leaseUntil: new Date(now.getTime() + 90000),
        },
        now,
      ),
    ).toBe(false)
    expect(prisma.supportAttempt.updateMany).not.toHaveBeenCalled()
  } finally {
    jest.useRealTimers()
  }
})
