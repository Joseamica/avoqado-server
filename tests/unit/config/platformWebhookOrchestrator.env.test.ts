describe('platform webhook orchestrator environment', () => {
  const originalMode = process.env.PLATFORM_WEBHOOK_ORCHESTRATOR_MODE
  const originalRecovery = process.env.PLATFORM_WEBHOOK_RECOVERY_ENABLED

  afterEach(() => {
    jest.resetModules()
    if (originalMode === undefined) delete process.env.PLATFORM_WEBHOOK_ORCHESTRATOR_MODE
    else process.env.PLATFORM_WEBHOOK_ORCHESTRATOR_MODE = originalMode
    if (originalRecovery === undefined) delete process.env.PLATFORM_WEBHOOK_RECOVERY_ENABLED
    else process.env.PLATFORM_WEBHOOK_RECOVERY_ENABLED = originalRecovery
    jest.restoreAllMocks()
  })

  it('defaults to OFF with recovery disabled', async () => {
    delete process.env.PLATFORM_WEBHOOK_ORCHESTRATOR_MODE
    delete process.env.PLATFORM_WEBHOOK_RECOVERY_ENABLED

    const { env } = await import('@/config/env')

    expect(env.PLATFORM_WEBHOOK_ORCHESTRATOR_MODE).toBe('OFF')
    expect(env.PLATFORM_WEBHOOK_RECOVERY_ENABLED).toBe(false)
  })

  it('accepts SHADOW and the exact true literal', async () => {
    process.env.PLATFORM_WEBHOOK_ORCHESTRATOR_MODE = 'SHADOW'
    process.env.PLATFORM_WEBHOOK_RECOVERY_ENABLED = 'true'

    const { env } = await import('@/config/env')

    expect(env.PLATFORM_WEBHOOK_ORCHESTRATOR_MODE).toBe('SHADOW')
    expect(env.PLATFORM_WEBHOOK_RECOVERY_ENABLED).toBe(true)
  })

  it('accepts explicit OFF and the exact false literal', async () => {
    process.env.PLATFORM_WEBHOOK_ORCHESTRATOR_MODE = 'OFF'
    process.env.PLATFORM_WEBHOOK_RECOVERY_ENABLED = 'false'

    const { env } = await import('@/config/env')

    expect(env.PLATFORM_WEBHOOK_ORCHESTRATOR_MODE).toBe('OFF')
    expect(env.PLATFORM_WEBHOOK_RECOVERY_ENABLED).toBe(false)
  })

  it.each([
    ['PLATFORM_WEBHOOK_ORCHESTRATOR_MODE', 'ACTIVE'],
    ['PLATFORM_WEBHOOK_RECOVERY_ENABLED', 'TRUE'],
  ])('fails startup for invalid %s=%s', async (key, value) => {
    process.env.PLATFORM_WEBHOOK_ORCHESTRATOR_MODE = 'OFF'
    process.env.PLATFORM_WEBHOOK_RECOVERY_ENABLED = 'false'
    process.env[key] = value
    const exit = jest.spyOn(process, 'exit').mockImplementation(code => {
      throw new Error(`EXIT:${code}`)
    })

    await expect(import('@/config/env')).rejects.toThrow('EXIT:1')
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('fails startup for OFF with recovery enabled', async () => {
    process.env.PLATFORM_WEBHOOK_ORCHESTRATOR_MODE = 'OFF'
    process.env.PLATFORM_WEBHOOK_RECOVERY_ENABLED = 'true'
    const exit = jest.spyOn(process, 'exit').mockImplementation(code => {
      throw new Error(`EXIT:${code}`)
    })

    await expect(import('@/config/env')).rejects.toThrow('EXIT:1')
    expect(exit).toHaveBeenCalledWith(1)
  })
})
