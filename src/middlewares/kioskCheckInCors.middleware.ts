/**
 * CORS acotado para el consumo del reto de check-in.
 *
 * 🔴 Por qué existe: todo `/api/v1/public` corre hoy con `origin: '*'` — correcto para lo
 * que es (menús, recibos, páginas embebibles sin sesión). Este endpoint NO es eso: opera
 * sobre una sesión de cliente autenticada. Con `*`, cualquier página que la persona
 * visitara podría dispararlo con su sesión puesta.
 *
 * La lista sale de `corsOptions.ts` —la misma que ya gobierna al resto de la API— más lo
 * que se añada por `KIOSK_CHECKIN_ORIGINS` (separado por comas), que es la vía para un
 * dominio propio de un venue sin tocar código.
 */

import cors from 'cors'

const EXTRA = (process.env.KIOSK_CHECKIN_ORIGINS ?? '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)

const BASE: Record<string, string[]> = {
  development: ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:3001'],
  staging: ['https://book.staging.avoqado.io'],
  production: ['https://book.avoqado.io', 'https://avoqado.io'],
}

function allowed(): string[] {
  const env = process.env.NODE_ENV === 'production' ? 'production' : process.env.NODE_ENV === 'staging' ? 'staging' : 'development'
  return [...(BASE[env] ?? []), ...EXTRA]
}

export const kioskCheckInCors = cors({
  origin(origin, callback) {
    // Sin `Origin` (la propia app, curl, un webview) no hay nada que restringir: CORS
    // protege al NAVEGADOR de un tercero, no es autenticación.
    if (!origin) return callback(null, true)
    if (allowed().includes(origin)) return callback(null, true)
    return callback(new Error(`Origen no permitido para el check-in del kiosco: ${origin}`))
  },
  credentials: false,
  methods: ['POST', 'OPTIONS'],
})
