import prisma from '@/utils/prismaClient'
import { buildHumanSummary } from '@/services/support/humanSummary.service'
import { sourceRef, type LibraryGuide } from '@/services/support/knowledge.service'
import { SUPPORT_GUIDE_CHANGED } from '@/services/support/texts'

it('offers a user-reviewed handoff without copying questions, identity or promising an external action', async () => {
  ;(prisma.supportConversation.findFirst as jest.Mock).mockResolvedValue({ app: 'android', appVersion: '2.25.1', deviceFamily: null })
  ;(prisma.supportMessage.findMany as jest.Mock).mockResolvedValue([{ sourceIds: [], body: 'PIN:1234 VENTAS_SECRETAS', answer: 'SECRETO' }])
  const summary = await buildHumanSummary('c123456789012345678901234', 2)
  expect(summary).toContain('POS Android')
  expect(summary).toContain('2.25.1')
  expect(summary).toContain('mailto:hola@avoqado.io')
  expect(summary).toContain('No se ha abierto un ticket')
  expect(summary).not.toMatch(/1234|VENTAS_SECRETAS|SECRETO|\?body=/)
  expect(summary.length).toBeLessThanOrEqual(1500)
  expect(prisma.supportMessage.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ generation: 2 }), take: 6 }),
  )
})
it('does not reuse another generation or a deleted conversation', async () => {
  ;(prisma.supportConversation.findFirst as jest.Mock).mockResolvedValue(null)
  expect(await buildHumanSummary('c123456789012345678901234', 1)).toContain('hola@avoqado.io')
  expect(prisma.supportMessage.findMany).not.toHaveBeenCalled()
})
it('human summary lists an internal page by title without a url line', async () => {
  const page = (o: Partial<LibraryGuide>): LibraryGuide => ({
    id: 'android/caja/abrir-caja',
    app: 'android',
    title: 'Abrir la caja',
    summary: 'Abre la caja.',
    steps: ['Toca Caja.'],
    publicUrl: '',
    requiredPermissions: [],
    keywords: [],
    body: 'Toca Caja.',
    general: false,
    internal: true,
    hash: 'b'.repeat(64),
    ...o,
  })
  const cash = page({})
  const branch = page({
    id: 'dashboard/inicio/cambiar-sucursal',
    app: 'dashboard',
    title: 'Cambiar de sucursal',
    publicUrl: 'https://avoqado.io/help/dashboard/inicio/cambiar-sucursal',
    internal: false,
    hash: 'c'.repeat(64),
  })
  ;(prisma.supportConversation.findFirst as jest.Mock).mockResolvedValue({ app: 'android', appVersion: '2.25.1', deviceFamily: null })
  ;(prisma.supportMessage.findMany as jest.Mock).mockResolvedValue([{ sourceIds: [sourceRef(cash)] }, { sourceIds: [sourceRef(branch)] }])
  const lines = (await buildHumanSummary('c123456789012345678901234', 2, prisma, [cash, branch])).split('\n')
  const at = lines.indexOf('Guía intentada: Abrir la caja')
  expect(at).toBeGreaterThan(0)
  expect(lines[at + 1]).toBe('Guía intentada: Cambiar de sucursal')
  expect(lines[at + 2]).toBe(branch.publicUrl)
  expect(lines.join('\n')).not.toContain('avoqado.io/help/android')
})

// T-F10a (Codex P2 of codex-tf-verifica): the summary only knows the CURRENT library. When a saved `id@hash8` is not the version that
// is published now, the current title is not presented as the one the person was shown: it says the guide changed afterwards.
it('a guide that changed after the answer is not presented as the one shown then: «(la guía cambió después)»', async () => {
  const shown = (o: Partial<LibraryGuide>): LibraryGuide => ({
    id: 'dashboard/inicio/cambiar-sucursal',
    app: 'dashboard',
    title: 'TÍTULO DE ENTONCES',
    summary: 'Cambia de sucursal.',
    steps: ['Abre el selector.'],
    publicUrl: 'https://avoqado.io/help/dashboard/inicio/cambiar-sucursal',
    requiredPermissions: [],
    keywords: [],
    body: 'Abre el selector.',
    general: false,
    internal: false,
    hash: 'a'.repeat(64),
    ...o,
  })
  const then = shown({})
  const now = shown({ title: 'NUEVO TÍTULO', hash: 'b'.repeat(64) })
  const same = shown({
    id: 'dashboard/ventas/ver-pagos',
    title: 'Ver pagos',
    publicUrl: 'https://avoqado.io/help/dashboard/ventas/ver-pagos',
  })
  ;(prisma.supportConversation.findFirst as jest.Mock).mockResolvedValue({ app: 'dashboard', appVersion: null, deviceFamily: null })
  ;(prisma.supportMessage.findMany as jest.Mock).mockResolvedValue([
    { sourceIds: [sourceRef(then)] },
    { sourceIds: ['#clarify', sourceRef(then), sourceRef(same)] },
    { sourceIds: [sourceRef(same)] },
  ])
  const summary = await buildHumanSummary('c123456789012345678901234', 2, prisma, [now, same])
  expect(summary).toContain(`Guía intentada: NUEVO TÍTULO ${SUPPORT_GUIDE_CHANGED}\n${now.publicUrl}\n`)
  expect(summary).toContain(`Se le ofrecieron: NUEVO TÍTULO ${SUPPORT_GUIDE_CHANGED}, Ver pagos\n`)
  // the one that did not change goes as always
  expect(summary).toContain(`Guía intentada: Ver pagos\n${same.publicUrl}\n`)
  expect(summary).not.toMatch(/NUEVO TÍTULO\n/)
  expect(SUPPORT_GUIDE_CHANGED).toBe('(la guía cambió después)')
})
