/**
 * 🔴 Login CSRF por la puerta de al lado (27-sep, junto con el `state` del callback de Google).
 *
 * `POST /auth/google/one-tap` recibe un `credential` (ID token de Google) e inicia sesión con él. El
 * servidor acepta cuerpos de FORMULARIO (`express.urlencoded` global), así que otro sitio podía mandar
 * `<form method=post action=".../auth/google/one-tap"><input name=credential value=…>` con un ID token
 * de la cuenta del ATACANTE: el navegador de la víctima recibía las cookies de sesión del atacante. Un
 * formulario no puede mandar `application/json` sin pasar por CORS, por eso basta exigir JSON — que es
 * lo único que manda el dashboard (`api.post(..., { credential })`).
 *
 * Introspección estática del router REAL de Express: sin mocks y sin DB.
 */
import dashboardRouter from '@/routes/dashboard.routes'
import { requireJsonBodyMiddleware } from '@/middlewares/requireJsonBody.middleware'
import { googleOneTapLogin } from '@/controllers/dashboard/googleOAuth.controller'

function cadena(router: any, method: string, routePath: string): unknown[] {
  for (const layer of router.stack ?? []) {
    if (!layer.route || layer.route.path !== routePath) continue
    const routeLayers: any[] = layer.route.stack ?? []
    if (!routeLayers.some(rl => rl.method === method)) continue
    return routeLayers.map(rl => rl.handle)
  }
  throw new Error(`No existe ${method.toUpperCase()} ${routePath}`)
}

it('🔴 One Tap sólo acepta JSON, y lo revisa ANTES de iniciar sesión', () => {
  const handlers = cadena(dashboardRouter, 'post', '/auth/google/one-tap')
  expect(handlers).toContain(requireJsonBodyMiddleware)
  expect(handlers.indexOf(requireJsonBodyMiddleware)).toBeLessThan(handlers.indexOf(googleOneTapLogin))
})
