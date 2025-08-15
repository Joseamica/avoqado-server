import express, { Express } from 'express'
import helmet from 'helmet'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import compression from 'compression'
import { getCorsConfig, Environment } from './corsOptions' // Assuming corsOptions.ts is in src/config
import { requestLoggerMiddleware } from '../middlewares/requestLogger' // Assuming requestLogger.ts is in src/middlewares
import logger from './logger'
import { NODE_ENV, COOKIE_SECRET, BODY_JSON_LIMIT, BODY_URLENCODED_LIMIT } from './env'
import sessionMiddleware from './session'

export const configureCoreMiddlewares = (app: Express) => {
  // Apply compression first for all responses
  app.use(compression())

  // Request logger (should be early, but after static files or health checks if they shouldn't be logged extensively)
  app.use(requestLoggerMiddleware)

  // Security headers with Helmet
  app.use(helmet())

  // CORS configuration
  app.use(cors(getCorsConfig(NODE_ENV as Environment)))

  // Body parsers with size limits
  logger.info(`Configuring body-parser: JSON limit ${BODY_JSON_LIMIT}, URL-encoded limit ${BODY_URLENCODED_LIMIT}`)
  app.use(express.json({ limit: BODY_JSON_LIMIT }))
  app.use(express.urlencoded({ extended: true, limit: BODY_URLENCODED_LIMIT }))

  // Cookie parser with secret
  app.use(cookieParser(COOKIE_SECRET))

  // Session middleware (depends on cookie parser and database pool)
  app.use(sessionMiddleware)

  logger.info('Core middlewares configured.')
}
