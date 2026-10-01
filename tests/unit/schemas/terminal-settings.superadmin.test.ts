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
