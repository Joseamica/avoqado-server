import { assistantActionConfirmSchema } from '@/schemas/dashboard/assistant.schema'

describe('assistantActionConfirmSchema', () => {
  it('should default doubleConfirmed to false', () => {
    const parsed = assistantActionConfirmSchema.parse({
      body: {
        actionId: '11111111-1111-4111-8111-111111111111',
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
        confirmed: true,
      },
    })

    expect(parsed.body.doubleConfirmed).toBe(false)
  })

  it('should accept explicit doubleConfirmed=true for high-danger chatbot actions', () => {
    const parsed = assistantActionConfirmSchema.parse({
      body: {
        actionId: '11111111-1111-4111-8111-111111111111',
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
        confirmed: true,
        doubleConfirmed: true,
      },
    })

    expect(parsed.body.doubleConfirmed).toBe(true)
  })
})
