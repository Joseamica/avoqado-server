import { SocketServerConfig } from '../types'
import { NODE_ENV } from '../../../config/env'

/**
 * Socket.io Server Configuration
 * Following the same pattern as other config files in the project
 */
const getSocketConfig = (): SocketServerConfig => {
  const isDevelopment = NODE_ENV === 'development'

  return {
    cors: {
      origin: [
        // Production/development domains
        'https://www.dashboard.avoqado.io',
        'https://dashboard.avoqado.io',
        'https://www.demo.avoqado.io',
        'https://demo.avoqado.io',
        'https://avoqado.io',
        'https://www.avoqado.io',
        'https://avo-demo.onrender.com',

        // Local development
        ...(isDevelopment
          ? [
              'http://localhost:5173',
              'http://localhost:3000',
              'http://localhost:4173',
              'http://localhost:5000',
              'http://localhost:8080',
              'http://localhost:8081',
              'http://localhost:3000',

              // Local IP addresses
              'http://10.211.55.3:5173',
              'http://10.211.55.3:3000',
              'http://10.211.55.3:4173',
              'http://10.211.55.3:5000',
              'http://10.211.55.3:8080',
              'http://10.211.55.3:8081',

              // Tailscale IP
              'http://100.101.16.47:5173',
              'http://100.101.16.47:3000',
              'http://100.101.16.47:4173',
              'http://100.101.16.47:5000',
              'http://100.101.16.47:8080',
              'http://100.101.16.47:8081',
            ]
          : []),
      ],
      methods: ['GET', 'POST', 'DELETE', 'PATCH', 'PUT'],
      credentials: true,
    },

    rateLimit: {
      windowMs: isDevelopment ? 60 * 1000 : 15 * 60 * 1000, // 1 min dev, 15 min prod
      maxConnections: isDevelopment ? 1000 : 500, // Higher limit in dev for testing
      maxEventsPerWindow: isDevelopment ? 1000 : 100, // Events per window
    },

    // ✅ FIXED: Use REDIS_URL directly instead of parsing individual components
    redis: process.env.REDIS_URL
      ? {
          url: process.env.REDIS_URL, // ✅ Use Railway's Redis URL
        }
      : undefined,
    authentication: {
      required: true,
      timeout: 10000, // 10 seconds to authenticate
    },
  }
}

export const socketConfig = getSocketConfig()
export default socketConfig
