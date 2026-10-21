// src/controllers/commerce-channels/shopify.oauth.controller.ts
/**
 * GET /api/v1/shopify/oauth/callback — PÚBLICO: Shopify redirige aquí el navegador del dueño sin sesión de Avoqado. La
 * prueba de origen es el `hmac` de Shopify y el `state` firmado; los valida `handleShopifyCallback` (B), que también
 * decide a dónde regresar (con `?intent=`, `?reautorizada=1` o `?error=`). Aquí sólo se traduce a HTTP.
 */
import { Request, Response } from 'express'
import logger from '@/config/logger'
import { handleShopifyCallback } from '@/services/commerce-channels/shopify/shopify.connect.service'

const FALLO = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Shopify · Avoqado</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h1 style="font-size:1.25rem">No pudimos terminar la conexión con Shopify</h1>
<p>Vuelve a Avoqado, entra a Configuración → Integraciones → Shopify e inténtalo otra vez. Si se repite, escríbenos.</p>
</body></html>`

export async function shopifyOAuthCallback(req: Request, res: Response): Promise<void> {
  try {
    // T7: el query va SIN TOCAR. Un parámetro repetido llega como arreglo y el servicio lo rechaza con FIRMA: filtrarlo
    // aquí convertiría una consulta que Shopify nunca firmó en una que sí podría cuadrar.
    res.redirect(303, await handleShopifyCallback(req.query as Record<string, string>))
  } catch (err) {
    logger.error('[SHOPIFY] el callback de OAuth falló', { error: (err as Error).message })
    res.status(500).type('html').send(FALLO)
  }
}
