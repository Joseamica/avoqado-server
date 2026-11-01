/**
 * Negocios demo (capa 3): un job no trae negocio en el contexto, así que la red de los transportes sólo lo frena si el
 * destinatario es @demo.avoqado.io. Un prospecto puede escribir un correo o teléfono real en el demo, así que todo job que
 * PUEDA llegar a un transporte de mensajes (directo o a través de servicios, hasta 3 saltos de importación) hace una de dos:
 *   · corre cada fila con su negocio en el contexto (`conNegocio`) o excluye LIVE_DEMO, con la marca «candado demo, capa 3»;
 *   · o declara aquí por qué nunca toca un negocio demo.
 * Codex r1 (hallazgo 4) encontró dos colas que una búsqueda de importaciones directas no veía.
 * Plan: Avoqado/docs/audit/2026-10-28-negocios-demo/plan.md, sección B.
 */
import fs from 'fs'
import path from 'path'

const SRC = path.join(__dirname, '../../../src')
const JOBS = path.join(SRC, 'jobs')
const SALIDA = /new Resend\(|\.emails\.send\(|graph\.facebook\.com|\.sendInvoiceByEmail\(/
const SALTOS = 3

/** Jobs que pueden llegar a un mensaje pero nunca a partir de un negocio demo. La razón es obligatoria. */
const NUNCA_TOCAN_UN_DEMO: Record<string, string> = {
  'giftCardDelivery.job.ts': 'cada entrega corre con conNegocio(e.venueId) en giftCardDelivery.service (la prueba de abajo lo exige)',
  'altas-a-medio-pago.job.ts': 'altas de la landing a medio pagar; un negocio demo no pasa por el alta',
  'campaign-sender.job.ts': 'sólo manda lo que se publicó (bloqueado en el demo, capa 1) o encoló cumpleaños (sólo negocios ACTIVE)',
  'cfdiGlobal.job.ts': 'el correo de la factura pasa por cfdiEmail.enviar, que revisa el negocio de la factura (capa 2)',
  'cfdiReconcile.job.ts': 'el correo de la factura pasa por cfdiEmail.enviar, que revisa el negocio de la factura (capa 2)',
  'customer-approval-outbox.job.ts': 'cada fila corre con conNegocio en customerApprovalOutbox.service',
  'documentRequests.job.ts': 'avisa al equipo de Avoqado (onboarding@ y daniel@), no a personas del negocio',
  'gcal-horizon-refresh.job.ts': 'Google Calendar; conectarlo está bloqueado en el demo (capa 1)',
  'kiosk-outreach.job.ts': 'cada fila corre con conNegocio en kioskOutreach.service',
  'negocios-demo-reinicio.job.ts': 'siembra cada negocio con conNegocio (negociosDemo.service): lo que mande ya es de un demo',
  'marketing-campaign.job.ts': 'campañas de Avoqado; cada envío revisa el negocio de su fila y el dominio demo (capa 2)',
  'online-order-acceptance-expiry.job.ts': 'pedidos en línea; LIVE_DEMO no recibe pedidos (resolveOperationalVenueBySlug)',
  'plan-access-reconciliation.job.ts': 'planes de Stripe; el demo no puede contratar (capa 1)',
  'plan-renewal-reminder.job.ts': 'planes de Stripe; el demo no puede contratar (capa 1)',
  'plan-winback.job.ts': 'planes de Stripe; el demo no puede contratar (capa 1)',
  'reservation-deposit-reconciliation.job.ts': 'depósitos con Stripe Connect; el demo no tiene cuenta de cobro (capa 1)',
  'shopify-worker.job.ts': 'Shopify; conectarlo está bloqueado en el demo (capa 1 y shopify.connect.service)',
  'stripe-webhook-reconciliation.job.ts': 'eventos de Stripe de suscripciones; el demo no puede contratar (capa 1)',
  'subscription-cancellation.job.ts': 'planes de Stripe; el demo no puede contratar (capa 1)',
  'terminal-payment-watchdog.job.ts': 'cobros en terminal; el demo no tiene terminales (la TPV queda fuera)',
  'tpv-order-expiry.job.ts': 'compras de terminales; el demo no puede comprar (capa 1)',
  'venue-commission-settlement.job.ts': 'reporte interno a Avoqado de comisiones de agregador; los demos no tienen agregador',
  'weekly-new-customers-report.job.ts': 'reporte interno a Avoqado sólo de negocios ACTIVE',
}

const cache = new Map<string, string[]>()
function importaciones(archivo: string): string[] {
  const hit = cache.get(archivo)
  if (hit) return hit
  const codigo = fs.readFileSync(archivo, 'utf8')
  const out: string[] = []
  for (const m of codigo.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = m[1] ?? m[2]
    const base = spec.startsWith('@/')
      ? path.join(SRC, spec.slice(2))
      : spec.startsWith('.')
        ? path.resolve(path.dirname(archivo), spec)
        : null
    if (!base) continue
    const real = [`${base}.ts`, path.join(base, 'index.ts')].find(c => fs.existsSync(c))
    if (real) out.push(real)
  }
  cache.set(archivo, out)
  return out
}

function llegaAUnMensaje(job: string): boolean {
  const vistos = new Set([job])
  let frontera = [job]
  for (let i = 0; i < SALTOS; i++) {
    frontera = frontera.flatMap(importaciones).filter(f => !vistos.has(f) && vistos.add(f))
  }
  return [...vistos].some(f => SALIDA.test(fs.readFileSync(f, 'utf8')))
}

const sinComentarios = (codigo: string) => codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const jobsConMensajes = fs
  .readdirSync(JOBS)
  .filter(f => f.endsWith('.ts'))
  .filter(f => llegaAUnMensaje(path.join(JOBS, f)))

describe('candado demo: jobs que pueden mandar mensajes', () => {
  it('encuentra los jobs que llegan a un mensaje (si esto baja mucho, la búsqueda se rompió)', () => {
    expect(jobsConMensajes.length).toBeGreaterThanOrEqual(25)
  })

  it.each(jobsConMensajes.map(f => [f]))('%s lleva el candado o declara por qué nunca toca un demo', f => {
    if (f in NUNCA_TOCAN_UN_DEMO) return
    // Sobre el CÓDIGO, sin comentarios: un comentario que quedó tras quitar `conNegocio` ya no cuenta (Codex r2, 9).
    const codigo = sinComentarios(fs.readFileSync(path.join(JOBS, f), 'utf8'))
    const porFila = /conNegocio\(/.test(codigo)
    const excluye = /not:\s*(?:VenueStatus\.LIVE_DEMO|'LIVE_DEMO')/.test(codigo)
    const soloActivos = /status:\s*\{\s*in:\s*\[VenueStatus\.ACTIVE/.test(codigo) && !/LIVE_DEMO/.test(codigo)
    expect(porFila || excluye || soloActivos).toBe(true)
  })

  it('la lista de excepciones sólo tiene jobs que existen y que de verdad llegan a un mensaje', () => {
    for (const f of Object.keys(NUNCA_TOCAN_UN_DEMO)) expect(jobsConMensajes).toContain(f)
  })
})

it('las tarjetas de regalo se entregan con el negocio de cada tarjeta en el contexto (la venta está permitida en el demo)', () => {
  const servicio = sinComentarios(fs.readFileSync(path.join(JOBS, '../services/giftCards/giftCardDelivery.service.ts'), 'utf8'))
  expect(servicio).toMatch(/conNegocio\(e\.venueId, \(\) => entregarUna\(/)
})
