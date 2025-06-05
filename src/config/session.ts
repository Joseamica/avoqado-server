import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import pgPool from './database'; // Import the configured pgPool
import logger from './logger';
import { SESSION_SECRET, SESSION_TABLE_NAME, SESSION_MAX_AGE_MS, SESSION_COOKIE_NAME, NODE_ENV } from './env';

const PGStore = connectPgSimple(session);

const sessionStore = new PGStore({
  pool: pgPool,
  tableName: SESSION_TABLE_NAME,
  createTableIfMissing: true,
  // pruneSessionInterval: 600, // Every 10 minutes (in seconds)
  // errorLog: logger.error.bind(logger),
});

const sessionMiddleware = session({
  store: sessionStore,
  secret: SESSION_SECRET,
  name: SESSION_COOKIE_NAME,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: SESSION_MAX_AGE_MS,
    httpOnly: true,
    secure: NODE_ENV === 'production',
    sameSite: 'lax',
  },
});

export default sessionMiddleware;
