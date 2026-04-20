import jwt, { Secret, SignOptions } from 'jsonwebtoken'
import { StaffRole } from '@prisma/client'
import crypto from 'crypto'
import dotenv from 'dotenv'
import { ImpersonationActClaim } from './types/impersonation'

dotenv.config()

// --- Environment Variable Checks ---
const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET

if (!ACCESS_TOKEN_SECRET) {
  throw new Error('Error crítico de configuración: ACCESS_TOKEN_SECRETno está definido.')
}
if (!REFRESH_TOKEN_SECRET) {
  throw new Error('Error crítico de configuración: REFRESH_TOKEN_SECRET no está definido.')
}

// --- Token Payload Interfaces ---

/**
 * Payload para el token de acceso.
 */
export interface AccessTokenPayload extends jwt.JwtPayload {
  sub: string // Staff.id (= impersonated user id in user-mode impersonation, actor otherwise)
  orgId: string // Organization ID (derived from venue or StaffOrganization)
  venueId: string // Venue actual de operación
  role: StaffRole // Effective role (= impersonated role when impersonating)
  jti: string // SECURITY: JWT ID for token blacklisting/revocation
  /**
   * OAuth 2.0 Token Exchange (RFC 8693) `act` claim.
   * Present only during impersonation sessions — identifies the real actor.
   * When present, the session is an impersonation session and must be treated as read-only.
   */
  act?: ImpersonationActClaim
}

/**
 * Payload para el token de refresco.
 */
export interface RefreshTokenPayload extends jwt.JwtPayload {
  sub: string // Staff.id
  orgId?: string // Organization ID (from StaffOrganization)
  tokenId: string // ID único para el token de refresco
}

// --- Token Generation Functions ---

/**
 * Genera un token de acceso.
 * @param staffId - ID del Staff (Staff.id)
 * @param organizationId - ID de la Organización (from venue or StaffOrganization)
 * @param venueId - ID del Venue para la sesión actual
 * @param role - Rol del Staff en el Venue actual
 * @param rememberMe - Si true, extiende la duración del token a 30 días
 * @returns El token de acceso firmado.
 */
export function generateAccessToken(
  staffId: string,
  organizationId: string,
  venueId: string,
  role: StaffRole,
  rememberMe?: boolean,
): string {
  const payload: Omit<AccessTokenPayload, 'iat' | 'exp' | 'aud' | 'iss'> = {
    sub: staffId,
    orgId: organizationId,
    venueId: venueId,
    role: role,
    // SECURITY: JTI (JWT ID) enables token blacklisting for:
    // - Logout from specific device
    // - Session invalidation on password change
    // - Revoking compromised tokens
    jti: crypto.randomUUID(),
  }
  // Explicitly type the secret and options
  const secret: Secret = ACCESS_TOKEN_SECRET!
  const options: SignOptions = {
    // rememberMe: 30 days (2592000 seconds), normal: 24 hours (86400 seconds)
    expiresIn: rememberMe ? 2592000 : 86400,
    algorithm: 'HS256', // SECURITY: Explicitly specify algorithm
  }
  return jwt.sign(payload, secret, options)
}

/**
 * Generates an access token for an impersonation session.
 *
 * The returned JWT follows the RFC 8693 `act` claim pattern:
 * - `sub` is the impersonated user's staffId (or the actor in role-only mode).
 * - `role` is the impersonated (effective) role.
 * - `act` carries the real actor's identity and session metadata.
 *
 * The token's own JWT `exp` is set to `act.expiresAt` so that expiration
 * is enforced at the JWT layer as well as by the impersonation guard middleware.
 *
 * @param subStaffId - The `sub` to embed (target userId for 'user' mode, superadmin's id for 'role' mode).
 * @param organizationId - Organization ID (unchanged from the original session).
 * @param venueId - Venue ID (impersonation is always venue-scoped).
 * @param effectiveRole - The role the token grants (target role, never SUPERADMIN).
 * @param act - Actor claim with real identity + session metadata.
 * @returns Signed JWT string.
 */
export function generateImpersonationAccessToken(
  subStaffId: string,
  organizationId: string,
  venueId: string,
  effectiveRole: StaffRole,
  act: ImpersonationActClaim,
): string {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const expiresInSeconds = Math.max(0, act.expiresAt - nowSeconds)

  const payload: Omit<AccessTokenPayload, 'iat' | 'exp' | 'aud' | 'iss'> = {
    sub: subStaffId,
    orgId: organizationId,
    venueId: venueId,
    role: effectiveRole,
    jti: crypto.randomUUID(),
    act,
  }

  const secret: Secret = ACCESS_TOKEN_SECRET!
  const options: SignOptions = {
    expiresIn: expiresInSeconds,
    algorithm: 'HS256',
  }
  return jwt.sign(payload, secret, options)
}

/**
 * Genera un token de refresco.
 * @param staffId - ID del Staff (Staff.id)
 * @param organizationId - (Opcional) ID de la Organización
 * @param rememberMe - Si true, extiende la duración del token a 90 días
 * @returns El token de refresco firmado.
 */
export function generateRefreshToken(staffId: string, organizationId?: string, rememberMe?: boolean): string {
  const payload: Omit<RefreshTokenPayload, 'iat' | 'exp' | 'aud' | 'iss'> = {
    sub: staffId,
    tokenId: crypto.randomBytes(16).toString('hex'), // Genera un ID único para el token
  }
  if (organizationId) {
    payload.orgId = organizationId
  }
  // Explicitly type the secret and options
  const secret: Secret = REFRESH_TOKEN_SECRET!
  const options: SignOptions = {
    // rememberMe: 90 days (7776000 seconds), normal: 7 days (604800 seconds)
    expiresIn: rememberMe ? 7776000 : 604800,
    algorithm: 'HS256', // SECURITY: Explicitly specify algorithm
  }
  return jwt.sign(payload, secret, options)
}

