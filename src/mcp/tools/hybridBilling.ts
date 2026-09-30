import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { text } from '../respond'
import { createGuard } from '../guard'
import { requireWriteScopeAlways } from '../requireWriteScopeAlways'
import { auditMcpWrite } from '../audit'
import { cancellationAuditData } from '@/services/shared/cancellationReason'
import {
  hybridQuoteBody,
  createHybridQuote,
  acceptHybridQuote,
  getHybridPurchaseStatus,
  getCurrentHybridPurchase,
  getHybridReplacementOptions,
  hybridPurchaseView,
} from '@/services/launchCampaigns/hybridPurchase.service'
import { provisionHybridPurchase } from '@/services/launchCampaigns/hybridProvision.service'
import { getHybridFeatureGrid } from '@/services/launchCampaigns/hybridFeatureGrid.service'
import { cancelHybridPurchase, reconcileHybridPurchase } from '@/services/launchCampaigns/hybridLifecycle.service'
import {
  hybridContractListQuery,
  hybridSelectionBody,
  hybridCancellationBody,
  listHybridContracts,
  getHybridContract,
  scheduleHybridSelection,
  cancelHybridContract,
} from '@/services/launchCampaigns/hybridManagement.service'
import {
  listHybridRedemptions,
  hybridRedemptionsQuery,
  hybridCampaignBody,
  hybridCampaignListQuery,
  hybridStatusBody,
  createHybridCampaign,
  updateHybridCampaign,
  publishHybridCampaign,
  setHybridCampaignStatus,
  listHybridCampaigns,
  getHybridCampaign,
  listPublicHybridOffers,
} from '@/services/launchCampaigns/hybridCampaign.service'

