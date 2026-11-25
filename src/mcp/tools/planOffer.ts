/**
 * La oferta de los planes (Pro y Premium) desde el MCP: leerla, publicar una versión nueva y resolver una pendiente
 * (planes editables B1, Task 10).
 *
 * 🔴 SOLO SUPERADMIN, con defensa doble: `registerLaunchCampaignTools` sólo se registra para superadmin y cada manejador lo vuelve a
 * comprobar. Es la oferta de PLATAFORMA (lo que se le cobra a todos los negocios), no datos de un local.
 * 🔴 Las escrituras van por `requireWriteScopeAlways` y por la confirmación de dos pasos del catálogo, que ata el token a la
 * `entrada` y a `expectedRevision`: confirmar con otras es pedir una vista previa nueva.
 * 🔴 Dinero: lo que se LEE va en PESOS, 1:1. La `entrada` que se publica es la del editor y de la ruta HTTP: centavos SIN IVA.
 * Los servicios escriben su propia bitácora; `auditMcpWrite` agrega la del MCP (sin negocio: `venueId: null`).
 * El interruptor y los destinatarios de los avisos NO son herramientas: sólo se tocan desde la pantalla.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { requireWriteScopeAlways } from '../requireWriteScopeAlways'
import {
  descartarPublicacion,
  estadoDeLaOferta,
  publicarVersion,
  reintentarPublicacion,
  vistaPreviaDeLaOferta,
} from '@/services/billing/planOfferPublisher'
import { brutoDeNeto, type PlanOfferDefinition, type PlanOfferInput, type PlanPagado } from '@/services/billing/planOffer'

const SOLO_AVOQADO = 'Solo Avoqado puede ver o cambiar la oferta de los planes.'
const confirm = z.boolean().optional().describe('true sólo después de revisar y aceptar la vista previa')

const CENTAVOS = 'en centavos SIN IVA (p. ej. 79900 = $799.00)'
const entradaDelPlan = z
  .object({
    displayName: z.string().describe('Nombre del plan que verá el cliente'),
    onSale: z.boolean().describe('Si el plan se vende'),
    requiresCard: z.boolean().describe('Si la prueba pide tarjeta'),
    trialDays: z.number().int().describe('Días de prueba'),
    monthlyNetCents: z.number().int().describe(`Precio mensual ${CENTAVOS}`),
    annualNetCents: z.number().int().describe(`Precio anual ${CENTAVOS}`),
  })
  .strict()
const entrada = z
  .object({
    FREE: z.object({ displayName: z.string().describe('Nombre del plan gratis') }).strict(),
    PRO: entradaDelPlan,
    PREMIUM: entradaDelPlan,
  })
  .strict()
  .describe(`La oferta completa que se quiere publicar. Todo precio va ${CENTAVOS}: no pesos, no con IVA.`)

// Compile-time: la forma local no se puede separar de `planOfferInput` (ni sobra ni falta un campo).
const _formaIgual: z.ZodType<PlanOfferInput> = entrada
void _formaIgual

const pesos = (cents: number) => cents / 100
const dinero = (netCents: number, grossCents: number) => ({ sinIva: pesos(netCents), conIva: pesos(grossCents) })
const texto = (value: { sinIva: number; conIva: number }) => `$${value.sinIva.toFixed(2)} sin IVA ($${value.conIva.toFixed(2)} con IVA)`
const NOMBRE_DEL_PLAN: Record<PlanPagado, string> = { PRO: 'Pro', PREMIUM: 'Premium' }
const CAMPOS_EN_CENTAVOS: Record<string, string> = { monthlyNetCents: 'mensual sin IVA', annualNetCents: 'anual sin IVA' }

/** Nada que salga del MCP lleva centavos: un valor bajo una llave `...Cents` se convierte a pesos y la llave pasa a `...Pesos`. */
function enPesos(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(enPesos)
  if (value instanceof Date || value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, v]) =>
      /cents$/i.test(key) && typeof v === 'number' ? [key.replace(/cents$/i, 'Pesos'), v / 100] : [key, enPesos(v)],
    ),
  )
}

const mxn = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Los cambios de la vista previa en los términos de quien lee: dinero en pesos y el campo con nombre de persona. */
function cambiosEnPesos(cambios: Array<{ plan: string; campo: string; antes: unknown; despues: unknown }>) {
  return cambios.map(c => {
    const periodo = CAMPOS_EN_CENTAVOS[c.campo]
    if (!periodo) return { plan: c.plan, campo: c.campo, antes: c.antes, despues: c.despues }
    const nombre = NOMBRE_DEL_PLAN[c.plan as PlanPagado] ?? c.plan
    const [antes, despues] = [Number(c.antes) / 100, Number(c.despues) / 100]
    const [antesIva, despuesIva] = [brutoDeNeto(Number(c.antes)) / 100, brutoDeNeto(Number(c.despues)) / 100]
    return {
      plan: c.plan,
      campo: `${nombre} ${periodo}`,
      antes,
      despues,
      resumen: `${nombre} ${periodo.split(' ')[0]}: ${mxn(antes)} → ${mxn(despues)} sin IVA (${mxn(antesIva)} → ${mxn(despuesIva)} con IVA)`,
    }
  })
}

