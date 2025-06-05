import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { PORT } from './env'; // Assuming PORT is exported from env.ts

const swaggerOptions: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Avoqado Backend API',
      version: '1.0.0',
      description: 'Documentación de la API para el backend de Avoqado. Gestiona venues, menús, pedidos, staff y más.',
      contact: {
        name: 'Avoqado Support',
        url: 'https://avoqado.app',
        email: 'support@avoqado.app',
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
      },
    },
  },
  apis: [
    './src/server.ts', // Keep if global definitions are there, or update to new app.ts
    './src/app.ts', // For definitions in the new app.ts
    './src/routes/**/*.ts',
  ],
};

export const swaggerSpec = swaggerJsdoc(swaggerOptions);

export const setupSwaggerUI = (app: import('express').Express) => {
  app.use(
    '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      explorer: true,
      customSiteTitle: 'Avoqado API Docs',
    }),
  );
};
