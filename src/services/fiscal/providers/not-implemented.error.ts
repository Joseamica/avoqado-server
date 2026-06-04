/** Thrown by a FiscalProvider adapter for a contract method it does not yet implement. */
export class FiscalNotImplementedError extends Error {
  constructor(provider: string, method: string) {
    super(`FiscalProvider "${provider}" does not implement "${method}"`)
    this.name = 'FiscalNotImplementedError'
  }
}
