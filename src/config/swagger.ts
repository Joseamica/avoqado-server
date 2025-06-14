import swaggerJsdoc from 'swagger-jsdoc'
import swaggerUi from 'swagger-ui-express'
import { PORT } from './env' // Assuming PORT is exported from env.ts
import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

const swaggerOptions: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Avoqado Backend API',
      version: '1.0.0',
      description: 'Documentación de la API para el backend de Avoqado. Gestiona venues, menús, pedidos, staff y más.',
      contact: {
        name: 'Avoqado Support',
        url: 'https://avoqadoapp.com',
        email: 'hola@avoqado.io',
      },
    },
    servers: [
      {
        url: `http://localhost:${PORT}`,
        description: 'Servidor de Desarrollo (sin /api/v1 base path, añadir en cada endpoint)',
      },
      {
        url: `http://localhost:${PORT}/api/v1`,
        description: 'Servidor de Desarrollo (con /api/v1 base path)',
      },
      // TODO: Add production server URL when available
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          description: 'Respuesta de error estándar.',
          properties: {
            message: {
              type: 'string',
              description: 'Mensaje descriptivo del error.',
              example: 'El recurso solicitado no fue encontrado.',
            },
            error: {
              type: 'string',
              description: 'Código de error interno (opcional).',
              example: 'RESOURCE_NOT_FOUND',
              nullable: true,
            },
            details: {
              type: 'object',
              description: 'Detalles adicionales sobre el error (opcional).',
              additionalProperties: true,
              nullable: true,
              example: { field: 'id', issue: 'Formato inválido' },
            },
          },
          required: ['message'],
        },
        PosOrderPayload: {
          type: 'object',
          properties: {
            externalId: {
              type: 'string',
              description: 'ID externo del sistema POS',
              example: 'pos-12345'
            },
            venueId: {
              type: 'string',
              description: 'ID de la sede (formato CUID)',
              example: 'clj0a1b2c3d4e5f6g7h8i9j0'
            },
            orderNumber: {
              type: 'string',
              description: 'Número de orden visible para el cliente',
              example: 'ORDER-123'
            },
            subtotal: {
              type: 'number',
              description: 'Subtotal de la orden (sin impuestos)',
              example: 100.50
            },
            taxAmount: {
              type: 'number',
              description: 'Monto de impuestos',
              example: 16.08
            },
            total: {
              type: 'number',
              description: 'Total de la orden (con impuestos)',
              example: 116.58
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
              description: 'Fecha y hora de creación de la orden',
              example: '2023-06-13T10:15:30Z'
            },
            posRawData: {
              type: 'object',
              description: 'Datos brutos del sistema POS',
              example: {
                source: 'toast',
                rawPayload: { /* datos específicos del POS */ }
              }
            },
            discountAmount: {
              type: 'number',
              description: 'Monto del descuento aplicado',
              example: 10.00
            },
            tipAmount: {
              type: 'number',
              description: 'Monto de propina',
              example: 15.00
            }
          },
          required: ['externalId', 'venueId', 'orderNumber', 'subtotal', 'taxAmount', 'total', 'createdAt']
        },
        Order: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'ID único de la orden (CUID)',
              example: 'clj0a1b2c3d4e5f6g7h8i9j0'
            },
            orderNumber: {
              type: 'string',
              description: 'Número visible de la orden',
              example: 'ORDER-123'
            },
            externalId: {
              type: 'string',
              description: 'ID en el sistema externo (POS)',
              example: 'pos-12345'
            },
            venueId: {
              type: 'string',
              description: 'ID de la sede',
              example: 'clj0a1b2c3d4e5f6g7h8i9j0'
            },
            subtotal: {
              type: 'number',
              description: 'Subtotal de la orden',
              example: 100.50
            },
            taxAmount: {
              type: 'number',
              description: 'Impuestos aplicados',
              example: 16.08
            },
            total: {
              type: 'number',
              description: 'Total de la orden',
              example: 116.58
            },
            status: {
              type: 'string',
              enum: ['PENDING', 'PROCESSED', 'COMPLETED', 'CANCELLED'],
              description: 'Estado actual de la orden'
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
              description: 'Fecha y hora de creación'
            },
            updatedAt: {
              type: 'string',
              format: 'date-time',
              description: 'Fecha y hora de última actualización'
            }
          },
          required: ['id', 'orderNumber', 'venueId', 'subtotal', 'taxAmount', 'total', 'status', 'createdAt', 'updatedAt']
        },
      },
    },
  },
  apis: [
    './src/server.ts', // Keep if global definitions are there, or update to new app.ts
    './src/app.ts', // For definitions in the new app.ts
    './src/routes/**/*.ts',
  ],
}

export const swaggerSpec = swaggerJsdoc(swaggerOptions)

