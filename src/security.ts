import { StaffRole } from '@prisma/client'
export { StaffRole } // Re-export StaffRole
import jwt from 'jsonwebtoken'
import { Request, Response, NextFunction } from 'express'
import { IncomingHttpHeaders } from 'http'

/**
 * Estructura esperada del payload de un token JWT de Avoqado.
 */
export interface AvoqadoJwtPayload extends jwt.JwtPayload {
  sub: string // Staff.id
  orgId: string // Staff.organizationId
  venueId: string // Venue actual de operación
  role: StaffRole // StaffVenue.role para el venueId actual
  // permissions?: string[]; // Opcional
}

/**
 * Representa el contexto de autenticación y autorización para una solicitud exitosa.
 */
export interface AuthContext {
  userId: string
  orgId: string
  venueId: string
  role: StaffRole
}

/**
 * Resultado de la función protectRoute en caso de éxito.
 */
export interface AuthSuccess {
  error: false
  authContext: AuthContext
}

/**
 * Resultado de la función protectRoute en caso de error (autenticación o autorización).
 */
export interface AuthError {
  error: true
  statusCode: 401 | 403
  body: {
    error: 'Unauthorized' | 'Forbidden'
    message: string
  }
}

/**
 * Tipo de resultado para la función protectRoute.
 */
export type ProtectRouteResult = AuthSuccess | AuthError

/**
 * Tipo de resultado para la función protectRoute.
 */
export type AuthResult = AuthSuccess | AuthError

/**
 * Interface for token generation payload
 */
export interface TokenPayload {
  userId: string
  staffId: string
  venueId: string
  orgId: string
  role: StaffRole
  permissions?: any
  correlationId?: string
}

/**
 * Tipo para los encabezados de una solicitud HTTP entrante (simplificado).
 */
// HttpRequestHeaders is no longer needed as we use IncomingHttpHeaders directly
// export type HttpRequestHeaders = Record<string, string | string[] | undefined>;

// Asumimos que ACCESS_TOKEN_SECRET está disponible como variable de entorno
const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET

if (!ACCESS_TOKEN_SECRET) {
  // Lanzar un error si ACCESS_TOKEN_SECRET no está definido.
  // La aplicación principal debería capturar esto en su secuencia de inicio y manejarlo adecuadamente (ej. terminar el proceso).
  throw new Error(
    'Error crítico de configuración: La variable de entorno ACCESS_TOKEN_SECRET no está definida. La aplicación no puede iniciar de forma segura sin este secreto.',
  )
}

/**
 * I. Lógica de Autenticación (Basada en JWT)
 * Verifica un token JWT de una solicitud HTTP.
 *
 * @param headers Encabezados de la solicitud HTTP.
 * @returns El payload decodificado del JWT si es válido, o un objeto de error de autenticación.
 */
function authenticate(
  headers: IncomingHttpHeaders, // Changed from HttpRequestHeaders
): AvoqadoJwtPayload | AuthError {
  if (!ACCESS_TOKEN_SECRET) {
    // Este chequeo es más para el desarrollador, ya que el chequeo global debería haberlo capturado.
    return {
      error: true,
      statusCode: 401,
      body: {
        error: 'Unauthorized',
        message: 'Error de configuración del servidor: ACCESS_TOKEN_SECRET no disponible.',
      },
    }
  }

  const authHeader = headers['authorization']

  if (!authHeader) {
    return {
      error: true,
      statusCode: 401,
      body: {
        error: 'Unauthorized',
        message: 'Falta el header de Authorization.',
      },
    }
  }

  const parts = Array.isArray(authHeader) ? authHeader[0].split(' ') : authHeader.split(' ')

  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return {
      error: true,
      statusCode: 401,
      body: {
        error: 'Unauthorized',
        message: 'Header de Authorization malformado. Se esperaba esquema Bearer.',
      },
    }
  }

  const token = parts[1]
  if (!token) {
    return {
      error: true,
      statusCode: 401,
      body: {
        error: 'Unauthorized',
        message: 'Token JWT ausente.',
      },
    }
  }

  try {
    const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET) as AvoqadoJwtPayload

    // Validaciones adicionales del payload si es necesario (ej. campos requeridos)
    if (!decoded.sub || !decoded.orgId || !decoded.venueId || !decoded.role) {
      throw new Error('Payload del JWT incompleto.')
    }
    if (!Object.values(StaffRole).includes(decoded.role as StaffRole)) {
      throw new Error('Rol en JWT no es un StaffRole válido.')
    }

    return decoded
  } catch (err: any) {
    let message = 'Token inválido o expirado.'
    if (err instanceof jwt.TokenExpiredError) {
      message = 'Token expirado.'
    } else if (err instanceof jwt.JsonWebTokenError) {
      message = `Token inválido: ${err.message}`
    } else if (
      err instanceof Error &&
      (err.message === 'Payload del JWT incompleto.' || err.message === 'Rol en JWT no es un StaffRole válido.')
    ) {
      message = err.message
    }

    return {
      error: true,
      statusCode: 401,
      body: {
        error: 'Unauthorized',
        message,
      },
    }
  }
}

