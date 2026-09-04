import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import prisma from '@/utils/prismaClient'
import { obtenerAutomatizacion, cambiarEstadoAutomatizacion } from '@/services/marketing/birthdayAutomation.service'

/**
 * Campañas de correo de un negocio a SUS clientes (promociones y felicitación de
 * cumpleaños). NO confundir con el Marketing de superadmin, que es Avoqado → los venues.
 *
 * 🔴 Permiso `marketing:manage` para leer, NO `marketing:read`: ése lo tienen roles de PISO
 * (cajero, mesero) para ver el aviso de privacidad, y con él verían todos los borradores y
 * el conteo de audiencia de cada campaña. Es el mismo gate que las rutas del dashboard.
 *
 * 🔴 Lo que este archivo NO expone, a propósito: **mandar una campaña**. Es irreversible y
 * le llega a miles de clientes; un LLM interpretando una petición vaga no debe poder
 * dispararlo ni con confirmación. Se manda desde el dashboard, donde el humano ve el número
 * de destinatarios antes de apretar. Sí se expone encender/pausar la felicitación, que es
 * reversible y es justo lo que alguien quiere hacer con prisa cuando algo sale mal.
 */
export function registerCampaignTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'list_customer_campaigns',
    'Email CAMPAIGNS a venue sent (or is preparing) to ITS OWN customers — promotions, news, announcements: each with its name, subject, status (DRAFT/SENT/…), who it went to, and how many were delivered vs failed. Answers "¿qué campañas de correo he mandado? ¿cuántos correos llegaron? ¿tengo borradores sin mandar?". This is the venue→its customers lane, NOT Avoqado→venues. Pass venueId. Requires marketing:manage.',
    {
      venueId: z.string().describe('Venue whose campaigns to list (must be in your scope)'),
      limit: z.number().int().positive().max(50).optional().describe('Max campaigns (default 20, newest first)'),
    },
    async ({ venueId, limit }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('marketing:manage', venueId)

      const take = limit ?? 20
      const [items, total] = await Promise.all([
        prisma.customerCampaign.findMany({
          where: { venueId },
          // 🔴 `select` acotado: sin él viajarían `htmlBody`/`textBody` — el correo entero de
          // cada campaña — por una lista que sólo necesita nombres y contadores.
          select: {
            id: true,
            name: true,
            subject: true,
            status: true,
            audience: true,
            totalRecipients: true,
            sentCount: true,
            failedCount: true,
            skippedCount: true,
            createdAt: true,
          },
          // Desempate único: con `skip`/`take` sobre `createdAt` solo, dos campañas creadas
          // en el mismo instante pueden salir dos veces o desaparecer.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
        }),
        prisma.customerCampaign.count({ where: { venueId } }),
      ])

      return text({
        venueId,
        count: items.length,
        total,
        campaigns: items.map(c => ({
          id: c.id,
          nombre: c.name,
          asunto: c.subject,
          estado: c.status,
          audiencia: c.audience,
          destinatarios: c.totalRecipients,
          entregados: c.sentCount,
          fallidos: c.failedCount,
          omitidos: c.skippedCount,
          creada: c.createdAt,
        })),
      })
    },
  )

  server.tool(
    'birthday_automation_status',
    'The venue\'s automatic BIRTHDAY greeting: whether it is on or paused (or never set up at all — three different things), how many days ahead it goes out, its subject, and the last civil date the sweep evaluated. Answers "¿tengo prendida la felicitación de cumpleaños? ¿con cuántos días de anticipación sale? ¿está corriendo?". Pass venueId. Requires marketing:manage.',
    { venueId: z.string().describe('Venue to check (must be in your scope)') },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('marketing:manage', venueId)

      const a = await obtenerAutomatizacion(venueId)
      if (!a) {
        // 🔴 «Nunca configurada» NO es lo mismo que «pausada», y decirlo importa: la
        // respuesta guía acciones distintas.
        return text({
          venueId,
          configurada: false,
          estado: 'SIN_CONFIGURAR',
          mensaje: 'Este negocio nunca ha configurado la felicitación de cumpleaños. Se configura en Clientes → Campañas.',
        })
      }

      return text({
        venueId,
        configurada: true,
        estado: a.status, // ACTIVE | PAUSED
        encendida: a.status === 'ACTIVE',
        asunto: a.subject,
        diasDeAntelacion: a.daysBefore,
        // Fecha CIVIL del venue, no un instante: un cumpleaños ocurre un día.
        ultimaFechaEvaluada: a.lastEvaluatedLocalDate,
      })
    },
  )

  server.tool(
    'set_birthday_automation',
    'Turn the venue\'s automatic BIRTHDAY greeting ON or OFF. Does NOT touch its content — only whether it runs. Turning it ON requires marketing:send (it authorizes recurring emails to the venue\'s customers); pausing only needs marketing:manage, because stopping something must never be harder than starting it. Two-step: call without confirm to see what would change, then confirm:true. Answers "prende/pausa la felicitación de cumpleaños".',
    {
      venueId: z.string().describe('Venue to change (must be in your scope)'),
      activa: z.boolean().describe('true = turn it on, false = pause it'),
      confirm: z.boolean().optional().describe('Set to true to actually apply the change'),
    },
    async ({ venueId, activa, confirm }) => {
      guard.venueFilter(venueId)
      // 🔴 El permiso depende de la dirección del cambio, igual que en la ruta HTTP:
      // encender autoriza envíos recurrentes; pausar es parar, y parar nunca puede ser más
      // difícil que arrancar.
      guard.requirePermission(activa ? 'marketing:send' : 'marketing:manage', venueId)

      const actual = await obtenerAutomatizacion(venueId)
      if (!actual) {
        return text({
          ok: false,
          error: 'Este negocio nunca ha configurado la felicitación de cumpleaños; primero hay que escribirla en Clientes → Campañas.',
        })
      }

      const estabaEncendida = actual.status === 'ACTIVE'
      if (estabaEncendida === activa) {
        return text({ ok: true, sinCambios: true, estado: actual.status, mensaje: 'Ya estaba así; no se cambió nada.' })
      }

      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: {
            negocio: venueId,
            de: actual.status,
            a: activa ? 'ACTIVE' : 'PAUSED',
            efecto: activa
              ? `Se empezará a mandar la felicitación sola, ${actual.daysBefore} días antes del cumpleaños de cada cliente que dio su permiso.`
              : 'Dejará de mandarse la felicitación. Lo ya encolado que aún no ha salido se omite.',
          },
          mensaje: 'Vuelve a llamar con confirm:true para aplicarlo.',
        })
      }

      const resultado = await cambiarEstadoAutomatizacion(venueId, activa, scope.staffId)
      if (!resultado) return text({ ok: false, error: 'No se encontró la felicitación de ese negocio.' })

      await auditMcpWrite(scope, {
        action: activa ? 'BIRTHDAY_AUTOMATION_ENABLED' : 'BIRTHDAY_AUTOMATION_DISABLED',
        entity: 'BirthdayAutomation',
        entityId: resultado.id,
        venueId,
        data: { de: actual.status, a: resultado.status },
      })

      return text({ ok: true, estado: resultado.status, encendida: resultado.status === 'ACTIVE' })
    },
  )
}
