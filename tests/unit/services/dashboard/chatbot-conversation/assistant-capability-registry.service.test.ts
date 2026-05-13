import { AssistantCapabilityRegistryService } from '@/services/dashboard/chatbot-conversation/assistant-capability-registry.service'

describe('AssistantCapabilityRegistryService', () => {
  const registry = new AssistantCapabilityRegistryService()

  it('registers settlementCalendar as an executable venue-scoped query capability', () => {
    const capability = registry.getCapability('settlementCalendar')

    expect(capability).toEqual(
      expect.objectContaining({
        id: 'settlementCalendar',
        kind: 'query',
        status: 'registered',
        scope: 'venue',
        requiresVenueScope: true,
        permissions: ['settlements:read'],
        riskLevel: 'low',
        dataSource: 'shared_query.settlementCalendar',
      }),
    )
    expect(capability?.examples).toContain('cuanto me liquidan hoy')
  })

  it('marks legacy adHocAnalytics as blocked so coverage grows through explicit tools', () => {
    const capability = registry.getCapability('adHocAnalytics')

    expect(capability).toEqual(
      expect.objectContaining({
        id: 'adHocAnalytics',
        kind: 'query',
        status: 'blocked',
        riskLevel: 'critical',
        dataSource: 'legacy.text_to_sql',
      }),
    )
  })

  it('mirrors registered chatbot actions with permissions and confirmation risk', () => {
    const capability = registry.getCapability('menu.product.delete')

    expect(capability).toEqual(
      expect.objectContaining({
        id: 'menu.product.delete',
        kind: 'action',
        status: 'registered',
        scope: 'venue',
        requiresVenueScope: true,
        permissions: ['menu:delete'],
        riskLevel: 'high',
        requiresConfirmation: true,
        requiresDoubleConfirmation: true,
      }),
    )
    expect(capability?.schema.fields).toContain('name')
  })

  it('registers payment link and reservation read tools while keeping reservation create as backlog', () => {
    const executableIds = registry.listExecutableCapabilities().map(capability => capability.id)

    expect(registry.getCapability('paymentLinks.list')).toEqual(
      expect.objectContaining({
        status: 'registered',
        requiresVenueScope: true,
        permissions: ['payment-link:read'],
      }),
    )
    expect(registry.getCapability('reservations.summary')).toEqual(
      expect.objectContaining({
        status: 'registered',
        requiresVenueScope: true,
        permissions: ['reservations:read'],
      }),
    )
    expect(registry.getCapability('reservations.list')).toEqual(
      expect.objectContaining({
        status: 'registered',
        requiresVenueScope: true,
        permissions: ['reservations:read'],
      }),
    )
    expect(registry.getCapability('reservations.create')).toEqual(
      expect.objectContaining({
        status: 'backlog',
        requiresConfirmation: true,
        permissions: ['reservations:create'],
      }),
    )
    expect(executableIds).toContain('paymentLinks.list')
    expect(executableIds).toContain('reservations.summary')
    expect(executableIds).toContain('reservations.list')
    expect(executableIds).not.toContain('reservations.create')
  })

  it('registers product how-to capabilities without business-data access', () => {
    const capability = registry.getCapability('howTo.teamInvite')

    expect(capability).toEqual(
      expect.objectContaining({
        kind: 'howTo',
        status: 'registered',
        requiresVenueScope: false,
        permissions: [],
        dataSource: 'dashboard_knowledge_base',
      }),
    )
  })
})
