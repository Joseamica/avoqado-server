/**
 * Negocios demo (capa 2): todo archivo que manda correo (Resend, o Facturapi con la factura) o WhatsApp (Graph API de Meta) pasa por
 * `omitirPorDemo`. Un transporte nuevo que no lo llame truena aquí, en vez de mandarle mensajes reales a quien un
 * prospecto escribió en el negocio demo. Plan: Avoqado/docs/audit/2026-10-28-negocios-demo/plan.md, sección B.
 */
import fs from 'fs'
import path from 'path'

const SRC = path.join(__dirname, '../../../src')
const SALIDA = /new Resend\(|\.emails\.send\(|graph\.facebook\.com|\.sendInvoiceByEmail\(|google\.walletobjects\(|\bconnect\(host|\bsignPass\(/

/** Transportes que nunca parten de un negocio demo. La razón es obligatoria. */
const NUNCA_TOCAN_UN_DEMO: Record<string, string> = {
  'services/superadmin/platform-billing/platformCfdi.service.ts':
    'facturas de Avoqado a sus clientes, sólo superadmin; un negocio demo no tiene suscripción que facturar',
  'services/wallet/applePassSigner.service.ts':
    'define la firma del pase; su única llamada (issuePass.service) pasa por el candado con el negocio del cliente',
}

function archivos(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return archivos(p)
    return e.name.endsWith('.ts') ? [p] : []
  })
}

/** Cuántos envíos hay en el archivo: cada uno necesita su propio `omitirPorDemo` (Codex r2, 9: uno sin él pasaba). */
const sinComentarios = (codigo: string) => codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

function envios(codigo: string): number {
  const directos = (codigo.match(/\.emails\.send\(|\.sendInvoiceByEmail\(/g) ?? []).length
  const whatsapp = /graph\.facebook\.com/.test(codigo) ? (codigo.match(/\bfetch\(/g) ?? []).length : 0
  const wallet = (codigo.match(/google\.walletobjects\(|\bconnect\(host|\bsignPass\(/g) ?? []).length
  return directos + whatsapp + wallet
}

describe('candado demo: los transportes de mensajes', () => {
  const conSalida = archivos(SRC).filter(f => SALIDA.test(fs.readFileSync(f, 'utf8')))

  it('encuentra los transportes conocidos (si esto baja, la búsqueda se rompió)', () => {
    expect(conSalida.length).toBeGreaterThanOrEqual(6)
  })

  it.each(conSalida.map(f => [path.relative(SRC, f)]))('%s: cada envío pasa por omitirPorDemo', rel => {
    if (rel in NUNCA_TOCAN_UN_DEMO) return
    const codigo = sinComentarios(fs.readFileSync(path.join(SRC, rel), 'utf8'))
    const candados = (codigo.match(/omitirPorDemo\(/g) ?? []).length
    expect(envios(codigo)).toBeGreaterThan(0)
    expect(candados).toBeGreaterThanOrEqual(envios(codigo))
  })
})

/**
 * Pasada exhaustiva (Codex r6): TODO archivo que habla con el exterior (un SDK de afuera o `fetch`) pasa por el candado
 * (`omitirPorDemo`) o dice aquí por qué un negocio demo no lo alcanza. Uno nuevo sin clasificar truena: así la salida
 * siguiente la ve la prueba y no la siguiente ronda de auditoría. Por prefijo de ruta, de lo más específico a lo general.
 */
const EXTERIOR = /from '(?:stripe|googleapis|axios|openai|resend|firebase-admin[^']*|http2|@anthropic-ai\/sdk)'|\bfetch\(/
const POR_QUE_NO_LO_ALCANZA: Array<[prefijo: string, razon: string]> = [
  ['config/firebase.ts', 'inicializa Firebase; no manda nada por sí solo'],
  ['services/customer-display/storageOrigins.ts', 'sólo arma URLs de Storage; no sube nada'],
  ['controllers/google-calendar.controller.ts', 'Google Calendar: conectarlo está cerrado en un demo (google-calendar) y la semilla no conecta ninguno'],
  ['jobs/gcal-', 'Google Calendar: sin conexión no hay a quién llamar (conectar está cerrado en un demo)'],
  ['services/google-calendar/', 'Google Calendar: sin conexión no hay a quién llamar (conectar está cerrado en un demo)'],
  ['services/googleBusinessProfile.service.ts', 'reseñas de Google: requiere conectar Google (integrations y reviews cerrados en un demo)'],
  ['controllers/public/cfdi.public.controller.ts', 'descarga el PDF/XML de una factura ya timbrada (entra, no sale)'],
  [
    'services/fiscal/providers/facturapi.provider.ts',
    'timbra con la llave del emisor del negocio: un demo sólo lleva una de prueba (sk_test_, sin SAT) o ninguna y el alta de emisores está cerrada; el correo de la factura cuenta arriba',
  ],
  ['controllers/superadmin/', 'sólo SUPERADMIN; el usuario demo no entra'],
  ['services/superadmin/', 'sólo SUPERADMIN; el usuario demo no entra'],
  ['controllers/webhook.controller.ts', 'webhooks que ENTRAN de Stripe; un demo no tiene nada en Stripe'],
  ['services/stripe.webhook.service.ts', 'webhooks que ENTRAN de Stripe; un demo no tiene nada en Stripe'],
  ['services/stripe-webhooks/', 'webhooks que ENTRAN de Stripe; un demo no tiene nada en Stripe'],
  ...[
    'jobs/plan-access-reconciliation.job.ts',
    'jobs/plan-renewal-reminder.job.ts',
    'jobs/subscription-cancellation.job.ts',
    'services/stripe.service.ts',
    'services/billing/',
    'utils/stripeSubscriptionPeriod.ts',
    'services/onboarding/planActivation.service.ts',
    'services/launchCampaigns/',
    'services/access/inventarioDeObligaciones.ts',
    'services/shared/cancellationReason.ts',
    'services/dashboard/venueFeature.dashboard.service.ts',
    'services/dashboard/token-budget.service.ts',
    'services/dashboard/terminalOrder/',
  ].map(
    (p): [string, string] => [
      p,
      'plan, suscripción y compras de Avoqado en Stripe: cerradas en un demo (plan, features, hybrid-billing, tpv-orders, tokens; el usuario demo sólo escribe en su negocio) y LIVE_DEMO no tiene suscripción',
    ],
  ),
  [
    'services/dashboard/creditPack.public.service.ts',
    'compra de paquetes: los cobros públicos de un demo dan 403 (negocioDeRutaPublica) y el kiosco pide Stripe Connect, que un demo no tiene',
  ],
  ...[
    'services/payments/providers/stripe-connect.provider.ts',
    'services/mercado-pago/',
    'services/sdk/blumon-ecommerce.service.ts',
    'services/blumon/',
    'services/tpv/',
    'routes/tpv.routes.ts',
    'services/integrations/angelpay-integrations-api.client.ts',
    'services/b4bit/',
    'services/dashboard/cryptoConfig.dashboard.service.ts',
    'services/financial-connections/',
  ].map(
    (p): [string, string] => [
      p,
      'cobro y dinero: un demo no cobra con tarjeta (cuentas de cobro, cripto, bancos y la TPV cerradas; los cobros públicos de un demo dan 403)',
    ],
  ),
  ...['services/delivery-channels/', 'services/commerce-channels/', 'services/aggregators/'].map(
    (p): [string, string] => [
      p,
      'Rappi, Uber, Deliverect, Shopify y TotalPass/Wellhub: conectarlos está cerrado en un demo y la semilla no conecta ninguno',
    ],
  ),
  ['services/integrations/hubspot.client.ts', 'CRM de Avoqado: sólo la landing y el alta directa, nunca desde un negocio demo'],
  ...[
    'services/dashboard/assistant.dashboard.service.ts',
    'services/dashboard/chatbot-',
    'services/dashboard/semantic-injection-detector.service.ts',
    'services/dashboard/text-to-sql-assistant.service.ts',
    'services/dashboard/inventory/market-benchmark.service.ts',
    'services/upsell/upsellAi.service.ts',
  ].map((p): [string, string] => [p, 'IA de Avoqado: una función que el demo sí enseña; contesta en pantalla y no le escribe a nadie']),
  ['services/consumer/auth.consumer.service.ts', 'inicio de sesión de la app del cliente final (verifica con Google); no parte de un negocio'],
  ['services/mobile/push.mobile.service.ts', 'avisos push al personal: en un demo, sólo al teléfono del prospecto que entró con el usuario demo'],
  ['utils/receiptTemplate.ts', 'el recibo digital llama a NUESTRA API desde el navegador'],
  ['mcp/oauth/loginPage.ts', 'la página de login del MCP llama a NUESTRA API'],
]

describe('candado demo: cada salida al exterior está clasificada (pasada exhaustiva, Codex r6)', () => {
  const salidas = archivos(SRC)
    .filter(f => EXTERIOR.test(sinComentarios(fs.readFileSync(f, 'utf8'))))
    .map(f => path.relative(SRC, f).split(path.sep).join('/'))

  it('encuentra las salidas (si esto baja mucho, la búsqueda se rompió)', () => {
    expect(salidas.length).toBeGreaterThan(60)
  })

  it('toda salida pasa por omitirPorDemo o dice por qué un demo no la alcanza', () => {
    const sinClasificar = salidas.filter(
      rel =>
        !/omitirPorDemo\(/.test(sinComentarios(fs.readFileSync(path.join(SRC, rel), 'utf8'))) &&
        !POR_QUE_NO_LO_ALCANZA.some(([prefijo]) => rel.startsWith(prefijo)),
    )
    expect(sinClasificar).toEqual([])
  })

  it('ninguna razón sobra (cada prefijo sigue teniendo una salida)', () => {
    const sobran = POR_QUE_NO_LO_ALCANZA.filter(([prefijo]) => !salidas.some(rel => rel.startsWith(prefijo))).map(([p]) => p)
    expect(sobran).toEqual([])
  })
})
