import { terminalSettingsBody } from '@/routes/superadmin/terminal-settings.schema'

it('acepta cambios parciales sin inventar valores para ajustes ausentes', () => {
  expect(terminalSettingsBody.parse({ showQuickPayment: false })).toEqual({ showQuickPayment: false })
})
it.each([
  { showQuickPayment: 'false' },
  { tipSuggestions: [15, 15] },
  { tipSuggestions: [150] },
  { cellularFailoverCooldownSeconds: -1 },
  { surpriseSetting: true },
  {},
])('rechaza ajustes inválidos antes de escribir %j', value => {
  expect(terminalSettingsBody.safeParse(value).success).toBe(false)
})
// F0-B, ronda final (I1): el superadmin usa LA regla de propinas del POS (`tipSuggestionsRule`), no una tercera copia.
it('las propinas se validan con la MISMA regla que el PUT de la terminal y el de la organización', () => {
  const r = terminalSettingsBody.safeParse({ tipSuggestions: [5, 10, 15, 20, 25, 30, 35] })
  expect(r.success).toBe(false)
  if (!r.success) expect(r.error.errors.map(e => e.message)).toEqual(['No puedes ofrecer más de 6 porcentajes de propina'])
})