/**
 * II. Lógica de Autorización (Basada en Roles Contextuales al Venue)
 * Verifica si el rol del usuario está permitido para acceder a un recurso.
 *
 * @param userRole El rol del usuario autenticado (del JWT).
 * @param allowedRoles Lista de StaffRole permitidos para el recurso.
 * @returns True si está autorizado, o un objeto de error de autorización.
 */
function authorize(userRole: StaffRole, allowedRoles: StaffRole[]): true | AuthError {
  if (allowedRoles.includes(userRole)) {
    return true
  }

  return {
    error: true,
    statusCode: 403,
    body: {
      error: 'Forbidden',
      message: 'No tienes los permisos necesarios para acceder a este recurso en este establecimiento.',
    },
  }
}

/**
 * III. Interfaz de la Capa de Seguridad
 * Middleware factory para proteger rutas, realizando autenticación y autorización.
 *
 * @param allowedRoles Lista de StaffRole permitidos para el recurso específico.
 * @returns Un middleware de Express.
 */
export function protectRoute(allowedRoles: StaffRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Autenticar
    // req.headers is already IncomingHttpHeaders
    const authResult = authenticate(req.headers)

    if ('error' in authResult && authResult.error === true) {
      // Es un AuthError
      res.status(authResult.statusCode).json(authResult.body)
      return // No llamar a next()
    }

    // Es AvoqadoJwtPayload (éxito de autenticación)
    const jwtPayload = authResult as AvoqadoJwtPayload

    // 2. Autorizar
    const authzResult = authorize(jwtPayload.role, allowedRoles)
    if (authzResult !== true) {
      // Es un AuthError de autorización
      res.status(authzResult.statusCode).json(authzResult.body)
      return // No llamar a next()
    }

    // 3. Éxito: construir y adjuntar el contexto de autenticación a la solicitud
    const authContext: AuthContext = {
      userId: jwtPayload.sub,
      orgId: jwtPayload.orgId,
      venueId: jwtPayload.venueId,
      role: jwtPayload.role,
    }

    // Augmentar el objeto Request de Express. Asume que `express.d.ts` está configurado.
    req.authContext = authContext

    next() // Continuar al siguiente middleware o manejador de ruta
  }
}

// IV. JWT Token Generation Functions

/**
 * Generate JWT access token for authentication
 * @param payload Token payload containing user information
 * @returns JWT access token string
 */
export function generateAccessToken(payload: TokenPayload): string {
  const jwtPayload: AvoqadoJwtPayload = {
    sub: payload.userId,
    orgId: payload.orgId,
    venueId: payload.venueId,
    role: payload.role,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (60 * 60), // 1 hour expiry
  }

  const secret = process.env.ACCESS_TOKEN_SECRET
  if (!secret) {
    throw new Error('ACCESS_TOKEN_SECRET environment variable is not set')
  }

  return jwt.sign(jwtPayload, secret, {
    algorithm: 'HS256',
    issuer: 'avoqado-api',
    audience: 'avoqado-clients'
  })
}

/**
 * Generate JWT refresh token for token renewal
 * @param payload Token payload containing user information
 * @returns JWT refresh token string
 */
export function generateRefreshToken(payload: TokenPayload): string {
  const jwtPayload = {
    sub: payload.userId,
    orgId: payload.orgId,
    venueId: payload.venueId,
    type: 'refresh',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 7), // 7 days expiry
  }

  const secret = process.env.ACCESS_TOKEN_SECRET
  if (!secret) {
    throw new Error('ACCESS_TOKEN_SECRET environment variable is not set')
  }

  return jwt.sign(jwtPayload, secret, {
    algorithm: 'HS256',
    issuer: 'avoqado-api',
    audience: 'avoqado-clients'
  })
}

/**
 * Verify and decode a JWT token
 * @param token JWT token string
 * @returns Decoded JWT payload or null if invalid
 */
export function verifyToken(token: string): AvoqadoJwtPayload | null {
  try {
    const secret = process.env.ACCESS_TOKEN_SECRET
    if (!secret) {
      throw new Error('ACCESS_TOKEN_SECRET environment variable is not set')
    }

    const decoded = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      issuer: 'avoqado-api',
      audience: 'avoqado-clients'
    }) as AvoqadoJwtPayload

    return decoded
  } catch (error) {
    return null
  }
}

