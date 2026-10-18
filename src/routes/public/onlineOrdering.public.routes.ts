import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { authenticateOrderingCustomerOptional } from '@/middlewares/customerAuth.middleware'
import { ORDERING_UNAVAILABLE_MESSAGE, requirePublicVenueFeatureStrict } from '@/middlewares/requirePublicVenueFeatureStrict.middleware'
import { resolveOperationalVenueBySlug } from '@/middlewares/resolveOperationalVenueBySlug.middleware'
import { resolveVenueBySlug, resolveVenueBySlugIncludingInactive } from '@/middlewares/resolveVenueBySlug.middleware'
import { validateRequest } from '@/middlewares/validation'
import { ipDelCliente } from '@/utils/clientIp'
import * as ctrl from '@/controllers/public/onlineOrdering.public.controller'
import {
  createOrderSchema,
  publicVenueSchema,
  quoteSchema,
  trackingSchema,
  venueSlugGateSchema,
} from '@/schemas/public/onlineOrdering.schema'

const router = Router({ mergeParams: true })

// R10: por la IP REAL del visitante (la de Cloudflare es compartida, ver S14 en `public.routes.ts`) Y por negocio: en México
// las redes celulares comparten IP (CGNAT) y un tope por IP pura para toda la plataforma frenaría a clientes legítimos.
const porVisitanteYNegocio = (req: Parameters<typeof ipDelCliente>[0]) =>
  `${ipDelCliente(req) || 'desconocida'}:${String(req.params?.venueSlug ?? '')}`
const limiter = (max: number) =>
  rateLimit({
    windowMs: 60_000,
    max,
    keyGenerator: porVisitanteYNegocio,
    standardHeaders: true,
    legacyHeaders: false,
    // El 429 también va en el sobre JSON de esta API y en español (el texto por omisión es inglés y plano).
    message: {
      success: false,
      code: 'RATE_LIMIT_EXCEEDED',
      error: 'Demasiadas solicitudes en poco tiempo. Espera un minuto e intenta de nuevo.',
    },
  })
const readLimit = limiter(60)
const createLimit = limiter(5)
const cancelLimit = limiter(10)

const requireOrdering = requirePublicVenueFeatureStrict('ONLINE_ORDERING', ORDERING_UNAVAILABLE_MESSAGE)

// A9: el slug se revisa ANTES que todo lo demás (antes de buscar el negocio en la base): un byte de control o un slug gigante es
// 400 en español, nunca una consulta ni un 500.
router.use(validateRequest(venueSlugGateSchema))

// Superficie de pedidos NUEVOS: venue operativo (sin demo) → plan en modo cerrado → validación (R14: candado estricto).
router.get('/info', readLimit, resolveOperationalVenueBySlug, requireOrdering, validateRequest(publicVenueSchema), ctrl.getInfo)
router.get('/menu', readLimit, resolveOperationalVenueBySlug, requireOrdering, validateRequest(publicVenueSchema), ctrl.getMenu)
router.post('/quote', readLimit, resolveOperationalVenueBySlug, requireOrdering, validateRequest(quoteSchema), ctrl.postQuote)
// P1-06: negocio activo y operativo y plan los exige el servicio a un pedido NUEVO, DESPUÉS de buscar la repetición: un reintento
// de un pedido ya creado recibe SU pedido aunque el plan venza o el negocio deje de operar. Codex r3: aquí sólo quedan rechazos
// que no sueltan la llave (429, 401, 5xx) o que dan lo mismo al mismo envío (cuerpo, cabecera, slug mientras no se renombre); los
// que dependen del estado del negocio se deciden bajo el candado de la llave y se guardan.
router.post(
  '/orders',
  createLimit,
  resolveVenueBySlugIncludingInactive,
  // H1: sólo el token de PEDIDOS (prueba el teléfono); el token de cliente general responde 401 aquí.
  authenticateOrderingCustomerOptional,
  validateRequest(createOrderSchema),
  ctrl.postOrder,
)

// Superficie de lo YA pedido: SIN candado de plan (un cliente con un pedido siempre puede verlo o cancelarlo). El token se
// valida ANTES de buscar el negocio: uno mal formado no cuesta una consulta.
router.get('/orders/:trackingToken', readLimit, validateRequest(trackingSchema), resolveVenueBySlug, ctrl.getOrder)
router.post('/orders/:trackingToken/cancel', cancelLimit, validateRequest(trackingSchema), resolveVenueBySlug, ctrl.postCancel)

export default router
