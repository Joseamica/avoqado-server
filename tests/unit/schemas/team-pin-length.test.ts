import { UpdateTeamMemberSchema, InviteTeamMemberSchema } from '@/schemas/dashboard/team.schema'
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from '@/schemas/common/pin.schema'

/**
 * 🔴 El PIN se guarda en TEXTO PLANO por decisión explícita del founder, así que
 * su única defensa real es poder ser LARGO. La unificación a 4-10 dígitos
 * (commit bbfb0065) tocó los tres schemas de superadmin y las invitaciones, pero
 * se saltó `UpdateTeamMemberSchema` — la pantalla de Equipo, que es justamente la
 * que un admin de venue usa para alargar el PIN de su gerente antes de activar la
 * autorización por código. Ahí seguía diciendo "PIN must be 4-6 digits".
 *
 * Todos los sitios leen ahora `@/schemas/common/pin.schema`, así que el próximo
 * cambio de rango es una sola edición.
 */
describe('longitud del PIN — la misma en TODOS los caminos', () => {
  const base = { firstName: 'Laura', lastName: 'Méndez', email: 'laura@avoqado.io', role: 'MANAGER' }
  // Los schemas validan la request completa: params + body.
  const venueParams = { venueId: 'cmpe64yq2001f9k92m0lbhmf4' }
  const updateParams = { ...venueParams, teamMemberId: 'cmpe6501q003t9k92f475c8qu' }
  const editar = (pin: unknown) => UpdateTeamMemberSchema.safeParse({ params: updateParams, body: { pin } })

  const pinDe = (n: number) => '1'.repeat(n)

  describe('editar un miembro del equipo (la pantalla que se usa de verdad)', () => {
    it.each([PIN_MIN_LENGTH, 6, 7, PIN_MAX_LENGTH])('acepta un PIN de %i dígitos', n => {
      expect(editar(pinDe(n)).success).toBe(true)
    })

    it.each([PIN_MIN_LENGTH - 1, PIN_MAX_LENGTH + 1])('rechaza un PIN de %i dígitos', n => {
      expect(editar(pinDe(n)).success).toBe(false)
    })

    it('rechaza un PIN con letras', () => {
      expect(editar('12ab56').success).toBe(false)
    })

    // Vaciar el PIN es BORRARLO, no un PIN inválido: las pantallas de edición
    // mandan '' o null para quitárselo a alguien.
    it.each([['', 'cadena vacía'], [null, 'null']])('deja borrar el PIN con %s (%s)', valor => {
      expect(editar(valor).success).toBe(true)
    })
  })

  it('invitar y editar coinciden: lo que uno acepta, el otro también', () => {
    const largo = pinDe(PIN_MAX_LENGTH)
    expect(InviteTeamMemberSchema.safeParse({ params: venueParams, body: { ...base, pin: largo } }).success).toBe(true)
    expect(editar(largo).success).toBe(true)
  })
})
