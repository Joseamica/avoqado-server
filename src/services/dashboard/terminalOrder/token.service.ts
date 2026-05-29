import jwt, { SignOptions, JwtPayload } from 'jsonwebtoken'

export type TerminalOrderTokenAction = 'approve' | 'reject' | 'assign-serials'

export interface SignTokenInput {
  orderId: string
  action: TerminalOrderTokenAction
  /** Default: 7 days. Negative values are allowed to test expiry handling. */
  expiresInSeconds?: number
}

export interface TerminalOrderTokenPayload extends JwtPayload {
  orderId: string
  action: TerminalOrderTokenAction
  type: 'tpv-order'
}

const DEFAULT_EXPIRY_SECONDS = 7 * 24 * 60 * 60 // 7 days

function getSecret(): string {
  const secret = process.env.TERMINAL_ORDER_TOKEN_SECRET
  if (!secret || secret.length < 16) {
    throw new Error(
      'TERMINAL_ORDER_TOKEN_SECRET is not configured (must be at least 16 chars).',
    )
  }
  return secret
}

export function signApprovalToken(input: SignTokenInput): string {
  const expiresIn = input.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS
  const payload = {
    orderId: input.orderId,
    action: input.action,
    type: 'tpv-order' as const,
  }
  const options: SignOptions = { expiresIn }
  return jwt.sign(payload, getSecret(), options)
}

export function verifyApprovalToken(
  token: string,
  opts: { expectedAction?: TerminalOrderTokenAction } = {},
): TerminalOrderTokenPayload {
  let decoded: TerminalOrderTokenPayload
  try {
    decoded = jwt.verify(token, getSecret()) as TerminalOrderTokenPayload
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw new Error('Token expired')
    throw new Error('Token invalid signature')
  }

  if (decoded.type !== 'tpv-order') throw new Error('Token type mismatch')
  if (opts.expectedAction && decoded.action !== opts.expectedAction) {
    throw new Error('Token action mismatch')
  }
  return decoded
}

export function signSerialAssignmentToken(orderId: string, expiresInSeconds = 30 * 24 * 60 * 60): string {
  return signApprovalToken({ orderId, action: 'assign-serials', expiresInSeconds })
}

export function verifySerialAssignmentToken(token: string): TerminalOrderTokenPayload {
  return verifyApprovalToken(token, { expectedAction: 'assign-serials' })
}
