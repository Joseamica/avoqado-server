import { V2StepParamsSchema } from '../../../src/schemas/onboarding.schema'

const ORG = 'cjld2cjxh0000qzrmn831i7rn' // valid cuid shape

const parseStep = (stepNumber: string) => V2StepParamsSchema.safeParse({ params: { organizationId: ORG, stepNumber } })

describe('V2StepParamsSchema stepNumber regex', () => {
  // REGRESSION (full-testing 2026-06-02): the step-number regex was capped at /^[1-8]$/.
  // When the wizard grew the buy-TPV (9) and plan (10) steps, saving those steps 400'd with
  // "Numero de paso invalido (1-8)", which blocked onboarding completion AND the subscription
  // flow entirely. The regex must accept 1-10.
  it.each(['1', '2', '7', '8', '9', '10'])('accepts valid step "%s"', s => {
    expect(parseStep(s).success).toBe(true)
  })

  it.each(['0', '11', '12', '99', 'abc', '', ' 9'])('rejects invalid step "%s"', s => {
    expect(parseStep(s).success).toBe(false)
  })
})
