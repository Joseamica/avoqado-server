import {
  parseCommercialAcquisitionContextCleanupCliArgs,
  runCommercialAcquisitionContextCleanupCli,
} from '../../../scripts/commercial/cleanup-acquisition-contexts'

const RESULT = {
  scanned: 2,
  deleted: 1,
  preservedReferenced: 1,
  preservedDatabaseRejected: 0,
  retried: 0,
  exhausted: false,
  nextCursor: 'opaque-cursor',
}

describe('commercial acquisition context cleanup CLI', () => {
  it('is dry-run by default and accepts only bounded execution options', () => {
    expect(parseCommercialAcquisitionContextCleanupCliArgs([])).toEqual({
      execute: false,
      pageSize: 50,
      maxScanned: 500,
      maxRuntimeMs: 5_000,
    })
    expect(
      parseCommercialAcquisitionContextCleanupCliArgs(['--execute', '--page-size=100', '--max-scanned=1000', '--max-runtime-ms=10000']),
    ).toEqual({ execute: true, pageSize: 100, maxScanned: 1_000, maxRuntimeMs: 10_000 })
  })

  it.each([['--cutoff=2026-08-28T12:00:00.000Z'], ['--page-size=101'], ['--max-scanned=1001'], ['--max-runtime-ms=10001'], ['--unknown']])(
    'rejects unsafe or unknown arguments: %s',
    argument => {
      expect(() => parseCommercialAcquisitionContextCleanupCliArgs([argument])).toThrow(
        'COMMERCIAL_ACQUISITION_CLEANUP_CLI_ARGUMENT_INVALID',
      )
    },
  )

  it('prints only count results and disconnects only the injected owned client', async () => {
    const cleanup = jest.fn().mockResolvedValue(RESULT)
    const disconnect = jest.fn().mockResolvedValue(undefined)
    const write = jest.fn()

    await expect(runCommercialAcquisitionContextCleanupCli([], { cleanup, disconnect, write })).resolves.toEqual(RESULT)

    expect(cleanup).toHaveBeenCalledWith({ execute: false, pageSize: 50, maxScanned: 500, maxRuntimeMs: 5_000 })
    expect(write).toHaveBeenCalledWith(`${JSON.stringify(RESULT)}\n`)
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0]).not.toContain('tokenHash')
    expect(write.mock.calls[0][0]).not.toContain('attribution')
  })

  it('disconnects when cleanup fails without printing raw failure details', async () => {
    const failure = new Error('sensitive database detail')
    const disconnect = jest.fn().mockResolvedValue(undefined)
    const write = jest.fn()

    await expect(
      runCommercialAcquisitionContextCleanupCli(['--execute'], {
        cleanup: jest.fn().mockRejectedValue(failure),
        disconnect,
        write,
      }),
    ).rejects.toBe(failure)
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled()
  })
})
