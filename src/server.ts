// src/server.ts - Main entry point for the application

// Ensure environment variables are loaded and checked first.
// This import will also handle dotenv.config() and exit if critical vars are missing.
import './config/env';

import http from 'http';
import app from './app'; // The configured Express application
import logger from './config/logger';
import { PORT, NODE_ENV } from './config/env';
import pgPool from './config/database'; // Import pgPool for graceful shutdown

const httpServer = http.createServer(app);

const gracefulShutdown = (signal: string) => {
  logger.info(`Received ${signal}. Closing http server.`);
  httpServer.close(async () => {
    logger.info('Http server closed.');
    // Close database connections, etc.
    try {
      await pgPool.end();
      logger.info('PostgreSQL pool has been closed.');
    } catch (e) {
      logger.error('Error closing PostgreSQL pool', e);
    }
    process.exit(0);
  });
};

process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM');
});

process.on('SIGINT', () => {
  gracefulShutdown('SIGINT');
});

// Conditionally start the server only if this script is run directly (not imported as a module)
// This allows Supertest to import the app without starting the server automatically.
if (require.main === module || NODE_ENV !== 'test') {
  httpServer.listen(PORT, () => {
    logger.info(`Server is running on http://localhost:${PORT} in ${NODE_ENV} mode`);
    logger.info(`API documentation available at http://localhost:${PORT}/api-docs`);
    if (NODE_ENV === 'development') {
      logger.warn('Application is running in Development mode.');
    }
  });
}

// Export the server instance, primarily for testing or specific needs.
// app is already exported from app.ts
export { httpServer as server, pgPool };