const venueId = z.string().describe('Negocio dentro de tu acceso')
const purchaseId = z.string().describe('Identificador exacto de la cotización o compra')
const confirm = z.boolean().optional().describe('true sólo después de revisar y aceptar la vista previa')
export function registerHybridBillingTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  const write = (id: string) => {
    guard.venueFilter(id)
    guard.requirePermission('billing:subscriptions:manage', id)
    requireWriteScopeAlways(scope, 'billing:subscriptions:manage', 'modifica una contratación del negocio')
  }
  server.tool(
    'hybrid_current_purchase',
    'Encuentra el intento aceptado pendiente del negocio aunque se haya perdido el almacenamiento del navegador. No abre otro cobro.',
    { venueId },
    async ({ venueId: id }) => {
      guard.venueFilter(id)
      guard.requirePermission('billing:subscriptions:read', id)
      return text(await getCurrentHybridPurchase(id))
    },
  )
  server.tool(
    'venue_feature_grid',
    'Las 40 funciones de Avoqado para un negocio: de dónde viene cada una (gratis, su plan, un contrato o comprada aparte) y, si la venta está abierta, la oferta más barata que su organización puede comprar hoy, en pesos MXN con IVA incluido; también la oferta de plan Pro y Premium. Sólo lectura: la compra vuelve a validar todo al cotizar.',
    { venueId },
    async ({ venueId: id }) => {
      guard.venueFilter(id)
      guard.requirePermission('billing:subscriptions:read', id)
      return text(await getHybridFeatureGrid(id))
    },
  )
  server.tool(
    'hybrid_replacement_options',
    'Consulta las suscripciones reemplazables y las funciones ya incluidas antes de cotizar. No cancela ni modifica nada.',
    { venueId },
    async ({ venueId: id }) => {
      guard.venueFilter(id)
      guard.requirePermission('billing:subscriptions:read', id)
      return text(await getHybridReplacementOptions(id))
    },
  )
  server.tool(
    'hybrid_contracts',
    'Consulta planes, funciones y paquetes contratados: precio total por contrato, renovación, selección actual y cambios programados. Importes en pesos MXN; devuelve el total y páginas.',
    { venueId, ...hybridContractListQuery.shape },
    async ({ venueId: id, ...query }) => {
      guard.venueFilter(id)
      guard.requirePermission('billing:subscriptions:read', id)
      return text(await listHybridContracts(id, query))
    },
  )
  server.tool(
    'schedule_hybrid_selection',
    'Programa las funciones elegidas para la próxima renovación pagada de un paquete. No cambia los accesos del período actual. Envía featureCodes:null para retirar un cambio futuro. Requiere confirmación.',
    { venueId, contractId: z.string(), ...hybridSelectionBody.shape, confirm },
    async ({ venueId: id, contractId, confirm: approved, ...input }) => {
      write(id)
      if (!approved)
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: { current: await getHybridContract(id, contractId), requested: input },
          mensaje: 'Selección actual → selección indicada desde la próxima renovación pagada. El precio total se conserva.',
        })
      const result = await scheduleHybridSelection(id, contractId, scope.staffId, input)
      await auditMcpWrite(scope, { venueId: id, action: 'MCP_HYBRID_SELECTION', entity: 'HybridContract', entityId: contractId })
      return text(result)
    },
  )
  server.tool(
    'cancel_hybrid_contract',
    'Detiene la renovación de un plan, función o paquete completo al terminar su período pagado. Conserva los datos y los otros contratos. Acepta un motivo opcional (reason) y un comentario (comment) que quedan en la bitácora. Requiere confirmación y la revisión vigente.',
    { venueId, contractId: z.string(), ...hybridCancellationBody.shape, confirm },
    async ({ venueId: id, contractId, confirm: approved, ...input }) => {
      write(id)
      if (!approved)
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: { current: await getHybridContract(id, contractId), requested: input },
          mensaje: 'Contrato con renovación → termina al cerrar el período pagado. El acceso actual continúa hasta esa fecha.',
        })
      const result = await cancelHybridContract(id, contractId, scope.staffId, input)
      await auditMcpWrite(scope, {
        venueId: id,
        action: 'MCP_HYBRID_RENEWAL_CANCELLED',
        entity: 'HybridContract',
        entityId: contractId,
        data: cancellationAuditData(input),
      })
      return text(result)
    },
  )
  server.tool(
    'hybrid_offers',
    'Ofertas publicadas de planes, funciones y paquetes a elección. Importes en pesos MXN con IVA incluido. Devuelve el total y permite recorrer páginas; la elegibilidad final se comprueba al cotizar.',
    hybridCampaignListQuery.omit({ status: true }).shape,
    async input => text(await listPublicHybridOffers(input)),
  )
  server.tool(
    'quote_hybrid_purchase',
    'Cotiza planes y funciones seleccionadas con sus condiciones publicadas y el crédito real por suscripciones reemplazadas. Sólo crea una cotización de cinco minutos: no cobra ni concede acceso. Importes en pesos.',
    { venueId, ...hybridQuoteBody.shape },
    async ({ venueId: id, ...input }) => {
      write(id)
      const quote = await createHybridQuote(id, scope.staffId, input)
      await auditMcpWrite(scope, { venueId: id, action: 'MCP_HYBRID_QUOTED', entity: 'HybridPurchase', entityId: quote.id })
      return text(hybridPurchaseView(quote))
    },
  )
  server.tool(
    'hybrid_purchase_status',
    'Consulta el mismo intento de compra después de cerrar la página o perder la conexión. No abre otro cobro. Importes en pesos.',
    { venueId, purchaseId },
    async ({ venueId: id, purchaseId: purchase }) => {
      guard.venueFilter(id)
      guard.requirePermission('billing:subscriptions:read', id)
      return text(await getHybridPurchaseStatus(id, purchase))
    },
  )
  server.tool(
    'accept_hybrid_purchase',
    'Presenta la cotización para confirmación. Con confirm:true reserva el lugar y abre el enlace de pago del mismo intento; la persona confirma el pago en ese enlace. No paga automáticamente ni activa funciones antes del pago.',
    { venueId, purchaseId, quoteHash: z.string(), clientKey: z.string().describe('Misma llave estable al reintentar'), confirm },
    async ({ venueId: id, purchaseId: purchase, quoteHash, clientKey, confirm: approved }) => {
      write(id)
      if (!approved)
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: (await getHybridPurchaseStatus(id, purchase)).quote,
          mensaje: 'Revisa el importe, las funciones que dejas y la renovación. Confirma para reservar y abrir el pago.',
        })
      const accepted = await acceptHybridQuote(id, scope.staffId, purchase, { quoteHash, clientKey })
      await auditMcpWrite(scope, { venueId: id, action: 'MCP_HYBRID_ACCEPTED', entity: 'HybridPurchase', entityId: purchase })
      return text(
        accepted.status === 'COMPLETED' ? { purchaseId: purchase, status: 'ACTIVE' } : await provisionHybridPurchase(id, purchase),
      )
    },
  )
  server.tool(
    'resume_hybrid_purchase',
    'Revisa y retoma una compra ya aceptada. Conserva el intento y sus condiciones. No crea otra cotización ni acepta un precio distinto.',
    { venueId, purchaseId },
    async ({ venueId: id, purchaseId: purchase }) => {
      write(id)
      const result = await reconcileHybridPurchase(id, purchase)
      await auditMcpWrite(scope, { venueId: id, action: 'MCP_HYBRID_RESUMED', entity: 'HybridPurchase', entityId: purchase })
      return text(result.status === 'PAYMENT_PENDING' ? await provisionHybridPurchase(id, purchase) : { purchaseId: purchase, ...result })
    },
  )
  server.tool(
    'cancel_hybrid_purchase',
    'Cancela un intento pendiente sólo si se comprueba que no se pagó; libera su lugar y crédito reservado. Si el pago ya llegó, continúa la entrega. Requiere confirmación.',
    { venueId, purchaseId, confirm },
    async ({ venueId: id, purchaseId: purchase, confirm: approved }) => {
      write(id)
      if (!approved)
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: await getHybridPurchaseStatus(id, purchase),
          mensaje: 'Intento pendiente → cancelado. Sólo se libera el lugar después de comprobar que no hay un pago confirmado.',
        })
      const result = await cancelHybridPurchase(id, purchase, scope.staffId)
      await auditMcpWrite(scope, { venueId: id, action: 'MCP_HYBRID_CANCELLED', entity: 'HybridPurchase', entityId: purchase })
      return text(result)
    },
  )
}

