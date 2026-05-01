import crypto, { type JsonWebKey } from 'crypto'
import jwt from 'jsonwebtoken'
import { OAuth2Client } from 'google-auth-library'
import { AuthProvider } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { AuthenticationError, ForbiddenError } from '@/errors/AppError'
import { generateConsumerToken } from '@/jwt.service'

type ProviderProfile = {
  provider: AuthProvider
  providerSubject: string
  email?: string | null
  emailVerified: boolean
  firstName?: string | null
  lastName?: string | null
  avatarUrl?: string | null
}

const googleClient = new OAuth2Client()
type AppleJwk = JsonWebKey & { kid?: string }

let appleJwksCache: { expiresAt: number; keys: AppleJwk[] } | null = null

function configuredList(name: string): string[] {
  return (process.env[name] || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
}

function requireAudiences(name: string): string[] | undefined {
  const values = configuredList(name)
  if (values.length > 0) return values
  if (process.env.NODE_ENV === 'production') {
    throw new AuthenticationError(`${name} no esta configurado`)
  }
  return undefined
}

function splitName(name?: string | null): { firstName?: string; lastName?: string } {
  if (!name) return {}
  const parts = name.trim().split(/\s+/)
  if (parts.length === 0) return {}
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') || undefined }
}

async function verifyGoogleIdToken(idToken: string): Promise<ProviderProfile> {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: requireAudiences('CONSUMER_GOOGLE_CLIENT_IDS'),
  })
  const payload = ticket.getPayload()
  if (!payload?.sub) throw new AuthenticationError('Token de Google invalido')

  const fromName = splitName(payload.name)
  return {
    provider: AuthProvider.GOOGLE,
    providerSubject: payload.sub,
    email: payload.email?.toLowerCase() ?? null,
    emailVerified: payload.email_verified === true,
    firstName: payload.given_name ?? fromName.firstName,
    lastName: payload.family_name ?? fromName.lastName,
    avatarUrl: payload.picture ?? null,
  }
}

async function getAppleJwks(): Promise<AppleJwk[]> {
  if (appleJwksCache && appleJwksCache.expiresAt > Date.now()) return appleJwksCache.keys

  const response = await fetch('https://appleid.apple.com/auth/keys')
  if (!response.ok) throw new AuthenticationError('No se pudieron verificar credenciales de Apple')
  const body = (await response.json()) as { keys?: AppleJwk[] }
  appleJwksCache = {
    keys: body.keys ?? [],
    expiresAt: Date.now() + 60 * 60 * 1000,
  }
  return appleJwksCache.keys
}

async function verifyAppleIdToken(idToken: string): Promise<ProviderProfile> {
  const decoded = jwt.decode(idToken, { complete: true })
  if (!decoded || typeof decoded === 'string' || !decoded.header.kid) {
    throw new AuthenticationError('Token de Apple invalido')
  }

  const key = (await getAppleJwks()).find(jwk => jwk.kid === decoded.header.kid)
  if (!key) throw new AuthenticationError('Llave de Apple no encontrada')

  const publicKey = crypto.createPublicKey({ key, format: 'jwk' })
  const payload = jwt.verify(idToken, publicKey, {
    algorithms: ['RS256'],
    issuer: 'https://appleid.apple.com',
    audience: requireAudiences('CONSUMER_APPLE_AUDIENCES'),
  }) as jwt.JwtPayload

  if (!payload.sub) throw new AuthenticationError('Token de Apple invalido')

  const emailVerified = payload.email_verified === true || payload.email_verified === 'true'
  return {
    provider: AuthProvider.APPLE,
    providerSubject: payload.sub,
    email: typeof payload.email === 'string' ? payload.email.toLowerCase() : null,
    emailVerified,
  }
}

async function verifyProviderToken(provider: 'GOOGLE' | 'APPLE', idToken: string): Promise<ProviderProfile> {
  if (provider === 'GOOGLE') return verifyGoogleIdToken(idToken)
  return verifyAppleIdToken(idToken)
}

function publicConsumer(consumer: {
  id: string
  email: string | null
  phone: string | null
  firstName: string | null
  lastName: string | null
  avatarUrl: string | null
  locale: string
}) {
  return {
    id: consumer.id,
    email: consumer.email,
    phone: consumer.phone,
    firstName: consumer.firstName,
    lastName: consumer.lastName,
    avatarUrl: consumer.avatarUrl,
    locale: consumer.locale,
  }
}

export async function loginWithOAuth(input: { provider: 'GOOGLE' | 'APPLE'; idToken: string; firstName?: string; lastName?: string }) {
  const profile = await verifyProviderToken(input.provider, input.idToken)
  const firstName = input.firstName ?? profile.firstName ?? undefined
  const lastName = input.lastName ?? profile.lastName ?? undefined

  const consumer = await prisma.$transaction(async tx => {
    const existingAccount = await tx.consumerAuthAccount.findUnique({
      where: {
        provider_providerSubject: {
          provider: profile.provider,
          providerSubject: profile.providerSubject,
        },
      },
      include: { consumer: true },
    })

    if (existingAccount) {
      if (!existingAccount.consumer.active) throw new ForbiddenError('Esta cuenta esta desactivada')

      await tx.consumerAuthAccount.update({
        where: { id: existingAccount.id },
        data: {
          email: profile.email ?? existingAccount.email,
          emailVerified: profile.emailVerified,
        },
      })

      return tx.consumer.update({
        where: { id: existingAccount.consumerId },
        data: {
          lastLoginAt: new Date(),
          ...(profile.email && !existingAccount.consumer.email ? { email: profile.email } : {}),
          ...(firstName && !existingAccount.consumer.firstName ? { firstName } : {}),
          ...(lastName && !existingAccount.consumer.lastName ? { lastName } : {}),
          ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
        },
      })
    }

    const consumerByEmail = profile.email
      ? await tx.consumer.findUnique({
          where: { email: profile.email },
        })
      : null

    const target =
      consumerByEmail ??
      (await tx.consumer.create({
        data: {
          email: profile.email ?? null,
          firstName: firstName ?? null,
          lastName: lastName ?? null,
          avatarUrl: profile.avatarUrl ?? null,
          lastLoginAt: new Date(),
        },
      }))

    if (!target.active) throw new ForbiddenError('Esta cuenta esta desactivada')

    await tx.consumerAuthAccount.create({
      data: {
        consumerId: target.id,
        provider: profile.provider,
        providerSubject: profile.providerSubject,
        email: profile.email ?? null,
        emailVerified: profile.emailVerified,
      },
    })

    return tx.consumer.update({
      where: { id: target.id },
      data: {
        lastLoginAt: new Date(),
        ...(firstName && !target.firstName ? { firstName } : {}),
        ...(lastName && !target.lastName ? { lastName } : {}),
        ...(profile.avatarUrl && !target.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
      },
    })
  })

  return {
    token: generateConsumerToken(consumer.id),
    consumer: publicConsumer(consumer),
  }
}

export async function getMe(consumerId: string) {
  const consumer = await prisma.consumer.findUnique({
    where: { id: consumerId },
    select: {
      id: true,
      email: true,
      phone: true,
      firstName: true,
      lastName: true,
      avatarUrl: true,
      locale: true,
      active: true,
      authAccounts: {
        select: { provider: true, email: true },
      },
    },
  })
  if (!consumer || !consumer.active) throw new ForbiddenError('Cuenta no disponible')

  return {
    consumer: publicConsumer(consumer),
    authProviders: consumer.authAccounts.map(account => ({
      provider: account.provider,
      email: account.email,
    })),
  }
}