// --- Token Verification Functions ---

/**
 * Verifica un token de acceso.
 * @param token - El token de acceso a verificar.
 * @returns El payload del token si es válido.
 * @throws JsonWebTokenError si el token es inválido o ha expirado.
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  // SECURITY: Explicitly specify algorithm to prevent algorithm substitution attacks
  const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET!, {
    algorithms: ['HS256'],
  }) as AccessTokenPayload
  // Validaciones adicionales del payload si es necesario
  if (!decoded.sub || !decoded.orgId || !decoded.venueId || !decoded.role) {
    throw new jwt.JsonWebTokenError('Payload del token de acceso incompleto.')
  }
  if (!Object.values(StaffRole).includes(decoded.role as StaffRole)) {
    throw new jwt.JsonWebTokenError('Rol en token de acceso no es un StaffRole válido.')
  }

  // Validate `act` claim structure when present (impersonation session)
  if (decoded.act) {
    const a = decoded.act
    if (!a.sub || !a.role || !a.mode || typeof a.expiresAt !== 'number' || typeof a.extensionsUsed !== 'number') {
      throw new jwt.JsonWebTokenError('Payload del token de impersonación incompleto.')
    }
    if (!Object.values(StaffRole).includes(a.role as StaffRole)) {
      throw new jwt.JsonWebTokenError('Rol de actor en token de impersonación inválido.')
    }
    if (a.mode !== 'user' && a.mode !== 'role') {
      throw new jwt.JsonWebTokenError('Modo de impersonación inválido.')
    }
  }

  return decoded
}

/**
 * Verifica un token de refresco.
 * @param token - El token de refresco a verificar.
 * @returns El payload del token si es válido.
 * @throws JsonWebTokenError si el token es inválido o ha expirado.
 */
export function verifyRefreshToken(token: string): RefreshTokenPayload {
  // SECURITY: Explicitly specify algorithm to prevent algorithm substitution attacks
  const decoded = jwt.verify(token, REFRESH_TOKEN_SECRET!, {
    algorithms: ['HS256'],
  }) as RefreshTokenPayload
  // Validaciones adicionales del payload si es necesario
  if (!decoded.sub || !decoded.tokenId) {
    throw new jwt.JsonWebTokenError('Payload del token de refresco incompleto.')
  }
  return decoded
}

/**
 * Ejemplo de cómo se podrían usar estas funciones (comentado para evitar ejecución directa)
 *
 * async function exampleUsage() {
 *   const staffId = 'staff_123';
 *   const orgId = 'org_abc';
 *   const venueId = 'venue_xyz';
 *   const role = StaffRole.ADMIN;
 *
 *   // Generar tokens
 *   const accessToken = generateAccessToken(staffId, orgId, venueId, role);
 *   const refreshToken = generateRefreshToken(staffId, orgId);
 *   console.log('Access Token:', accessToken);
 *   console.log('Refresh Token:', refreshToken);
 *
 *   // Simular espera y verificación
 *   setTimeout(() => {
 *     try {
 *       const decodedAccess = verifyAccessToken(accessToken);
 *       console.log('Decoded Access Token:', decodedAccess);
 *     } catch (err: any) {
 *       console.error('Error verificando Access Token:', err.message);
 *     }
 *
 *     try {
 *       const decodedRefresh = verifyRefreshToken(refreshToken);
 *       console.log('Decoded Refresh Token:', decodedRefresh);
 *     } catch (err: any) {
 *       console.error('Error verificando Refresh Token:', err.message);
 *     }
 *   }, 1000);
 *
 *   // Simular un token expirado (requiere ajustar la expiración a algo muy corto para prueba)
 *   // const expiredToken = jwt.sign({ sub: 'test' }, ACCESS_TOKEN_SECRET!, { expiresIn: '1s' });
 *   // setTimeout(() => {
 *   //   try {
 *   //     verifyAccessToken(expiredToken);
 *   //   } catch (err: any) {
 *   //     console.error('Error esperado por token expirado:', err.message); // Debería ser 'jwt expired'
 *   //   }
 *   // }, 2000);
 * }
 *
 * // exampleUsage();
 */

// --- Customer Token Functions ---

export interface CustomerTokenPayload extends jwt.JwtPayload {
  sub: string // Customer.id
  venueId: string
  type: 'customer' // Distinguishes from staff tokens
}

/**
 * Genera un token de acceso para clientes (portal público).
 * Expiración: 30 días.
 */
export function generateCustomerToken(customerId: string, venueId: string): string {
  const payload: Omit<CustomerTokenPayload, 'iat' | 'exp'> = {
    sub: customerId,
    venueId,
    type: 'customer',
  }
  return jwt.sign(payload, ACCESS_TOKEN_SECRET!, {
    expiresIn: 2592000, // 30 days
    algorithm: 'HS256',
  })
}

/**
 * Verifica un token de cliente.
 */
export function verifyCustomerToken(token: string): CustomerTokenPayload {
  const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET!, {
    algorithms: ['HS256'],
  }) as CustomerTokenPayload
  if (!decoded.sub || !decoded.venueId || decoded.type !== 'customer') {
    throw new jwt.JsonWebTokenError('Token de cliente inválido.')
  }
  return decoded
}
