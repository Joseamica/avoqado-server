import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken'; // For error types like TokenExpiredError
import { verifyAccessToken } from '../jwt.service';
import { AuthContext } from '../security'; // Assuming AuthContext is defined and exported here

export const authenticateTokenMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Authorization header is missing or malformed (Bearer schema expected).',
    });
    return;
  }

  const token = authHeader.split(' ')[1];

  if (!token) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Token not found in Authorization header.',
    });
    return;
  }

  try {
    const decodedPayload = verifyAccessToken(token); // This is AccessTokenPayload

    // Map AccessTokenPayload to AuthContext structure
    // Ensure AuthContext is defined in your src/security.ts or a similar types file
    const authContext: AuthContext = {
      userId: decodedPayload.sub, // Map 'sub' from JWT to 'userId'
      orgId: decodedPayload.orgId,
      venueId: decodedPayload.venueId,
      role: decodedPayload.role,
    };

    req.authContext = authContext;
    next();
  } catch (error) {
    let errorMessage = 'Invalid or expired token.';
    if (error instanceof jwt.TokenExpiredError) {
      errorMessage = 'Token has expired.';
    } else if (error instanceof jwt.JsonWebTokenError) {
      // This covers signature errors, malformed tokens, and custom errors from verifyAccessToken
      errorMessage = `Token verification failed: ${error.message}`;
    } else {
      // Generic error for unexpected issues during token verification
      errorMessage = 'Failed to authenticate token due to an unexpected error.';
      // Log the actual error for server-side debugging if it's not a JWT error
      console.error('Unexpected error during token authentication:', error);
    }
    
    res.status(401).json({
      error: 'Unauthorized',
      message: errorMessage,
    });
  }
};