/** Platform campaign writes carry their atomic platform ActivityLog (there is no venue on these records). */
export function registerHybridCampaignTools(server: McpServer, scope: McpScope) {
  const forbidden = () => text({ ok: false, error: 'Solo Avoqado puede ver o modificar estas campañas.' })
  const write = () => requireWriteScopeAlways(scope, 'launch-campaigns:write', 'modifica una oferta comercial')
  server.tool(
    'hybrid_campaign_redemptions',
    'Lugares reservados y contrataciones de una campaña, paginados. Muestra compra pendiente, vencimiento e incidencias para seguimiento. Total de hoy en pesos MXN. Sólo Avoqado.',
    { campaignId: z.string(), ...hybridRedemptionsQuery.shape },
    async ({ campaignId, ...query }) => (scope.isSuperAdmin ? text(await listHybridRedemptions(campaignId, query)) : forbidden()),
  )
  server.tool(
    'list_hybrid_campaigns',
    'Campañas configurables de planes y funciones: borradores, publicadas, vigencia, cupo y total paginado. Sólo para Avoqado. Precios en pesos MXN.',
    hybridCampaignListQuery.shape,
    async input => (scope.isSuperAdmin ? text(await listHybridCampaigns(input)) : forbidden()),
  )
  server.tool(
    'get_hybrid_campaign',
    'Consulta una campaña y su última versión publicada, incluyendo precio y condiciones de renovación en pesos. Sólo para Avoqado.',
    { campaignId: z.string() },
    async ({ campaignId }) => (scope.isSuperAdmin ? text(await getHybridCampaign(campaignId)) : forbidden()),
  )
  server.tool(
    'save_hybrid_campaign',
    'Crea o edita el borrador de una campaña configurable. Permite elegir cantidad, funciones, precio, vigencia y renovación sin crear otro onboarding. Crear nunca activa ventas. Sólo Avoqado; requiere confirmación.',
    { campaign: hybridCampaignBody, campaignId: z.string().optional(), expectedRevision: z.number().int().positive().optional(), confirm },
    async ({ campaign, campaignId, expectedRevision, confirm: approved }) => {
      if (!scope.isSuperAdmin) return forbidden()
      write()
      if (!approved)
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: campaign,
          mensaje: campaignId
            ? 'El borrador actual → los datos mostrados. Las compras anteriores conservan sus condiciones.'
            : 'Nueva campaña → borrador, sin ventas activas.',
        })
      return text(
        campaignId
          ? await updateHybridCampaign(campaignId, { ...campaign, expectedRevision }, scope.staffId)
          : await createHybridCampaign(campaign, scope.staffId),
      )
    },
  )
  server.tool(
    'publish_hybrid_campaign',
    'Congela la composición y condiciones del borrador en una versión publicada. Queda pausada hasta activar ventas explícitamente. Sólo Avoqado; requiere confirmación.',
    { campaignId: z.string(), expectedRevision: z.number().int().positive(), confirm },
    async ({ campaignId, expectedRevision, confirm: approved }) => {
      if (!scope.isSuperAdmin) return forbidden()
      write()
      if (!approved)
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: await getHybridCampaign(campaignId),
          mensaje: 'Borrador → versión publicada y pausada. No se cobra a nadie.',
        })
      return text(await publishHybridCampaign(campaignId, expectedRevision, scope.staffId))
    },
  )
  server.tool(
    'set_hybrid_campaign_status',
    'Activa, pausa o termina nuevas ventas de una campaña publicada. Las compras aceptadas conservan su lugar y condiciones. Sólo Avoqado; requiere confirmación y versión vigente.',
    { campaignId: z.string(), ...hybridStatusBody.shape, confirm },
    async ({ campaignId, confirm: approved, ...input }) => {
      if (!scope.isSuperAdmin) return forbidden()
      write()
      if (!approved) {
        const current = await getHybridCampaign(campaignId)
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: {
            nombre: current.name,
            estadoActual: current.status,
            nuevoEstado: input.status,
            oferta: current.publications[0] ?? null,
          },
        })
      }
      return text(await setHybridCampaignStatus(campaignId, input, scope.staffId))
    },
  )
}
