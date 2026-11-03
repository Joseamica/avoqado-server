import { isLinkingNumberEnabledForOrg } from '@/services/playtelecom/linkingNumber.flag'
import { moduleService } from '@/services/modules/module.service'

jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  moduleService: { getOrganizationModules: jest.fn() },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))

const getOrgModules = moduleService.getOrganizationModules as jest.Mock
const mod = (code: string, enabled: boolean, config: Record<string, unknown>) => ({ code, scope: 'ORGANIZATION', enabled, config })

beforeEach(() => jest.clearAllMocks())

describe('isLinkingNumberEnabledForOrg', () => {
  it('true sólo con SERIALIZED_INVENTORY prendido en la organización y features.linkingNumber === true', async () => {
    getOrgModules.mockResolvedValue([mod('SERIALIZED_INVENTORY', true, { features: { linkingNumber: true } })])

    await expect(isLinkingNumberEnabledForOrg('org-1')).resolves.toBe(true)
    expect(getOrgModules).toHaveBeenCalledWith('org-1')
  })

  it.each([
    ['módulo apagado', [mod('SERIALIZED_INVENTORY', false, { features: { linkingNumber: true } })]],
    ['sin features', [mod('SERIALIZED_INVENTORY', true, {})]],
    ['interruptor apagado', [mod('SERIALIZED_INVENTORY', true, { features: { linkingNumber: false } })]],
    ['interruptor como texto', [mod('SERIALIZED_INVENTORY', true, { features: { linkingNumber: 'true' } })]],
    ['el interruptor en otro módulo', [mod('WHITE_LABEL_DASHBOARD', true, { features: { linkingNumber: true } })]],
    ['sin módulos', []],
  ])('false con %s', async (_caso, modules) => {
    getOrgModules.mockResolvedValue(modules)

    await expect(isLinkingNumberEnabledForOrg('org-1')).resolves.toBe(false)
  })
})