// Middleware to protect Swagger UI with authentication
const swaggerAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
  try {
    // Check for cookie-based authentication first (Dashboard Web)
    let token = req.cookies?.accessToken

    // If no cookie, check for Bearer token in Authorization header (TPV/API)
    if (!token) {
      const authHeader = req.headers['authorization']
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7)
      }
    }

    // For development only: Allow access to API docs without authentication
    // Remove or comment this in production
    if (process.env.NODE_ENV === 'development' && process.env.ALLOW_DOCS_WITHOUT_AUTH === 'true') {
      return next()
    }

    if (!token) {
      return res.status(401).send(`
        <html>
          <head>
            <title>Authentication Required</title>
            <style>
              body { 
                font-family: Arial, sans-serif; 
                padding: 40px; 
                max-width: 600px; 
                margin: 0 auto; 
                text-align: center; 
              }
              h1 { color: #e53e3e; }
              p { margin-bottom: 20px; line-height: 1.6; }
              .form-group { 
                margin-bottom: 15px; 
                text-align: left;
              }
              label {
                display: block;
                margin-bottom: 5px;
                font-weight: bold;
              }
              input {
                width: 100%;
                padding: 8px;
                border: 1px solid #ccc;
                border-radius: 4px;
                font-size: 16px;
              }
              .btn { 
                display: inline-block; 
                background: #3182ce; 
                color: white; 
                padding: 10px 20px; 
                text-decoration: none; 
                border-radius: 4px; 
                border: none;
                cursor: pointer;
                font-size: 16px;
                width: 100%;
              }
              .btn:hover { background: #2b6cb0; }
              .error-message {
                color: #e53e3e;
                margin-top: 10px;
                display: none;
              }
              .link {
                display: inline-block;
                margin-top: 15px;
                color: #3182ce;
                text-decoration: none;
              }
              .link:hover {
                text-decoration: underline;
              }
            </style>
          </head>
          <body>
            <h1>Authentication Required</h1>
            <p>Please log in to access the API documentation</p>
            
            <form action="/api/v1/dashboard/auth/login" method="POST" id="loginForm">
              <div class="form-group">
                <label for="email">Email</label>
                <input type="email" id="email" name="email" required placeholder="your@email.com">
              </div>
              <div class="form-group">
                <label for="password">Password</label>
                <input type="password" id="password" name="password" required placeholder="Password">
              </div>
              <input type="hidden" name="redirectUrl" value="/api-docs">
              <button type="submit" class="btn">Log In</button>
            </form>
            
            <div id="errorMessage" class="error-message">Invalid email or password</div>
            
            <a href="/dashboard/login" class="link">Go to Dashboard Login Page</a>
          </body>
        </html>
      `)
    }

    // Verify the token
    jwt.verify(token, process.env.ACCESS_TOKEN_SECRET!)
    next()
  } catch (error) {
    // Clear cookie if it exists but is invalid
    if (req.cookies?.accessToken) {
      res.clearCookie('accessToken')
    }

    return res.status(401).send(`
      <html>
        <head>
          <title>Authentication Required</title>
          <style>
            body { 
              font-family: Arial, sans-serif; 
              padding: 40px; 
              max-width: 600px; 
              margin: 0 auto; 
              text-align: center; 
            }
            h1 { color: #e53e3e; }
            p { margin-bottom: 20px; line-height: 1.6; }
            .form-group { 
                margin-bottom: 15px; 
                text-align: left;
              }
              label {
                display: block;
                margin-bottom: 5px;
                font-weight: bold;
              }
              input {
                width: 100%;
                padding: 8px;
                border: 1px solid #ccc;
                border-radius: 4px;
                font-size: 16px;
              }
              .btn { 
                display: inline-block; 
                background: #3182ce; 
                color: white; 
                padding: 10px 20px; 
                text-decoration: none; 
                border-radius: 4px; 
                border: none;
                cursor: pointer;
                font-size: 16px;
                width: 100%;
              }
              .btn:hover { background: #2b6cb0; }
              .error-message {
                color: #e53e3e;
                margin-top: 10px;
                display: block;
              }
              .link {
                display: inline-block;
                margin-top: 15px;
                color: #3182ce;
                text-decoration: none;
              }
              .link:hover {
                text-decoration: underline;
              }
          </style>
        </head>
        <body>
          <h1>Authentication Failed</h1>
          <p>Your session has expired or is invalid. Please log in again to access the API documentation.</p>
          
          <form action="/api/v1/dashboard/auth/login" method="POST" id="loginForm">
            <div class="form-group">
              <label for="email">Email</label>
              <input type="email" id="email" name="email" required placeholder="your@email.com">
            </div>
            <div class="form-group">
              <label for="password">Password</label>
              <input type="password" id="password" name="password" required placeholder="Password">
            </div>
            <input type="hidden" name="redirectUrl" value="/api-docs">
            <button type="submit" class="btn">Log In</button>
          </form>
          
          <div id="errorMessage" class="error-message">Your session has expired. Please log in again.</div>
          
          <a href="/dashboard/login" class="link">Go to Dashboard Login Page</a>
        </body>
      </html>
    `)
  }
}

export const setupSwaggerUI = (app: import('express').Express) => {
  app.use(
    '/api-docs',
    swaggerAuthMiddleware, // Add authentication middleware before swagger UI
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      explorer: true,
      customSiteTitle: 'Avoqado API Docs',
    }),
  )
}
