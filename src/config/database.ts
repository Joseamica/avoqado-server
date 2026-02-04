import { Pool } from 'pg'
import logger from './logger'
import { DATABASE_URL } from './env' // Assuming DATABASE_URL is exported from env.ts

const pgPool = new Pool({
  connectionString: DATABASE_URL,
  max: 5, // Maximum 5 connections (optimal for 256MB-2GB machines with Neon pooler)
  min: 1, // Keep 1 connection always ready
  idleTimeoutMillis: 30000, // Close idle connections after 30 seconds
  connectionTimeoutMillis: 10000, // Timeout after 10 seconds if can't connect
})

pgPool.on('connect', () => {
  logger.info('PostgreSQL connected successfully via pgPool.')
})

pgPool.on('error', err => {
  // Don't crash on connection errors - pg Pool handles reconnection automatically
  // This commonly happens on cloud platforms (Render, Heroku) due to:
  // - Network blips
  // - Database maintenance windows
  // - Idle connection timeouts
  logger.warn('Connection error on idle client in pgPool (will auto-reconnect)', {
    message: err.message,
    code: (err as any).code,
  })
})

export default pgPool
