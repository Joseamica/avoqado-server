import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { text } from '../respond'
import { findArticle, getHelpArticles, getInternalDocs, OVERVIEW_SLUG, type KnowledgeArticle } from '../knowledge'
const DEFAULT_DOC_MAX_CHARS = 60_000

const summarize = (a: KnowledgeArticle) => ({
  slug: a.slug,
  title: a.title,
  description: a.description,
  category: a.category,
  ...(a.featureCode ? { featureCode: a.featureCode } : {}),
  ...(a.url ? { url: a.url } : {}),
})

/**
 * "Explain Avoqado" tools.
 *
 *   avoqado_help          — everyone. Product knowledge: what Avoqado does, what each plan includes,
 *                           how to use a module (facturación, inventario, reservaciones…). Backed by
 *                           the public help-center articles + founder-written overviews. No DB reads,
 *                           no venue data — it is safe for any connection.
 *   avoqado_internal_docs — SUPERADMIN ONLY (not registered otherwise, so it is not even listed in
 *                           the catalog). Serves an allowlist of docs/*.md (architecture, payments,
 *                           permissions…) so the founder can ask "¿cómo está construido X?" through
 *                           the same connection, while a customer's assistant has nothing to leak.
 */
export function registerHelpTools(server: McpServer, scope: McpScope): void {
  server.tool(
    'avoqado_help',
    'Guía de producto de Avoqado — qué hace la plataforma, qué incluye cada plan (Free / Pro / Premium / Enterprise) y CÓMO USAR cada módulo (facturación CFDI, contabilidad y conciliación bancaria, inventario, personal y comisiones, clientes y lealtad, reservaciones, ligas de pago, terminales, permisos…). Úsala para preguntas generales como "¿Avoqado tiene facturación?", "¿cómo creo una liga de pago?", "¿qué trae el plan Pro?". Sin `topic` devuelve el resumen general + el índice de artículos; con `topic` (tema libre o slug del índice) devuelve el artículo que mejor coincide. No devuelve datos del negocio — para números reales usa las demás tools.',
    {
      topic: z
        .string()
        .trim()
        .max(200)
        .optional()
        .describe(
          'Tema o pregunta en lenguaje natural ("factura global", "cómo doy de alta a un empleado") o un slug del índice. Omitir para el resumen general.',
        ),
    },
    async ({ topic }) => {
      const articles = getHelpArticles()
      const overview = articles.find(a => a.slug === OVERVIEW_SLUG)
      if (!topic) {
        return text({
          ok: true,
          overview: overview?.body ?? null,
          articles: articles.filter(a => a.slug !== OVERVIEW_SLUG).map(summarize),
          hint: 'Llama de nuevo con `topic` (un slug del índice o una pregunta) para leer un artículo completo.',
        })
      }
      const { article, suggestions } = findArticle(articles, topic)
      if (!article) {
        return text({
          ok: false,
          error: `No encontré un artículo sobre "${topic}".`,
          suggestions,
          hint: 'Prueba con otro tema, o llama sin `topic` para ver el índice completo. Si el tema no existe en la guía, dile al usuario que escriba a hola@avoqado.io.',
        })
      }
      const related = article.related
        .map(slug => articles.find(a => a.slug === slug))
        .filter((a): a is KnowledgeArticle => Boolean(a))
        .map(summarize)
      return text({ ok: true, ...summarize(article), body: article.body, related, suggestions })
    },
  )

  if (!scope.isSuperAdmin) return

  server.tool(
    'avoqado_internal_docs',
    'SOLO SUPERADMIN — documentación técnica interna de Avoqado (arquitectura del backend, flujo de pagos y liquidaciones, modelos de merchant, sistema de permisos, esquema de base de datos, inventario, terminales…). Sin `doc` devuelve el índice (nombre, título, tamaño); con `doc` devuelve el contenido del documento (recortado a `maxChars`, default 60 000). Úsala cuando el superadmin pregunte cómo está construido o cómo funciona por dentro algo de Avoqado. Esta tool no existe para conexiones que no sean superadmin.',
    {
      doc: z
        .string()
        .trim()
        .max(100)
        .optional()
        .describe('Nombre del documento tal como aparece en el índice (ej. "ARCHITECTURE_OVERVIEW"). Omitir para el índice.'),
      maxChars: z.number().int().min(1_000).max(200_000).optional().describe('Máximo de caracteres a devolver (default 60 000).'),
    },
    async ({ doc, maxChars }) => {
      const docs = getInternalDocs()
      if (!doc) {
        return text({ ok: true, docs: docs.map(d => ({ name: d.name, title: d.title, sizeChars: d.sizeChars })) })
      }
      const wanted = doc.replace(/\.md$/i, '').toUpperCase()
      const found = docs.find(d => d.name.toUpperCase() === wanted)
      if (!found) {
        return text({ ok: false, error: `"${doc}" no está en la lista de documentos disponibles.`, available: docs.map(d => d.name) })
      }
      const limit = maxChars ?? DEFAULT_DOC_MAX_CHARS
      const truncated = found.body.length > limit
      return text({
        ok: true,
        name: found.name,
        title: found.title,
        sizeChars: found.sizeChars,
        truncated,
        body: truncated ? found.body.slice(0, limit) : found.body,
      })
    },
  )
}