// V. Salida Esperada: 3. Ejemplo de uso
/*
// Este es un ejemplo conceptual y necesitaría un contexto de servidor (ej. Express, Fastify)

// Supongamos que tienes una función handler para tu endpoint
async function handleGetTotalSales(request: any, response: any) {
  // Lista de roles permitidos para este endpoint específico
  const allowedRolesForTotalSales: StaffRole[] = [
    StaffRole.OWNER,
    StaffRole.ADMIN,
    StaffRole.MANAGER,
  ];

  // Proteger la ruta
  const securityCheck = protectRoute(request.headers, allowedRolesForTotalSales);

  if (securityCheck.error) {
    // Si hay un error de autenticación o autorización, enviar la respuesta HTTP correspondiente
    response.status(securityCheck.statusCode).json(securityCheck.body);
    return;
  }

  // Si la seguridad pasa, securityCheck.authContext contiene la información del usuario
  const { userId, orgId, venueId, role } = securityCheck.authContext;

  console.log(`Usuario ${userId} (Rol: ${role}) en Venue ${venueId} (Org: ${orgId}) accedió a ventas totales.`);

  // Aquí iría la lógica de negocio principal para obtener las ventas totales,
  // utilizando orgId y venueId para filtrar los datos correctamente.
  // Por ejemplo:
  // const totalSales = await getTotalSalesForVenue(orgId, venueId);
  // response.status(200).json({ totalSales });

  response.status(200).json({ message: 'Acceso concedido a ventas totales', authContext: securityCheck.authContext });
}

// Ejemplo de cómo se podría configurar en un router de Express (simplificado):
// import express from 'express';
// const app = express();
// app.get('/api/venues/:venueId/total-sales', (req, res) => {
//   // Aquí `req.headers` sería el objeto HttpRequestHeaders
//   // `req.params.venueId` podría usarse para verificar que el venueId del JWT coincide,
//   // aunque la lógica actual ya confía en el venueId del JWT.
//   handleGetTotalSales(req, res);
// });

// Para probar la generación de un token (necesitarías `jsonwebtoken` y una `ACCESS_TOKEN_SECRET`):
// import jwt from 'jsonwebtoken';
// const generateTestToken = (payload: Partial<AvoqadoJwtPayload>) => {
//   const defaultPayload: AvoqadoJwtPayload = {
//     sub: 'staff_test_id',
//     orgId: 'org_test_id',
//     venueId: 'venue_test_id',
//     role: StaffRole.MANAGER,
//     iat: Math.floor(Date.now() / 1000),
//     exp: Math.floor(Date.now() / 1000) + (60 * 60), // Expira en 1 hora
//     ...payload,
//   };
//   return jwt.sign(defaultPayload, process.env.ACCESS_TOKEN_SECRET || 'tu_ACCESS_TOKEN_SECRET_para_pruebas');
// };

// const testTokenAdmin = generateTestToken({ role: StaffRole.ADMIN });
// console.log('Test Token Admin:', testTokenAdmin);

// const testTokenWaiter = generateTestToken({ role: StaffRole.WAITER });
// console.log('Test Token Waiter:', testTokenWaiter);

// // Simulación de una solicitud con el token de Admin
// const mockRequestAdmin = {
//   headers: {
//     authorization: `Bearer ${testTokenAdmin}`,
//   },
// };

// // Simulación de una solicitud con el token de Waiter
// const mockRequestWaiter = {
//   headers: {
//     authorization: `Bearer ${testTokenWaiter}`,
//   },
// };

// // Simulación de una solicitud sin token
// const mockRequestNoToken = {
//   headers: {},
// };

// const allowedRolesForSales: StaffRole[] = [StaffRole.OWNER, StaffRole.ADMIN, StaffRole.MANAGER];

// console.log('\n--- Probando Admin (debería pasar) ---');
// const resultAdmin = protectRoute(mockRequestAdmin.headers, allowedRolesForSales);
// console.log(JSON.stringify(resultAdmin, null, 2));

// console.log('\n--- Probando Waiter (debería fallar autorización) ---');
// const resultWaiter = protectRoute(mockRequestWaiter.headers, allowedRolesForSales);
// console.log(JSON.stringify(resultWaiter, null, 2));

// console.log('\n--- Probando Sin Token (debería fallar autenticación) ---');
// const resultNoToken = protectRoute(mockRequestNoToken.headers, allowedRolesForSales);
// console.log(JSON.stringify(resultNoToken, null, 2));

// console.log('\n--- Probando Token Expirado (necesitaría un token realmente expirado) ---');
// const expiredToken = jwt.sign(
//   { sub: 'test', orgId: 'test', venueId: 'test', role: StaffRole.ADMIN, exp: Math.floor(Date.now() / 1000) - 3600 }, 
//   process.env.ACCESS_TOKEN_SECRET || 'tu_ACCESS_TOKEN_SECRET_para_pruebas'
// );
// const mockRequestExpiredToken = { headers: { authorization: `Bearer ${expiredToken}` } };
// const resultExpired = protectRoute(mockRequestExpiredToken.headers, allowedRolesForSales);
// console.log(JSON.stringify(resultExpired, null, 2));

*/
