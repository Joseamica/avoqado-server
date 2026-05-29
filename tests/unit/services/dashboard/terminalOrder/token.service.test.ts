import {
  signApprovalToken,
  verifyApprovalToken,
  TerminalOrderTokenAction,
} from '@/services/dashboard/terminalOrder/token.service'

describe('terminalOrder token.service', () => {
  const ORIG_SECRET = process.env.TERMINAL_ORDER_TOKEN_SECRET

  beforeAll(() => {
    process.env.TERMINAL_ORDER_TOKEN_SECRET = 'test-secret-32chars-min-required-x'
  })

  afterAll(() => {
    process.env.TERMINAL_ORDER_TOKEN_SECRET = ORIG_SECRET
  })

  it('signs + verifies a token round-trip', () => {
    const token = signApprovalToken({ orderId: 'ord_1', action: 'approve' })
    const payload = verifyApprovalToken(token)
    expect(payload).toMatchObject({ orderId: 'ord_1', action: 'approve' })
  })

  it('rejects a token signed with a different secret', () => {
    const original = process.env.TERMINAL_ORDER_TOKEN_SECRET
    const token = signApprovalToken({ orderId: 'ord_1', action: 'approve' })
    process.env.TERMINAL_ORDER_TOKEN_SECRET = 'a-different-secret-32chars-minim'
    expect(() => verifyApprovalToken(token)).toThrow(/invalid|signature/i)
    process.env.TERMINAL_ORDER_TOKEN_SECRET = original
  })

  it('rejects a token whose action does not match the expected', () => {
    const token = signApprovalToken({ orderId: 'ord_1', action: 'approve' })
    expect(() =>
      verifyApprovalToken(token, { expectedAction: 'reject' as TerminalOrderTokenAction }),
    ).toThrow(/action mismatch/i)
  })

  it('rejects an expired token', () => {
    const token = signApprovalToken({ orderId: 'ord_1', action: 'approve', expiresInSeconds: -1 })
    expect(() => verifyApprovalToken(token)).toThrow(/expired/i)
  })

  it('throws if TERMINAL_ORDER_TOKEN_SECRET is unset at sign time', () => {
    const prev = process.env.TERMINAL_ORDER_TOKEN_SECRET
    delete process.env.TERMINAL_ORDER_TOKEN_SECRET
    expect(() => signApprovalToken({ orderId: 'x', action: 'approve' })).toThrow(
      /TERMINAL_ORDER_TOKEN_SECRET/,
    )
    process.env.TERMINAL_ORDER_TOKEN_SECRET = prev
  })
})

import { signSerialAssignmentToken, verifySerialAssignmentToken } from '@/services/dashboard/terminalOrder/token.service'

describe('signSerialAssignmentToken / verifySerialAssignmentToken', () => {
  const ORIG_SECRET = process.env.TERMINAL_ORDER_TOKEN_SECRET

  beforeAll(() => {
    process.env.TERMINAL_ORDER_TOKEN_SECRET = 'test-secret-32chars-min-required-x'
  })

  afterAll(() => {
    process.env.TERMINAL_ORDER_TOKEN_SECRET = ORIG_SECRET
  })

  it('signs + verifies a serial-assignment token round-trip', () => {
    const token = signSerialAssignmentToken('ord_42')
    const payload = verifySerialAssignmentToken(token)
    expect(payload.orderId).toBe('ord_42')
    expect(payload.action).toBe('assign-serials')
  })

  it('rejects an approve token when verifying as assign-serials', () => {
    const approveToken = signApprovalToken({ orderId: 'ord_42', action: 'approve' })
    expect(() => verifySerialAssignmentToken(approveToken)).toThrow(/action mismatch/i)
  })
})