const PLANES: readonly PlanPagado[] = ['PRO', 'PREMIUM']

function planesEnPesos(definition: PlanOfferDefinition) {
  const planes: Record<string, unknown> = { FREE: { nombre: definition.FREE.displayName } }
  for (const tier of PLANES) {
    const p = definition[tier]
    planes[tier] = {
      nombre: p.displayName,
      enVenta: p.onSale,
      pideTarjeta: p.requiresCard,
      diasDePrueba: p.trialDays,
      mensual: dinero(p.monthly.netCents, p.monthly.grossCents),
      anual: dinero(p.annual.netCents, p.annual.grossCents),
    }
  }
  return planes
}

const RECHAZOS = new Set([
  'PLAN_EDIT_DISABLED',
  'PLAN_OFFER_STALE',
  'PLAN_OFFER_PENDING',
  'PLAN_OFFER_PREPARING',
  'PLAN_PRICE_BLOCKED_BY_CAMPAIGNS',
  'HYBRID_LIST_BREAKS_PROMOTIONS',
  'PLAN_OFFER_INVALID',
  'PLAN_OFFER_UNCHANGED',
])

/** Los rechazos con motivos (campañas que lo bloquean, promociones que rompe, problemas de la entrada) regresan como datos. */
function refusal(error: unknown) {
  const e = error as { isOperational?: boolean; message?: string; code?: string; details?: unknown }
  if (e?.isOperational !== true || !e.code || !RECHAZOS.has(e.code)) throw error
  return text({ ok: false, error: e.message, codigo: e.code, detalles: enPesos(e.details ?? null) })
}

