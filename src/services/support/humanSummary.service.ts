import type { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { loadVerifiedSections, loadSupportLibrary, resolveSourceRefs, sourceRef, type LibraryGuide } from './knowledge.service'
import { SUPPORT_APP_LABELS, SUPPORT_CONTACT, SUPPORT_GUIDE_CHANGED } from './texts'

/**
 * T-F10a (Codex P2): el título de una guía citada en los `sourceIds` de un mensaje. La cita guarda la versión que se mostró
 * (`id@hash8`) y aquí sólo está la biblioteca de hoy: si esa versión ya no es la publicada, el título de hoy no es el de entonces,
 * y se dice. Lo usan este resumen y el aviso al equipo (snapshotHandoffMeta).
 */
export const citedTitle = (g: LibraryGuide, sourceIds: string[]) =>
  sourceIds.includes(sourceRef(g)) ? g.title : `${g.title} ${SUPPORT_GUIDE_CHANGED}`

export async function buildHumanSummary(
  conversationId: string,
  generation: number,
  db: Prisma.TransactionClient = prisma,
  library?: LibraryGuide[],
): Promise<string> {
  const conversation = await db.supportConversation.findFirst({
    where: { id: conversationId, generation, mode: { not: 'CLOSED' } },
    select: { app: true, appVersion: true, deviceFamily: true },
  })
  if (!conversation) return SUPPORT_CONTACT
  const messages = await db.supportMessage.findMany({
    where: { conversationId, generation, expiresAt: { gt: new Date() }, sourceIds: { isEmpty: false } },
    orderBy: { sequence: 'desc' },
    take: 6,
    select: { sourceIds: true },
  })
  // Hybrid refs (`id@hash8`) take their titles from the library, with or without the flag; the library loads once, if needed.
  let loaded: LibraryGuide[] | undefined
  const load = () => (loaded ??= library ?? loadSupportLibrary())
  const hybrid = messages.map(m => resolveSourceRefs(m.sourceIds, load))
  const ids = new Set(messages.filter((_, i) => !hybrid[i]).flatMap(m => m.sourceIds))
  const titled = (i: number) => (g: LibraryGuide) => ({ ...g, title: citedTitle(g, messages[i].sourceIds) })
  const sources = [
    ...loadVerifiedSections().filter(s => ids.has(s.id)),
    ...hybrid.flatMap((h, i) => (h && !h.clarify ? h.guides.map(titled(i)) : [])),
  ]
    .filter((s, i, all) => all.findIndex(o => o.id === s.id) === i)
    .slice(0, 3)
  const offered = hybrid.flatMap((h, i) => (h?.clarify && h.guides.length ? [h.guides.map(g => titled(i)(g).title).join(', ')] : []))
  const version =
    conversation.appVersion &&
    /^\d+\.\d+(?:\.\d+)?(?:-[a-z0-9.-]+)?$/i.test(conversation.appVersion) &&
    conversation.appVersion.length <= 40
      ? conversation.appVersion
      : 'sin indicar'
  let text = `Puedes revisar y copiar este resumen para pedir ayuda. No incluyo tu pregunta ni datos del negocio: añádelos tú sólo si quieres.\nApp: ${SUPPORT_APP_LABELS[conversation.app ?? ''] ?? 'sin elegir'}. Versión: ${version}.${['PAX', 'NEXGO'].includes(conversation.deviceFamily ?? '') ? ` Equipo: ${conversation.deviceFamily}.` : ''}\n`
  if (!sources.length && !offered.length) text += 'Tema: por describir. No hay una guía verificada intentada en esta conversación.\n'
  const lines = [
    // An internal manual page has no link (R1-08): only its title.
    ...sources.map(source => `Guía intentada: ${source.title}\n${source.publicUrl ? `${source.publicUrl}\n` : ''}`),
    ...offered.map(titles => `Se le ofrecieron: ${titles}\n`),
  ]
  for (const line of lines) if (text.length + line.length + 260 <= 1500) text += line
  return `${text}\nContacto: mailto:hola@avoqado.io\n${SUPPORT_CONTACT}`
}
