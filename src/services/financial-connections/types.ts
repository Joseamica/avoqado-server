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

/** Cuenta interna del proveedor resuelta por número — usada para el DESTINO de un traspaso. */
export interface ProviderAltAccount {
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

/** Envío SPEI a un banco externo, tal como lo exige el endpoint External del proveedor. */
export interface SpeiOutClientInput {
  /** Identificador de usuario del proveedor dueño de la cuenta origen (el proveedor resuelve la cuenta desde él). */
  externalUserId: string
  /** UUID generado por NOSOTROS una vez por envío — idempotencia real del lado del proveedor. */
  idempotencyKey: string
  destinationClabe: string
  beneficiaryName: string
  amount: number
  concept: string
  /** Código del banco destino, del catálogo del proveedor (listSpeiBanks). */
  idBanco: number
}

/** Resultado de un SPEI externo. `ok` solo si el proveedor confirmó success. */
export interface SpeiOutResult {
  ok: boolean
  /** Folio de la operación (idOperacion) — el que el usuario puede rastrear. */
  operationId: string | null
  /** id (uuid) del envío en el proveedor — sirve para consultar el estatus después. */
  transferId: string | null
  message: string | null
}

/** Banco destino del catálogo del proveedor para SPEI externo. */
export interface SpeiBank {
  idBanco: number
  name: string | null
  /** Campo `clabe` del catálogo (int) — prefijo institucional de la CLABE según el proveedor. */
  clabePrefix: number | null
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
  typeId: number | null // idTipoMovimiento — valor a mandar de vuelta como filtro TipoMovimiento
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

/** Query de paginación/rango/filtro para listMovements. */
export interface MovementQuery {
  page: number
  size: number
  from?: string
  to?: string
  // El proveedor solo acepta UN valor por filtro (no es una lista IN) — de ahí que
  // la UI use un select de valor único (SingleSelectFilterContent), no checkboxes.
  type?: number // -> TipoMovimiento (idTipoMovimiento de un movimiento ya visto)
  status?: number // -> idEstatus
}

/** Tipo de cuenta del proveedor: MERCHANT (negocio, flujo actual) o CLIENT (personal, PWA). */
export type AccountKind = 'MERCHANT' | 'CLIENT'

/** Resultado de connect/validateDevice/validateTwoFactorCode. */
export type ConnectResult =
  // `accessToken`: el token de sesión ya válido con el que se acaba de autenticar.
  // Se cachea para que la primera lectura de saldo use ESTE token en vez de disparar
  // un refresh silencioso (que el proveedor rechaza en sesiones validadas con 2FA).
  | {
      kind: 'connected'
      grant: Grant
      accounts: ProviderAccount[]
      accessToken?: string
      externalClientId?: string
      externalDeviceId?: string
    }
  | {
      kind: 'need_device_validation'
      challenge: { accessToken: string; processId: string; externalClientId?: string | null; externalDeviceId?: string | null }
    }
  | { kind: 'need_two_factor_auth'; challenge: { accessToken: string; externalClientId?: string | null; externalDeviceId?: string | null } }

/** Lo que el cliente necesita para operar ya autenticado. */
export interface ConnectionContext {
  accessToken: string
  kind: AccountKind // REQUERIDO — el compilador obliga a threadear en cada call site
  externalClientId?: string | null
  idDispositivo?: string | null // llave para descifrar el envelope del cliente (AES-128-CBC, key=idDispositivo[0:16])
}

export interface ConnectInput {
  email: string
  password: string
  deviceIdentifier: string
  accountKind?: AccountKind
}

export interface FinancialProviderClient {
  connect(input: ConnectInput): Promise<ConnectResult>
  validateDevice(input: {
    email: string
    password: string
    deviceIdentifier: string
    challenge: { accessToken: string; processId: string; externalClientId?: string | null; externalDeviceId?: string | null }
    code: string
    accountKind: AccountKind
  }): Promise<ConnectResult>
  validateTwoFactorCode(input: {
    email: string
    deviceIdentifier: string
    challenge: { accessToken: string; externalClientId?: string | null; externalDeviceId?: string | null }
    code: string
    accountKind: AccountKind
  }): Promise<ConnectResult>
  refresh(grant: Grant, deviceIdentifier: string, kind: AccountKind): Promise<{ grant: Grant; ctx: ConnectionContext }>
  revoke(ctx: ConnectionContext): Promise<void>
  listAccounts(ctx: ConnectionContext): Promise<ProviderAccount[]>
  getBalance(ctx: ConnectionContext, externalId: string): Promise<BalanceSnapshot>
  // La LISTA de movimientos branchea por ctx.kind: MERCHANT scopea por idNegocio en la ruta +
  // idCuenta como query param (con solo idCuenta en la ruta el proveedor devuelve un pool
  // global de ~5M movimientos ajenos); CLIENT scopea por idCuenta directo EN LA RUTA, sin
  // idCuenta como query (scoping confirmado en vivo — Task 1.5). Las ESTADÍSTICAS sí van por
  // idCuenta en la ruta para ambos kinds (ahí sí acota a la cuenta).
  listMovements(ctx: ConnectionContext, idNegocio: string, cuentaId: string, query: MovementQuery): Promise<MovementPage>
  getMovementStats(ctx: ConnectionContext, cuentaId: string, range: { from?: string; to?: string }): Promise<MovementStats>
  /** Resuelve una cuenta del proveedor por su número interno (4-6 dígitos) → su id alterno + nombre. Null si no existe. */
  resolveAltAccount(ctx: ConnectionContext, accountNumber: string): Promise<ProviderAltAccount | null>
  /** Traspaso interno entre cuentas del proveedor (sin CLABE). `amount` en pesos. NO idempotente en el proveedor — el service deduplica por contenido (ventana corta). */
  internalTransfer(
    ctx: ConnectionContext,
    input: { sourceAltId: number; destAltId: number; amount: number; concept: string },
  ): Promise<InternalTransferResult>
  /**
   * Identificador de usuario del proveedor para la conexión — el ORIGEN que exige el SPEI externo.
   * MERCHANT: viene en el nivel superior de GET /api/auth (fetchMe). CLIENT: ya viaja en ctx.
   */
  getExternalUserId(ctx: ConnectionContext): Promise<string | null>
  /** Catálogo de bancos destino para SPEI externo (solo lectura). */
  listSpeiBanks(ctx: ConnectionContext): Promise<SpeiBank[]>
  /** SPEI saliente a banco externo. Idempotente EN el proveedor vía idempotencyKey. `amount` en pesos. */
  sendSpeiOut(ctx: ConnectionContext, input: SpeiOutClientInput): Promise<SpeiOutResult>
}
