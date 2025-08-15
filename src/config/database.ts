import { Pool } from 'pg'
import logger from './logger'
import { DATABASE_URL } from './env' // Assuming DATABASE_URL is exported from env.ts

const pgPool = new Pool({
  connectionString: DATABASE_URL,
})

pgPool.on('connect', () => {
  logger.info('PostgreSQL connected successfully via pgPool.')
})

pgPool.on('error', err => {
  logger.error('Unexpected error on idle client in pgPool', err)
  process.exit(-1) // Or handle more gracefully depending on your strategy
})

export default pgPool