export function registerPlanOfferTools(server: McpServer, scope: McpScope): void {
  const forbidden = () => text({ ok: false, error: SOLO_AVOQADO })
  const write = () =>
    requireWriteScopeAlways(scope, 'plan-offer:write', 'cambia la oferta de los planes que se le cobra a todos los negocios')

  server.tool(
    'get_plan_offer',
    'Lee la oferta de los planes: por plan, nombre, si está en venta, si la prueba pide tarjeta, días de prueba y precio mensual y anual sin y con IVA, en pesos MXN. Trae la revisión vigente (hay que pasarla al publicar), la entrada con la forma que acepta publish_plan_offer (esa sí en centavos sin IVA), la versión pendiente con su motivo si una publicación quedó a medias, el estado del interruptor con lo que le falta para prenderse y el renombre pendiente en Stripe. Sólo lectura. Sólo para Avoqado.',
    {},
    async () => {
      if (!scope.isSuperAdmin) return forbidden()
      const estado = await estadoDeLaOferta()
      return text({
        ok: true,
        revision: estado.revision,
        vigente: {
          numero: estado.vigente.number,
          versionId: estado.vigente.versionId,
          publicadaEn: estado.vigente.publishedAt,
          planes: planesEnPesos(estado.vigente.definition),
        },
        entrada: estado.vigente.entrada,
        pendiente: estado.pendiente
          ? {
              versionId: estado.pendiente.versionId,
              creadaEn: estado.pendiente.creadaAt,
              planes: planesEnPesos(estado.pendiente.definition),
              preparacion: enPesos(estado.pendiente.preparacion),
            }
          : null,
        interruptor: { prendido: estado.interruptor.prendido, desde: estado.interruptor.desde, faltan: estado.interruptor.faltan },
        renombrePendiente: enPesos(estado.nombresEnStripe),
      })
    },
  )

  server.tool(
    'publish_plan_offer',
    'Publica una versión nueva de la oferta de los planes (nombres, en venta, tarjeta, prueba y precios de Pro y Premium). Quien ya paga conserva su precio; el nuevo se crea en Stripe y sólo se vende cuando está listo. Sin confirm devuelve, por plan, el precio actual y el nuevo en pesos (sin y con IVA) y lo que se bloquea, sin escribir; con confirm:true publica exactamente esa entrada sobre la revisión que dio get_plan_offer. Si la oferta cambió, hay otra versión pendiente, el interruptor está apagado o una campaña o promoción lo impide, regresa el motivo como dato. En la entrada todo precio va en centavos SIN IVA (79900 = $799.00). Sólo para Avoqado.',
    {
      entrada,
      expectedRevision: z.number().int().min(0).describe('La revisión vigente según get_plan_offer'),
      confirm,
    },
    async ({ entrada: oferta, expectedRevision, confirm: approved }) => {
      if (!scope.isSuperAdmin) return forbidden()
      write()
      try {
        if (!approved) {
          const [vista, estado] = await Promise.all([vistaPreviaDeLaOferta(oferta), estadoDeLaOferta()])
          const definicion = estado.vigente.definition
          const precios = PLANES.flatMap(tier =>
            (['monthly', 'annual'] as const).map(periodo => {
              const actual = definicion[tier][periodo]
              const neto = oferta[tier][periodo === 'monthly' ? 'monthlyNetCents' : 'annualNetCents']
              return {
                plan: tier,
                periodo: periodo === 'monthly' ? 'mensual' : 'anual',
                actual: dinero(actual.netCents, actual.grossCents),
                nuevo: dinero(neto, brutoDeNeto(neto)),
              }
            }),
          )
          const avisoDeRevision =
            estado.revision !== expectedRevision ? 'La oferta cambió desde que la leíste; vuelve a leerla antes de confirmar.' : null
          const lineas = precios
            .filter(p => p.actual.sinIva !== p.nuevo.sinIva)
            .map(p => `${p.plan} ${p.periodo}: ${texto(p.actual)} → ${texto(p.nuevo)}`)
          return text({
            ok: false,
            requiresConfirmation: true,
            preview: {
              precios,
              cambios: cambiosEnPesos(vista.cambios),
              preciosNuevosEnStripe: vista.preciosNuevos,
              bloqueos: enPesos(vista.bloqueos),
              negociosQueConservanSuPrecio: vista.conservanSuPrecio,
              ...(avisoDeRevision ? { aviso: avisoDeRevision, revisionVigente: estado.revision } : {}),
            },
            mensaje: `Precio actual → nuevo (pesos MXN): ${lineas.length ? lineas.join('; ') : 'sin cambios de precio'}. Quien ya paga conserva el suyo.${avisoDeRevision ? ` ${avisoDeRevision}` : ''} Vuelve a llamar con confirm: true.`,
          })
        }
        const publicada = await publicarVersion(oferta, expectedRevision, scope.staffId)
        await auditMcpWrite(scope, {
          venueId: null,
          action: 'MCP_PLAN_OFFER_PUBLISHED',
          entity: 'PlanOfferVersion',
          entityId: publicada.versionId,
          data: { number: publicada.number, expectedRevision },
        })
        return text({ ok: true, publicada })
      } catch (error) {
        return refusal(error)
      }
    },
  )

  server.tool(
    'resolve_pending_plan_offer',
    'Resuelve una publicación de la oferta de planes que quedó pendiente (get_plan_offer dice cuál y por qué): reintentar la retoma donde se quedó, descartar la deja sin efecto (no toca la oferta vigente ni Stripe). Sin confirm sólo describe lo que haría; con confirm:true lo hace. Reintentar pide el interruptor prendido; descartar siempre se puede. Si la respuesta trae parcial: true, el descarte SÍ se hizo (nunca significa «medio descartado»); sólo no se pudo leer el estado después: llama a get_plan_offer para verlo. Sólo para Avoqado.',
    {
      versionId: z.string().min(1).describe('La versión pendiente, como la dice get_plan_offer'),
      accion: z.enum(['reintentar', 'descartar']),
      confirm,
    },
    async ({ versionId, accion, confirm: approved }) => {
      if (!scope.isSuperAdmin) return forbidden()
      write()
      if (!approved)
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: { versionId, accion },
          mensaje:
            accion === 'reintentar'
              ? 'Se retomará la publicación pendiente donde se quedó. Vuelve a llamar con confirm: true.'
              : 'Se descartará la publicación pendiente: la oferta vigente y Stripe no se tocan. Vuelve a llamar con confirm: true.',
        })
      try {
        if (accion === 'reintentar') {
          const publicada = await reintentarPublicacion(versionId, scope.staffId)
          await auditMcpWrite(scope, {
            venueId: null,
            action: 'MCP_PLAN_OFFER_RETRIED',
            entity: 'PlanOfferVersion',
            entityId: versionId,
            data: { number: publicada.number },
          })
          return text({ ok: true, publicada })
        }
        // Puede ser el estado parcial `{ revision, pendiente: null, parcial: true }` (`revision: -1` = no se pudo leer): se pasa tal cual.
        const estado = await descartarPublicacion(versionId, scope.staffId)
        await auditMcpWrite(scope, { venueId: null, action: 'MCP_PLAN_OFFER_DISCARDED', entity: 'PlanOfferVersion', entityId: versionId })
        return text({
          ok: true,
          estado,
          ...('parcial' in estado && estado.parcial
            ? { aviso: 'El descarte SÍ se hizo; sólo no se pudo leer el estado después. Llama a get_plan_offer para verlo.' }
            : {}),
        })
      } catch (error) {
        return refusal(error)
      }
    },
  )
}
