/**
 * UN servidor HTTP por archivo de pruebas, en vez de uno por PETICIÓN.
 *
 * 🔴 Por qué existe: `request(app)` de supertest levanta un servidor efímero **en cada
 * llamada** — escucha en un puerto libre, atiende una petición y lo cierra. Un archivo con
 * `it.each` sobre 18 rutas hace 61 de esos en 15 segundos, y la suite entera acumula 480
 * llamadas en 23 archivos. Con la máquina cargada alguna conexión no llega a tiempo y el test
 * muere con `connect ETIMEDOUT 127.0.0.1:<puerto>`, que no dice nada del código y tumba
 * `npm run test:api` entero (medido el 2026-08-31 en `print-stations-auth`: falla dentro de la
 * suite completa, pasa en aislamiento).
 *
 * Un test que falla por la carga de la máquina es peor que uno que no existe: entrena a la
 * gente a ignorar el rojo.
 *
 * 🔑 Y de paso es más rápido: ese mismo archivo pasó de 15.7 s a 6.0 s.
 *
 * ## Uso
 *
 * El argumento es una FUNCIÓN, no la app: muchos archivos importan `@/app` dentro de su
 * propio `beforeAll` (después de registrar los mocks), así que en el nivel superior todavía
 * no existe. La función se evalúa cuando el servidor arranca.
 *
 *   let app: any
 *   beforeAll(async () => { app = (await import('@/app')).default })
 *   startApiServer(() => app)          // ⚠️ DESPUÉS del beforeAll que asigna `app`
 *   ...
 *   const res = await api().get('/api/v1/…')
 *
 * ⚠️ El orden importa: jest corre los `beforeAll` en el orden en que se registran, así que
 * esta llamada va después de la que crea la app, o el servidor arrancaría con `undefined`.
 */
import type { Server } from 'http'
import request from 'supertest'

let servidor: Server | null = null

/** Registra el servidor y devuelve un cliente propio para archivos con varias apps. */
export function startApiServer(obtenerApp: () => unknown) {
  let propio: Server | null = null
  beforeAll(done => {
    const app = obtenerApp() as { listen?: Server['listen'] } | undefined
    if (!app || typeof app.listen !== 'function') {
      return done(new Error('startApiServer: la app aún no existe. ¿Va la llamada ANTES del beforeAll que la crea?'))
    }
    // Bind the same IPv4 loopback address that supertest connects to.
    propio = app.listen(0, '127.0.0.1', () => done())
    servidor = propio
  })

  afterAll(done => {
    const s = propio
    propio = null
    if (servidor === s) servidor = null
    if (!s) {
      done()
      return
    }
    // 🔴 Sin esto, `close()` espera a las conexiones vivas y jest se cuelga al terminar el
    // archivo con un «open handle» que nadie relaciona con supertest.
    const conCierreForzado = s as Server & { closeAllConnections?: () => void }
    conCierreForzado.closeAllConnections?.()
    s.close(() => done())
  })

  return () => {
    if (!propio) throw new Error('El servidor de esta app aún no está iniciado o ya se cerró.')
    return request(propio)
  }
}

/** El cliente de supertest apuntando al servidor de ESTE archivo. */
export function api() {
  if (!servidor) {
    throw new Error('Llama a startApiServer(() => app) en el nivel superior del archivo antes de usar api().')
  }
  return request(servidor)
}
