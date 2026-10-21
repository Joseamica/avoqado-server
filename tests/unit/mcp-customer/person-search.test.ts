import { personSearchWhere } from '@/mcp/personSearch'

// Evaluador mínimo de la semántica de Prisma que usa el filtro (AND / OR / contains, insensible a mayúsculas).
type Where = Record<string, unknown>
function matches(where: Where, row: Record<string, string | null>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND') return (value as Where[]).every(w => matches(w, row))
    if (key === 'OR') return (value as Where[]).some(w => matches(w, row))
    if (key === 'id') return ((value as { in: string[] }).in ?? []).includes(row.id ?? '')
    const { contains, mode } = value as { contains: string; mode?: string }
    const field = row[key] ?? ''
    return mode === 'insensitive' ? field.toLowerCase().includes(contains.toLowerCase()) : field.includes(contains)
  })
}

const juan = { firstName: 'Juan Carlos', lastName: 'Pérez López', email: 'juan@correo.mx', phone: '5512345678' }
const ana = { firstName: 'Ana', lastName: 'Pérez', email: 'ana@correo.mx', phone: '5587654321' }

describe('búsqueda de personas por nombre', () => {
  it('encuentra por nombre y apellido juntos, que es como pregunta un dueño', () => {
    expect(matches(personSearchWhere('Juan Pérez'), juan)).toBe(true)
    expect(matches(personSearchWhere('juan carlos pérez'), juan)).toBe(true)
    expect(matches(personSearchWhere('  Juan   Pérez  '), juan)).toBe(true)
  })

  it('cada palabra debe aparecer: «Juan Pérez» no trae a Ana Pérez', () => {
    expect(matches(personSearchWhere('Juan Pérez'), ana)).toBe(false)
  })

  it('sigue encontrando por una sola palabra, en nombre o apellido', () => {
    expect(matches(personSearchWhere('Pérez'), juan)).toBe(true)
    expect(matches(personSearchWhere('Pérez'), ana)).toBe(true)
    expect(matches(personSearchWhere('Ana'), juan)).toBe(false)
  })

  it('con contacto, también encuentra por correo o teléfono completos', () => {
    expect(matches(personSearchWhere('juan@correo.mx', { contact: true }), juan)).toBe(true)
    expect(matches(personSearchWhere('5512345678', { contact: true }), juan)).toBe(true)
    expect(matches(personSearchWhere('Juan Pérez', { contact: true }), juan)).toBe(true)
    expect(matches(personSearchWhere('juan@correo.mx'), juan)).toBe(false)
  })

  it('un término en blanco no encuentra a nadie: una acción nunca cae sobre alguien que no se nombró', () => {
    for (const where of [personSearchWhere('   '), personSearchWhere('', { contact: true })]) {
      expect(matches(where as Where, juan)).toBe(false)
      expect(where).toEqual({ id: { in: [] } })
    }
  })
})
