import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { fromZonedTime } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { text } from '../respond'

/** Techo de filas que se leen para agregar. Un alta de landing es un evento raro
 *  (decenas por mes, no miles), asi que esto sobra — pero evita que un pico
 *  convierta la agregacion en JS en una lectura sin fondo. */
const TOPE_LECTURA = 2000

type DatosAlta = { source?: unknown; utm?: Record<string, unknown> | null }

/** `utm_campaign` es lo que se compara; el resto acompaña. Un lead sin UTMs
 *  (organico, o un anuncio al que se le olvido poner los parametros) cae en
 *  `(sin campana)` en vez de desaparecer: ese hueco es justo el dato que
 *  delata un anuncio mal configurado. */
function claveDeCampana(utm: Record<string, unknown> | null | undefined) {
  const g = (k: string) => (typeof utm?.[k] === 'string' ? (utm[k] as string) : '')
  return {
    utm_source: g('utm_source') || '(sin campana)',
    utm_medium: g('utm_medium') || '',
    utm_campaign: g('utm_campaign') || '',
    utm_content: g('utm_content') || '',
  }
}

export function registerLandingLeadTools(server: McpServer, scope: McpScope) {
  server.tool(
    'landing_leads',
    'Altas que entraron por un formulario de la landing (avoqado.io), con la campana que las trajo. ' +
      'Responde "de que campana vino cada lead" y "cual campana trae mas": agrupa por utm_source / utm_medium / ' +
      'utm_campaign / utm_content y ademas lista los leads. Los UTMs los propaga el anuncio en la URL de ' +
      'aterrizaje, asi que un anuncio SIN parametros de URL cae en "(sin campana)". SOLO para SUPERADMIN de ' +
      'plataforma: son leads de Avoqado, no de un venue, e incluyen datos de contacto del prospecto.',
    {
      startDate: z.string().optional().describe('Fecha ISO minima (inclusive), hora de Mexico'),
      endDate: z.string().optional().describe('Fecha ISO maxima (inclusive), hora de Mexico'),
      source: z.string().optional().describe('Filtra por landing de origen, p. ej. landing_restaurantes / landing_retail'),
      limit: z.number().int().min(1).max(200).default(50).describe('Maximo de leads a listar (el resumen usa todos)'),
    },
    async ({ startDate, endDate, source, limit }) => {
      // Dato de plataforma, no de un venue: el alta nace SIN venue, asi que
      // get_activity_log (que filtra por venueId) nunca puede verla. Por eso
      // vive aparte y se cierra al superadmin en vez de al scope de venues.
      if (!scope.isSuperAdmin) {
        return text({ error: 'Solo el SUPERADMIN de plataforma puede consultar los leads de la landing.' })
      }

      const where: Record<string, unknown> = { action: 'LANDING_SIGNUP_CREATED' }
      if (startDate || endDate) {
        // Fecha suelta YYYY-MM-DD interpretada en la zona de la plataforma como
        // STRING, nunca con new Date(): produccion corre en UTC y ahi el dia se
        // recorre. Ver critical-warnings.md.
        const tz = 'America/Mexico_City'
        const createdAt: Record<string, Date> = {}
        if (startDate) createdAt.gte = fromZonedTime(`${startDate}T00:00:00.000`, tz)
        if (endDate) createdAt.lte = fromZonedTime(`${endDate}T23:59:59.999`, tz)
        where.createdAt = createdAt
      }

      const filas = await prisma.activityLog.findMany({
        where: where as any,
        select: {
          id: true,
          data: true,
          createdAt: true,
          staff: { select: { firstName: true, lastName: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: TOPE_LECTURA,
      })

      const conFuente = filas.filter(f => {
        if (!source) return true
        const d = f.data as DatosAlta | null
        return typeof d?.source === 'string' && d.source === source
      })

      const resumen = new Map<
        string,
        { utm_source: string; utm_medium: string; utm_campaign: string; utm_content: string; leads: number }
      >()
      for (const f of conFuente) {
        const d = f.data as DatosAlta | null
        const c = claveDeCampana(d?.utm as Record<string, unknown> | null)
        const k = `${c.utm_source}|${c.utm_medium}|${c.utm_campaign}|${c.utm_content}`
        const prev = resumen.get(k)
        if (prev) prev.leads += 1
        else resumen.set(k, { ...c, leads: 1 })
      }

      return text({
        total: conFuente.length,
        truncado: filas.length === TOPE_LECTURA,
        porCampana: [...resumen.values()].sort((a, b) => b.leads - a.leads),
        leads: conFuente.slice(0, limit).map(f => {
          const d = f.data as DatosAlta | null
          return {
            fecha: f.createdAt,
            nombre: [f.staff?.firstName, f.staff?.lastName].filter(Boolean).join(' ') || null,
            email: f.staff?.email ?? null,
            landing: typeof d?.source === 'string' ? d.source : null,
            utm: (d?.utm as Record<string, unknown> | null) ?? null,
          }
        }),
      })
    },
  )
}
