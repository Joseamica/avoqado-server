/**
 * Filtro de Prisma para buscar a una persona (cliente o miembro del equipo) por lo que escribe un dueño.
 * Cada palabra tiene que aparecer en el nombre o en el apellido: «Juan Pérez» encuentra a Juan Carlos Pérez López
 * aunque ningún campo contenga la frase completa. Con `contact`, el término completo también se busca en correo
 * y teléfono. Un término en blanco no encuentra a nadie: las herramientas que actúan sobre el único resultado nunca
 * deben caer sobre una persona que no se nombró.
 */
export function personSearchWhere(term: string, opts: { contact?: boolean } = {}) {
  const trimmed = term.trim()
  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length === 0) return { id: { in: [] as string[] } }
  const byName = {
    AND: words.map(word => ({
      OR: [{ firstName: { contains: word, mode: 'insensitive' as const } }, { lastName: { contains: word, mode: 'insensitive' as const } }],
    })),
  }
  if (!opts.contact) return byName
  return { OR: [byName, { email: { contains: trimmed, mode: 'insensitive' as const } }, { phone: { contains: trimmed } }] }
}
