/** Secreto persistible de una conexión (se cifra antes de guardar). */
export interface Grant {
  refreshToken: string
  expiresAt?: string | null
}

/** Cuenta tal como la reporta el proveedor (negocio). */
export interface ProviderAccount {
  externalId: string
  /** idCuenta de la cuenta de dispersión — necesario para movimientos. Null si el provider no lo reporta. */
  cuentaId: string | null
  /** idCuentaAlt de la cuenta de dispersión — el id "alt" que exige add-transferenciaMG como ORIGEN. */
  altId: number | null
  label: string | null
  clabe: string | null
  active: boolean | null
  balance: number | null // saldo si viene en el listado; null si no
}

/** Cuenta MG resuelta por número (get-MoneyGiverAlt) — usada para el DESTINO de un traspaso. */
export interface MgAltAccount {
  altId: number
  name: string | null
  accountType: string | null
}

/** Resultado de un traspaso interno. `ok` solo si el proveedor confirmó success. */
export interface InternalTransferResult {
  ok: boolean
  movementId: string | null
  message: string | null
}

/** Snapshot de saldo de UNA cuenta. */
export interface BalanceSnapshot {
  amount: number | null
  currency: string
  active: boolean | null
  providerAccountLabel: string | null
}

/** Un movimiento (SPEI in/out, transferencia interna, dispersión) tal como lo normaliza el client. */
export interface ProviderMovement {
  id: string | null
  type: string | null // tipoMovimiento
  operationType: string | null // tipoOperacion
  concept: string | null
  date: string | null // fechaCreacion (ISO del provider, passthrough)
  amount: number | null
  status: string | null
  statusId: number | null
  beneficiary: string | null
  originator: string | null
  reference: string | null
}

/** Página de movimientos. */
export interface MovementPage {
  movements: ProviderMovement[]
  total: number
}

/** Agregados de una categoría de movimiento (SPEI in, SPEI out, transferencia interna, dispersión). */
export interface MovementCategoryStats {
  amount: number | null
  fee: number | null
  count: number | null
}

/** Estadísticas de movimientos de una cuenta, por categoría. */
export interface MovementStats {
  accountName: string | null
  clabe: string | null
  speiIn: MovementCategoryStats
  speiOut: MovementCategoryStats
  internalTransfers: MovementCategoryStats
  dispersions: MovementCategoryStats
}

/** Query de paginación/rango para listMovements. */
export interface MovementQuery {
  page: number
  size: number
  from?: string
  to?: string
}

/** Resultado de connect/validateDevice/validateTwoFactorCode. */
export type ConnectResult =
  // `accessToken`: el token de sesión ya válido con el que se acaba de autenticar.
  // Se cachea para que la primera lectura de saldo use ESTE token en vez de disparar
  // un refresh silencioso (que el proveedor rechaza en sesiones validadas con 2FA).
  | { kind: 'connected'; grant: Grant; accounts: ProviderAccount[]; accessToken?: string }
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
  // La LISTA de movimientos scopea por idNegocio en la ruta + idCuenta como query param
  // (con solo idCuenta en la ruta el proveedor devuelve un pool global de ~5M movimientos
  // ajenos). Las ESTADÍSTICAS sí van por idCuenta en la ruta (ahí sí acota a la cuenta).
  listMovements(ctx: ConnectionContext, idNegocio: string, cuentaId: string, query: MovementQuery): Promise<MovementPage>
  getMovementStats(ctx: ConnectionContext, cuentaId: string, range: { from?: string; to?: string }): Promise<MovementStats>
  /** Resuelve una cuenta MG por su número interno (4-6 dígitos) → su idCuentaAlt + nombre. Null si no existe. */
  resolveMgAlt(ctx: ConnectionContext, accountNumber: string): Promise<MgAltAccount | null>
  /** Traspaso interno MG→MG (sin CLABE). `amount` en pesos. NO idempotente en el proveedor — el caller deduplica. */
  internalTransfer(
    ctx: ConnectionContext,
    input: { sourceAltId: number; destAltId: number; amount: number; concept: string },
  ): Promise<InternalTransferResult>
}
