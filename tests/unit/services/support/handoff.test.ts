import type { Prisma, SupportConversation } from '@prisma/client'
import {
  isHandoffYes,
  secondFailureText,
  snapshotHandoffMeta,
  supportPhoneHash,
  handoffDedupeKey,
} from '@/services/support/handoff.service'
import { sourceRef, type LibraryGuide } from '@/services/support/knowledge.service'
import { SUPPORT_GUIDE_CHANGED, SUPPORT_HANDOFF_OFFER, SUPPORT_SECOND_FAILURE } from '@/services/support/texts'

const guide = (extra: Partial<LibraryGuide> = {}): LibraryGuide => ({
  id: 'dashboard/menu/gestionar-productos',
  app: 'dashboard',
  title: 'Crear productos',
  summary: 'Da de alta productos.',
  steps: ['Paso uno'],
  publicUrl: 'https://avoqado.io/help/dashboard/menu/gestionar-productos',
  requiredPermissions: [],
  keywords: [],
  body: 'Da de alta productos.',
  general: false,
  internal: false,
  hash: 'a'.repeat(64),
  ...extra,
})

describe('isHandoffYes', () => {
  it.each([
    'sí',
    'Si',
    'SÍ',
    '¡Sí!',
    'sip',
    'Claro',
    'ok',
    'Okay.',
    'va',
    'sale',
    'Dale',
    'porfa',
    'Por favor',
    'sí, por favor',
    'Sí porfa',
    'si gracias',
    'Sí, quiero',
    'quiero',
    'yes',
    '  sí  ',
  ])('«%s» is a yes', body => {
    expect(isHandoffYes(body)).toBe(true)
  })

  it.each(['no', 'No, gracias', 'sí pero luego', 'claro que no', '¿cómo cierro caja?', 'PERSONA', '', '👍', 'okey dokey'])(
    '«%s» is not a yes',
    body => {
      expect(isHandoffYes(body)).toBe(false)
    },
  )
})

describe('secondFailureText', () => {
  it('with a public guide: the short text, its title and link, and the offer', () => {
    const g = guide()
    expect(secondFailureText(g)).toBe(
      `${SUPPORT_SECOND_FAILURE}\n\nLo más cercano: Crear productos https://avoqado.io/help/dashboard/menu/gestionar-productos\n\n${SUPPORT_HANDOFF_OFFER}`,
    )
  })

  it('with an internal page: its title and «(manual de Avoqado)», never a link', () => {
    const g = guide({ id: 'tpv/caja/cerrar-turno', title: 'Cerrar el turno', publicUrl: '', internal: true })
    const text = secondFailureText(g)
    expect(text).toBe(`${SUPPORT_SECOND_FAILURE}\n\nLo más cercano: Cerrar el turno (manual de Avoqado)\n\n${SUPPORT_HANDOFF_OFFER}`)
    expect(text).not.toMatch(/https?:/)
  })

  it('without a guide: the short text and the offer, with no empty line in between', () => {
    expect(secondFailureText(null)).toBe(`${SUPPORT_SECOND_FAILURE}\n\n${SUPPORT_HANDOFF_OFFER}`)
  })
})

describe('keys', () => {
  it('one notice per conversation and generation; the phone hash is sha256 hex of receiver and phone', () => {
    expect(handoffDedupeKey('conv1', 3)).toBe('handoff:conv1:3')
    expect(supportPhoneHash('r1', '+525500000000')).toMatch(/^[a-f0-9]{64}$/)
    expect(supportPhoneHash('r1', '+525500000000')).not.toBe(supportPhoneHash('r2', '+525500000000'))
  })
})

// T-F10a (Codex P2 of codex-tf-verifica): the notice to the team lists the guides of the conversation with the CURRENT library. A
// saved `id@hash8` that is no longer the published version is not presented with today's title as if it were the one shown then.
describe('snapshotHandoffMeta', () => {
  it('a guide that changed after the answer is listed as «(la guía cambió después)»; one that did not, as always', async () => {
    const then = guide({ title: 'TÍTULO DE ENTONCES' })
    const now = guide({ title: 'NUEVO TÍTULO', hash: 'b'.repeat(64) })
    const same = guide({
      id: 'dashboard/ventas/ver-pagos',
      title: 'Ver pagos',
      publicUrl: 'https://avoqado.io/help/dashboard/ventas/ver-pagos',
    })
    const findMany = jest
      .fn()
      .mockResolvedValue([{ sourceIds: [sourceRef(then)] }, { sourceIds: ['#clarify', sourceRef(same), sourceRef(then)] }])
    const tx = { supportMessage: { findMany } } as unknown as Prisma.TransactionClient
    // A personal conversation with no person and no branch: no other query.
    const conversation = {
      id: 'c123456789012345678901234',
      generation: 1,
      mode: 'PERSONAL',
      staffId: null,
      venueId: null,
      phone: '+525512345678',
      app: 'dashboard',
      appVersion: null,
      deviceFamily: null,
    } as unknown as SupportConversation
    const meta = await snapshotHandoffMeta(tx, conversation, 'REQUESTED', new Date('2026-11-17T12:00:00Z'), [now, same])
    expect(meta.guides).toEqual([`NUEVO TÍTULO ${SUPPORT_GUIDE_CHANGED}`, 'Ver pagos'])
    expect(meta.guides).not.toContain('NUEVO TÍTULO')
  })
})
