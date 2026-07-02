/** Secreto persistible de una conexión (se cifra antes de guardar). */
export interface Grant {
  refreshToken: string
  expiresAt?: string | null
}

/** Cuenta tal como la reporta el proveedor (negocio). */
export interface ProviderAccount {
  externalId: string
  label: string | null
  clabe: string | null
  active: boolean | null
  balance: number | null // saldo si viene en el listado; null si no
}

/** Snapshot de saldo de UNA cuenta. */
export interface BalanceSnapshot {
  amount: number | null
  currency: string
  active: boolean | null
  providerAccountLabel: string | null
}

/** Resultado de connect/validateDevice/validateTwoFactorCode. */
export type ConnectResult =
  | { kind: 'connected'; grant: Grant; accounts: ProviderAccount[] }
  | { kind: 'need_device_validation'; challenge: { accessToken: string; processId: string } }
  | { kind: 'need_two_factor_auth'; challenge: { accessToken: string } }

/** Lo que el cliente necesita para operar ya autenticado. */
export interface ConnectionContext {
  accessToken: string
}

export interface ConnectInput {
  email: string
  password: string
  deviceIdentifier: string
}

export interface FinancialProviderClient {
  connect(input: ConnectInput): Promise<ConnectResult>
  validateDevice(input: {
    email: string
    password: string
    deviceIdentifier: string
    challenge: { accessToken: string; processId: string }
    code: string
  }): Promise<ConnectResult>
  validateTwoFactorCode(input: {
    email: string
    deviceIdentifier: string
    challenge: { accessToken: string }
    code: string
  }): Promise<ConnectResult>
  refresh(grant: Grant, deviceIdentifier: string): Promise<{ grant: Grant; ctx: ConnectionContext }>
  revoke(ctx: ConnectionContext): Promise<void>
  listAccounts(ctx: ConnectionContext): Promise<ProviderAccount[]>
  getBalance(ctx: ConnectionContext, externalId: string): Promise<BalanceSnapshot>
}
