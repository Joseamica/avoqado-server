import jwt, { Secret, SignOptions } from 'jsonwebtoken'
import { StaffRole } from '@prisma/client'
import crypto from 'crypto'
import dotenv from 'dotenv'

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
  sub: string // Staff.id
  orgId: string // Staff.organizationId
  venueId: string // Venue actual de operación
  role: StaffRole // StaffVenue.role para el venueId actual
  jti: string // SECURITY: JWT ID for token blacklisting/revocation
}

/**
 * Payload para el token de refresco.
 */
export interface RefreshTokenPayload extends jwt.JwtPayload {
  sub: string // Staff.id
  orgId?: string // Opcional: Staff.organizationId
  tokenId: string // ID único para el token de refresco
}

// --- Token Generation Functions ---

/**
 * Genera un token de acceso.
 * @param staffId - ID del Staff (Staff.id)
 * @param organizationId - ID de la Organización (Staff.organizationId)
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
  // Note: JTI validation for blacklisting would be done here when Redis is implemented
  // if (await isTokenBlacklisted(decoded.jti)) throw new Error('Token revoked')
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
