// src/config/firebase.ts
import * as admin from 'firebase-admin'
import * as fs from 'fs'
import * as path from 'path'
import logger from './logger'

let firebaseApp: admin.app.App | null = null

/**
 * Initialize Firebase Admin SDK with multiple methods:
 *
 * Method 1 (Easiest for Render): FIREBASE_SERVICE_ACCOUNT_BASE64
 *   - Set base64-encoded JSON as environment variable
 *   - No file system required, works anywhere
 *   - Generate: base64 -i firebase-service-account.json | tr -d '\n'
 *
 * Method 2 (Traditional): GOOGLE_APPLICATION_CREDENTIALS
 *   - Point to JSON file path (local dev or Secret Files)
 *   - Good for local development
 *
 * Method 3 (Automatic): Google Cloud ADC
 *   - No credentials needed on Google Cloud
 *   - Cloud Run, App Engine, Cloud Functions
 *
 * See: https://firebase.google.com/docs/admin/setup
 */
export function initializeFirebase(): admin.app.App {
  if (firebaseApp) {
    return firebaseApp
  }

  try {
    // Detect Google Cloud environment (Cloud Run, App Engine, Cloud Functions)
    const isGoogleCloud = process.env.K_SERVICE || process.env.FUNCTION_NAME || process.env.GAE_SERVICE

    if (isGoogleCloud) {
      // Method 3: Google Cloud - use Application Default Credentials (ADC)
      logger.info('🌐 Detected Google Cloud environment - using Application Default Credentials')
      firebaseApp = admin.initializeApp({
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      })
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
      // Method 1: Base64-encoded credentials (easiest for Render)
      logger.info('🔐 Using base64-encoded service account credentials')
      const base64Credentials = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64
      const credentialsJson = Buffer.from(base64Credentials, 'base64').toString('utf-8')
      const serviceAccount = JSON.parse(credentialsJson)

      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${serviceAccount.project_id}.appspot.com`,
      })
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      // Method 2: File path (traditional approach)
      logger.info('📁 Using service account file from GOOGLE_APPLICATION_CREDENTIALS')
      const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS

      // Resolve relative paths
      const resolvedPath = path.isAbsolute(credentialsPath) ? credentialsPath : path.resolve(process.cwd(), credentialsPath)

      if (!fs.existsSync(resolvedPath)) {
        logger.error(`❌ Service account file not found: ${resolvedPath}`)
        return null as any
      }

      firebaseApp = admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      })
    } else {
      logger.warn('⚠️  No Firebase credentials configured. Choose one of:')
      logger.warn('   1. FIREBASE_SERVICE_ACCOUNT_BASE64 (recommended for Render)')
      logger.warn('   2. GOOGLE_APPLICATION_CREDENTIALS=/path/to/file.json')
      logger.warn('   3. Deploy to Google Cloud (automatic credentials)')
      return null as any
    }

    logger.info('✅ Firebase Admin SDK initialized successfully')
    return firebaseApp
  } catch (error) {
    logger.error('❌ Failed to initialize Firebase Admin SDK:', error)
    return null as any
  }
}

/**
 * Get Firebase Admin app instance
 */
export function getFirebaseApp(): admin.app.App | null {
  if (!firebaseApp) {
    return initializeFirebase()
  }
  return firebaseApp
}

/**
 * Get Firebase Storage bucket
 */
export function getStorageBucket(): admin.storage.Storage | null {
  const app = getFirebaseApp()
  if (!app) {
    return null
  }
  return admin.storage(app)
}
