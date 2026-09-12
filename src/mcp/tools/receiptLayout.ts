import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { requireWriteScopeAlways } from '../requireWriteScopeAlways'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { getReceiptLayout, putReceiptLayout } from '@/services/dashboard/receiptLayout/receiptLayout.service'
import { cargarVenueInfo, getReceiptDevices, getReceiptReadiness } from '@/services/dashboard/receiptLayout/readiness.service'
import { interpret, renderPlain, SAMPLE_SALES, validateLayoutStrict } from '@/services/shared/receiptLayout'

/**
 * El DISEÑO del ticket en papel que el negocio entrega al cobrar.
 *
 * 🔴 `receipt-layout:manage` para escribir, y `:read` para leer: NINGUNO lo tiene un rol de
 * piso, y MANAGER tampoco (sí tiene `printers:manage`, que es otra cosa). Es el mismo gate
 * que las rutas del dashboard.
 *
 * 🔴 Escribir va en DOS PASOS y con `requireWriteScopeAlways`: el ticket es lo que se le
 * entrega a cada cliente del negocio, y una conexión de sólo lectura no lo cambia aunque la
 * bandera de despliegue esté apagada. La primera llamada sólo ENSEÑA el papel resultante.
 */
export function registerReceiptLayoutTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'receipt_layout',
    'How a venue\'s PAPER receipt looks today — the printed ticket handed to the customer at checkout: which blocks it prints, in what order, and the ticket already laid out as text. Also says whether the venue is missing the data the ticket needs (tax issuer, logo) and how many of its devices already apply the design. Answers "¿cómo sale mi ticket?", "¿por qué no sale mi RFC en el ticket?". Pass venueId. Requires receipt-layout:read.',
    {
      venueId: z.string().describe('Venue whose receipt design to show (must be in your scope)'),
      paperWidth: z
        .union([z.literal(80), z.literal(58)])
        .optional()
        .describe('Paper width in mm: 80 (default) or 58'),
    },
    async ({ venueId, paperWidth }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('receipt-layout:read', venueId)

      const width = paperWidth === 58 ? 32 : 48
      const [layout, readiness, devices, venue] = await Promise.all([
        getReceiptLayout(venueId),
        getReceiptReadiness(venueId),
        getReceiptDevices(venueId),
        cargarVenueInfo(venueId),
      ])
      const lines = interpret(layout.blocks, { sale: SAMPLE_SALES.retail, venue }, width)

      return text({
        venueId,
        revision: layout.revision,
        source: layout.source,
        bloques: layout.blocks.map(b => b.type),
        // El ticket en TEXTO: una lista de bloques no le dice nada a nadie.
        ticket: renderPlain(lines, width),
        datosQueFaltan: {
          emisorFiscal: readiness.fiscalEmisor ? 'configurado' : 'FALTA: el ticket saldrá sin RFC ni razón social',
          logo: readiness.logo ? 'configurado' : 'falta: el ticket saldrá sin logo',
        },
        aparatos: {
          yaLoAplican: devices.supporting,
          todaviaNo: devices.notSupporting.map(
            d => `${d.name} (${[d.platform, d.brand].filter(Boolean).join(' ')}, versión ${d.appVersion ?? 'desconocida'})`,
          ),
        },
      })
    },
  )

  server.tool(
    'configure_receipt_layout',
    "Change the DESIGN of a venue's paper receipt: which blocks print and in what order. TWO STEPS — the first call only shows how the ticket would look and asks for confirmation; nothing is saved until you call again with confirm:true. Seven blocks are mandatory and cannot be removed (tax data, order, items, totals, payment, area delivery, the Avoqado signature). Requires receipt-layout:manage.",
    {
      venueId: z.string().describe('Venue whose receipt design to change (must be in your scope)'),
      blocks: z.array(z.unknown()).describe('The ordered list of receipt blocks'),
      expectedRevision: z
        .number()
        .int()
        .min(0)
        .describe('Revision you are editing from — 0 means "I know there is no saved design yet". Get it from receipt_layout.'),
      confirm: z.boolean().optional().describe('Set true on the SECOND call to actually save'),
    },
    async ({ venueId, blocks, expectedRevision, confirm }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('receipt-layout:manage', venueId)

      // 🔴 Corta SIEMPRE, no depende de MCP_ENFORCE_WRITE_SCOPE: el ticket es lo que el
      // negocio le entrega a cada cliente, y una conexión de sólo lectura no lo cambia.
      requireWriteScopeAlways(scope, 'receipt-layout:manage', 'cambia el ticket que se le entrega a cada cliente')

      // Se valida ANTES de decidir si hay que confirmar: un diseño roto no llega ni a preguntar.
      // 🔴 ESTRICTO, igual que el dashboard: un bloque que no se puede leer se RECHAZA con su
      // posición. El parser tolerante lo descartaba y se guardaba el resto con ok:true — la IA le
      // confirmaba al negocio un texto que nunca quedó en el ticket (FAIL-3, 12-sep).
      const validado = validateLayoutStrict(blocks)
      if (!validado.ok) {
        const { message, code, index, blockType } = validado.problem
        return text({ ok: false, error: message, code, index, blockType })
      }
      const legibles = validado.blocks

      const venue = await cargarVenueInfo(venueId)
      const lines = interpret(legibles, { sale: SAMPLE_SALES.retail, venue }, 48)
      const preview = renderPlain(lines, 48)

      if (!confirm) {
        const actual = await getReceiptLayout(venueId)
        return text({
          ok: false,
          requiresConfirmation: true,
          mensaje: 'Así quedaría el ticket. Vuelve a llamar con confirm:true para guardarlo.',
          antes: actual.blocks.map(b => b.type),
          despues: legibles.map(b => b.type),
          revisionActual: actual.revision,
          preview,
        })
      }

      const guardado = await putReceiptLayout({ venueId, blocks: legibles, expectedRevision, updatedById: scope.staffId })
      await auditMcpWrite(scope, {
        action: 'RECEIPT_LAYOUT_UPDATED',
        entity: 'ReceiptLayout',
        entityId: venueId,
        venueId,
        data: { revision: guardado.revision, bloques: guardado.blocks.length },
      })

      return text({ ok: true, revision: guardado.revision, ticket: preview })
    },
  )
}
