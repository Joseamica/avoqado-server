import { confirmGuard } from '../../../scripts/mcp/writes'

describe('confirmGuard', () => {
  it('preview mode (confirm=false) does NOT call execute and reports nothing changed', async () => {
    const execute = jest.fn().mockResolvedValue({ created: true })
    const res = await confirmGuard({ tool: 't', actor: 'a', confirm: false, args: {}, preview: { x: 1 }, execute })
    expect(execute).not.toHaveBeenCalled()
    expect(JSON.stringify(res)).toMatch(/PREVIEW/)
  })

  it('confirm mode (confirm=true) calls execute exactly once and reports DONE', async () => {
    const execute = jest.fn().mockResolvedValue({ created: true })
    const res = await confirmGuard({ tool: 't', actor: 'a', confirm: true, args: {}, preview: {}, execute })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(res)).toMatch(/DONE/)
  })

  it('returns the FULL result to the caller even when a redactor is set', async () => {
    const execute = jest.fn().mockResolvedValue({ secretKey: 'sk_live_abc', id: '1' })
    const res = await confirmGuard({
      tool: 't',
      actor: 'a',
      confirm: true,
      args: {},
      preview: {},
      redact: r => ({ ...(r as object), secretKey: '***' }),
      execute,
    })
    // The user-facing result keeps the secret (redaction only affects the audit log).
    expect(JSON.stringify(res)).toMatch(/sk_live_abc/)
  })
})
