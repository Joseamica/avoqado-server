# Dispositivos unificados: una identidad, capacidades reales y acciones honestas

**Fecha:** 2026-08-29 · **Estado:** diseño y plan escritos; inversión remota ratificada por producto; auditoría Claude Opus 5 Max
incorporada

**Repos y superficies involucradas:**

| Alias          | Ruta / superficie        | Papel en el cambio inicial                                                                     |
| -------------- | ------------------------ | ---------------------------------------------------------------------------------------------- |
| `server`       | `avoqado-server/`        | Fuente de verdad de identidad, capacidades efectivas y validación de acciones                  |
| `dashboard`    | `avoqado-web-dashboard/` | Renombre visible a Dispositivos y controles condicionados por capacidad + permiso              |
| `android`      | `avoqado-android/`       | Reporta presencia/invertibilidad reales y ejecuta solicitudes remotas de inversión de pantalla |
| `tpv`          | `avoqado-tpv/`           | Sin cambio inicial; el server deriva sus comandos existentes por el tipo de app                |
| `ios`          | `avoqado-ios/`           | Sin cambio inicial; conserva el auto-registro y no anuncia capacidades que aún no implementa   |
| `customer MCP` | `server/src/mcp/`        | `list_devices` expone el mismo contrato efectivo que el dashboard                              |

Rutas sin alias en este documento son relativas a `server/`.

---

## Resultado deseado

La pantalla que hoy se llama **Terminales** pasa a llamarse **Dispositivos** y reúne TPVs de cobro, POS Android/iOS, KDS y futuros equipos
que ejecuten una app de Avoqado. Cada aparato sigue apareciendo por sí solo cuando inicia sesión si ése es su ciclo normal; un POS móvil no
se convierte en una TPV, no necesita alta manual y no necesita activación.

Seleccionar `/devices/:deviceId` debe contestar dos preguntas distintas:

1. **¿Qué puede hacer este aparato y esta app?** — capacidad del dispositivo, resuelta por el server.
2. **¿Puede esta persona ordenar esa acción?** — permiso del usuario, resuelto por el sistema de permisos.

La interfaz sólo ofrece una acción cuando ambas respuestas son afirmativas, y el backend vuelve a comprobarlo antes de cambiar o encolar
nada. Así una Sunmi con segunda pantalla muestra **Invertir pantalla**, un teléfono común no; una TPV PAX/NexGo conserva sus comandos
remotos, y un POS Android no enseña **Reiniciar** mientras no exista un consumidor real de esos comandos en `avoqado-android`.

**Invertir pantalla es una acción remota real, no una preferencia decorativa:** el dashboard crea una solicitud dirigida a ese dispositivo,
Android la adopta cuando sincroniza y confirma el resultado. La UI distingue `pendiente`, `aplicada` y `rechazada`; nunca afirma que el modo
cambió sólo porque el server aceptó el click.

## Lo que no se va a hacer

- No se crea un modelo Prisma `Device` paralelo.
- No se crea una segunda sección que compita con Terminales.
- No se renombran de golpe la tabla/modelo `Terminal`, los endpoints `/tpv` o `/terminals`, ni los permisos `tpv:*`.
- No se obliga a un POS auto-registrado a pasar por compra, código o activación.
- No se implementan comandos remotos en Android/iOS sólo para duplicar el portal del fabricante.
- No se infiere una segunda pantalla por marca, modelo o `formFactor`; "Sunmi" no significa automáticamente "doble pantalla".
- No se convierte `Terminal` en inventario universal de periféricos. Impresoras y básculas independientes conservan sus modelos
  especializados (`PrintStation`, `ScaleProfile`, etc.). Los valores legacy `PRINTER_*` de `TerminalType` se preservan por compatibilidad,
  pero no definen la dirección futura.

---

## Estado actual verificado

### El registro unificado ya existe

`prisma/schema.prisma` ya usa `Terminal` como registro común y separa correctamente varios ejes:

- `type`: propósito/app (`TPV_ANDROID`, `POS_ANDROID`, `POS_IOS`, `POS_DESKTOP`, `KDS`, etc.).
- `formFactor`: forma física (`PHONE`, `TABLET`, `HANDHELD_POS`, `COUNTERTOP_POS`, `DESKTOP`, `UNKNOWN`).
- `selfRegistered`: origen del alta.
- `deviceUid`: la misma identidad que usa el outbox offline y el hub LAN.
- `activatedAt`: activación de una TPV provisionada, no prueba de que cualquier dispositivo esté listo.

`src/services/mobile/deviceRegistry.service.ts` crea un `POS_ANDROID`/`POS_IOS`/`POS_DESKTOP` automáticamente en el primer request
autenticado con headers `X-Device-*`. La fila nace `ACTIVE` y `selfRegistered=true`; no pide activación. Ese flujo es correcto y se
conserva.

### El problema está en las acciones, no en la identidad

El dashboard ya mezcla estos dispositivos en `src/pages/Tpv/Tpvs.tsx`, pero decide acciones con señales que no significan capacidad:

- `activatedAt === null` hace aparecer acciones de alta/borrado también en POS auto-registrados.
- mantenimiento y reinicio aparecen para cualquier renglón si el usuario tiene `tpv:command`.
- `customerDisplayInverted` aparece en el detalle sin comprobar que exista segunda pantalla.
- `OrgTerminalDrawer.tsx` ofrece reinicio, sincronización, bloqueo y mantenimiento sin distinguir el cliente que consume el comando.

El server recibe comandos por varias entradas (`tpvCommandExecutionService`, `orgTerminalsService`, superadmin y rutas legacy), pero la
creación converge en `command-queue.service.ts` y su `validateCommandForTerminal` sólo valida estado/lock/mantenimiento: todavía no valida
familia/capacidad. El resultado engañoso es un comando marcado como enviado o encolado para una app que nunca lo va a leer.

### La capacidad real ya está implementada en un solo cliente

- `avoqado-tpv` recibe y ejecuta comandos desde el heartbeat mediante `CommandExecutor`; no necesita anunciar esa capacidad en la primera
  versión porque el server la puede derivar de `TPV_ANDROID` sin romper APKs viejas.
- `avoqado-android` no consume `TpvCommandQueue`. Sí implementa pantalla de cliente con la API estándar de Android
  (`DisplayManager + Presentation`) en `CustomerDisplayManager.kt`, filtra displays virtuales/remotos y reacciona a conexión/desconexión.
  Ese cliente es quien puede observar si la inversión es realmente posible.
- `avoqado-ios` manda identidad y `formFactor`, pero no tiene comandos remotos ni la experiencia de pantalla de cliente de Android.

### El toggle remoto actual todavía no cumple esa promesa

Hoy `DisplayModeSync.reconcileDisplayMode` en Android da autoridad al dispositivo: si el valor del server difiere, vuelve a subir el valor
local en lugar de adoptarlo. Su test unitario incluso documenta que el server no puede voltear las pantallas. Por eso el update actual del
dashboard puede responder éxito sin cambiar el aparato y después ser revertido por la siguiente sincronización.

El comentario/test justifican esa regla diciendo que el server guarda “un valor por negocio”, pero esa premisa ya es obsoleta:
`customerDisplayInverted` vive en `Terminal` y el GET móvil selecciona la fila exacta por `deviceUid`. La regla correcta será más precisa:
una diferencia libre del server nunca vence al estado local; una **intención tipada, vigente y con `requestId`** sí tiene autoridad acotada.
La implementación debe actualizar ese comentario y reemplazar el test P1, no saltárselo.

Además, una pantalla de cliente **presente** no siempre es **invertible**. En una Sunmi T3 Pro la app puede presentar contenido al cliente
mediante un display virtual del fabricante, pero Android no puede mover ahí la UI de cajero, el touch ni el IME. En una D3 con display
físico separado sí puede. El contrato debe representar ambos hechos por separado.

---

## Referencia del mercado

Square separa la identidad/atributos de un dispositivo de su estado y de las funciones de administración: su objeto `Device` expone
atributos y componentes, mientras Device Management y los perfiles limitan qué configuración o acción existe para cada modalidad. También
distingue el dispositivo que inició sesión del flujo alterno de activación por código. Referencias:

- [Square Device object](https://developer.squareup.com/reference/square/objects/Device)
- [Terminal device monitoring](https://developer.squareup.com/docs/terminal-api/terminal-device-monitoring)
- [Create and manage device profiles](https://squareup.com/help/us/en/article/8114-create-and-manage-device-profiles)

Avoqado adopta esa separación conceptual, no su nomenclatura interna: **Dispositivo** será el lenguaje de producto; `Terminal` seguirá
siendo la entidad técnica ya conectada a órdenes, pagos, salud, comandos y atribución histórica. Renombrar la entidad física aportaría poco
y abriría un cambio masivo sin valor para el usuario.

---

## Alternativas evaluadas

| Alternativa                                                      | Ventaja                                                      | Costo/riesgo                                                                                                        | Veredicto   |
| ---------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ----------- |
| Crear un modelo `Device` y migrar `Terminal`                     | Nombre técnico limpio desde el inicio                        | Duplica o mueve relaciones de órdenes, pagos, salud, comandos y merchants; exige backfill y coordinación cross-repo | Descartada  |
| Mantener Terminales y abrir otra sección Dispositivos            | Cambio inicial pequeño                                       | Un mismo aparato puede aparecer dos veces y cada pantalla acaba con reglas/acciones distintas                       | Descartada  |
| Renombrar DB, API, permisos y UI a `Device` en una sola entrega  | Consistencia nominal total                                   | Rompe contratos, overrides de permisos, bookmarks y clientes con versiones desfasadas; rollback difícil             | Descartada  |
| Renombrar sólo el producto y añadir capacidades sobre `Terminal` | Resuelve la confusión visible y técnica con cambios aditivos | Conviven nombres legacy internos durante un tiempo                                                                  | **Elegida** |

La convivencia interna es deliberada, no deuda accidental: se podrá retirar cada alias cuando las métricas demuestren que ya no tiene
consumidores. El usuario obtiene el concepto correcto sin pagar el riesgo de un big bang.

---

## Decisiones del diseño

| #   | Decisión                        | Elección                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Fuente de verdad de identidad   | Una sola fila `Terminal` por aparato/venue; no hay modelo `Device` nuevo                                                                                                                                                                                                                                  |
| D2  | Nombre visible                  | **Dispositivos** en dashboard, navegación, títulos y copy                                                                                                                                                                                                                                                 |
| D3  | Nombre técnico                  | `Terminal`, `/tpv`, `/terminals` y `tpv:*` permanecen inicialmente por compatibilidad                                                                                                                                                                                                                     |
| D4  | Alta de POS                     | Auto-registro actual; sin creación manual ni activación                                                                                                                                                                                                                                                   |
| D5  | Alta de TPV de cobro            | Conserva compra/provisionamiento + activación existentes                                                                                                                                                                                                                                                  |
| D6  | Capacidad                       | Contrato efectivo calculado por server; no una lista confiada ciegamente al cliente                                                                                                                                                                                                                       |
| D7  | Hechos de hardware              | El cliente reporta sólo hechos que el server no puede saber: display de cliente presente, display invertible y versión del protocolo de intención                                                                                                                                                         |
| D8  | Autorización                    | Una acción requiere **capacidad AND permiso**; ninguna sustituye a la otra                                                                                                                                                                                                                                |
| D9  | Seguridad                       | El backend rechaza acciones no soportadas aunque se invoque la API directamente                                                                                                                                                                                                                           |
| D10 | Desconocido                     | `UNKNOWN` no equivale a `UNSUPPORTED`; se muestra el estado, pero no se ofrece una acción que podría mentir                                                                                                                                                                                               |
| D11 | Comandos POS                    | No se construye el catálogo genérico de reinicio/lock/mantenimiento en Android/iOS; la intención tipada de display es la única excepción inicial                                                                                                                                                          |
| D12 | Tier                            | Funcionalidad base desde FREE; no es `Feature`, `Module` ni upsell. **Ratificada por producto**                                                                                                                                                                                                           |
| D13 | Activación de producto          | Sin switch de venue porque no existen dos clientes que necesiten registros opuestos. **Ratificada por producto**                                                                                                                                                                                          |
| D14 | Estado e intención de inversión | `customerDisplayInverted` representa el último estado aplicado; una solicitud remota vive aparte y no se considera aplicada hasta el ACK del aparato                                                                                                                                                      |
| D15 | Retiro                          | Un POS no se borra por tener `activatedAt=null`; el retiro futuro es `status=RETIRED`, nunca eliminación histórica                                                                                                                                                                                        |
| D16 | Autoridad del display           | Un cambio local puede reportar estado; un cambio remoto usa `requestId` y compare-and-set para evitar ping-pong, ACK viejo y éxito optimista. Si el operador cambia localmente después de que Android journalizó la intención, el cambio físico local gana y la intención se rechaza con `LOCAL_OVERRIDE` |
| D17 | Inversión remota                | El botón del dashboard debe cambiar físicamente la pantalla de la D3; no es sólo diagnóstico ni una preferencia informativa. **Ratificada por producto 2026-08-30**                                                                                                                                       |

D12 no elimina permisos. "Es core" contesta si el venue puede usarlo; `tpv:read`, `tpv:update`, `tpv:command` y equivalentes siguen
contestando quién puede verlo o administrarlo.

---

## Modelo mental y vocabulario

```text
Terminal (identidad persistida)
  ├── type         = qué app/propósito tiene
  ├── formFactor   = qué forma física tiene
  ├── origin       = provisionada o auto-registrada
  ├── lifecycle    = si requiere activación y cuál es su estado
  ├── observed     = hechos tipados que reportó el hardware
  ├── intent       = solicitud remota server→dispositivo con estado/ACK
  └── capabilities = acciones efectivas que resuelve el server

Acción visible/ejecutable = capability(device) AND permission(staff)
```

| Término                      | Significado                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                       | Familia funcional. Nunca se deduce desde el tamaño de pantalla                                                                          |
| `formFactor`                 | Forma física. No concede acciones                                                                                                       |
| `customerDisplayPresent`     | La app encontró una salida válida para mostrar contenido al cliente, física o virtual del fabricante                                    |
| `customerDisplayInvertible`  | La app puede intercambiar de forma segura las superficies de cajero y cliente; implica más que presencia                                |
| `displayModeProtocolVersion` | Versión del protocolo de solicitud/ACK que implementa el cliente; no es la versión general de la app ni la versión CAS de una solicitud |
| `customerDisplayRequest`     | Estado server-owned de la última intención remota; no es una capacidad anunciada por el cliente                                         |
| `capabilities`               | DTO calculado y autoritativo que consumen dashboard y MCP                                                                               |
| `supportedRemoteCommands`    | Subconjunto de `TpvCommandType` que la app de ese dispositivo sí consume                                                                |
| `UNKNOWN`                    | Cliente viejo o dispositivo que aún no reportó; no es una afirmación de soporte ni de ausencia                                          |

---

## Persistencia: campos aditivos en `Terminal`, no un modelo de dispositivo nuevo

La primera versión tiene pocos hechos estables y necesitan filtros, tipos y migraciones legibles. Por eso las observaciones se guardan en
columnas explícitas, no en un `observedCapabilities Json` genérico:

```prisma
model Terminal {
  // ...campos existentes...
  customerDisplayPresent      Boolean?
  customerDisplayInvertible   Boolean?
  displayModeProtocolVersion  Int?
  capabilitiesObservedAt      DateTime?

  // Estado aplicado ya existente; NO es el valor deseado de una solicitud pendiente.
  customerDisplayInverted     Boolean @default(false)

  // Objeto server-owned de la última solicitud remota y su resultado.
  customerDisplayRequest      Json?
  customerDisplayRequestVersion Int      @default(0)
  customerDisplayRequestExpiresAt DateTime?

  @@index([customerDisplayRequestExpiresAt])
}
```

Los `Boolean?` conservan los tres estados necesarios: `true`, `false` y no reportado. `capabilitiesObservedAt` lo escribe el server, no el
reloj del aparato. `displayModeProtocolVersion=1` afirma que el cliente sabe recibir una solicitud, aplicar el modo y acusar su resultado;
no concede otras acciones remotas.

`customerDisplayRequest` sí es JSON porque representa un único agregado server-owned que cambia como máquina de estados y no se usa para
descubrir capacidades. Todo acceso pasa por un servicio y schemas estrictos:

```typescript
type CustomerDisplayRequest = {
  requestId: string
  desiredInverted: boolean
  status: 'PENDING' | 'APPLIED' | 'REJECTED' | 'SUPERSEDED' | 'CANCELLED' | 'EXPIRED'
  requestedAt: string
  requestedBy: string
  expiresAt: string
  resolvedAt?: string
  resultCode?:
    | 'DISPLAY_NOT_PRESENT'
    | 'DISPLAY_NOT_INVERTIBLE'
    | 'APPLY_FAILED'
    | 'LOCAL_OVERRIDE'
    | 'CANCEL_TOO_LATE'
    | 'ACK_AFTER_EXPIRY'
    | 'DEVICE_RETIRED'
}
```

Reglas de persistencia:

1. El reporte móvil se valida con Zod estricto y mensajes en español; claves desconocidas se rechazan.
2. `present=true, invertible=false` es válido; `invertible=true, present=false` se rechaza como contradictorio.
3. Un reporte reemplaza los tres hechos observados de manera atómica. La ausencia de reporte nunca escribe `false`.
4. Una solicitud nueva reemplaza a la anterior en la columna y registra `SUPERSEDED` para la anterior en `ActivityLog`; no hay dos deseos
   simultáneos compitiendo por el mismo dispositivo.
5. Todas las transiciones usan compare-and-set concreto sobre `customerDisplayRequestVersion`: leen la versión, ejecutan `updateMany` con
   `where: { id, customerDisplayRequestVersion: expected }`, reemplazan el JSON y hacen `increment: 1`. `count=0` obliga a recargar y
   revalidar; no basta un read/write dentro de una transacción `READ COMMITTED`. El CAS exitoso y su `ActivityLog` sí se escriben juntos en
   `prisma.$transaction`.
6. Un ACK sólo resuelve la solicitud cuyo `requestId` sigue vigente. Un ACK viejo recibe `409 DEVICE_REQUEST_SUPERSEDED` y no borra ni
   resuelve una solicitud más nueva; si informa que ya aplicó, sí actualiza el estado físico observado y deja intacto el deseo vigente.
7. `APPLIED` actualiza `customerDisplayInverted` con el valor realmente aplicado. `REJECTED` conserva el último estado aplicado.
8. Un cambio local sin `requestId` puede actualizar el estado aplicado, pero nunca simula un ACK. La precedencia se decide sin comparar
   relojes entre server y aparato:
   - si el cambio local ya estaba dirty **antes** de recibir/journalizar una solicitud remota nueva, la solicitud más nueva lo supera;
   - si el operador cambia localmente **después** de que la solicitud quedó journalizada/in-flight, el cambio físico local gana, Android
     conserva el dirty, acusa `REJECTED/LOCAL_OVERRIDE` con el valor físico actual y sólo lo marca sincronizado cuando el ACK termina.
     Android distingue ambos casos con una generación local monotónica persistida: el journal captura `localGenerationAtJournal` y la
     compara dentro de la misma sección sincronizada antes de aplicar/ACK; no usa timestamps de dos relojes distintos.
9. Toda solicitud vence a los **15 minutos**. `customerDisplayRequestExpiresAt` refleja el mismo valor del JSON y ambos cambian en el mismo
   CAS; permite barrer `PENDING` de forma indexada y marcar `EXPIRED`. Android no **empieza** a aplicar un payload vencido. Si aplicó antes
   de vencer pero su ACK llega tarde, el server actualiza el estado real como `APPLIED/ACK_AFTER_EXPIRY`.
10. El JSON nunca lo escribe directamente el cliente ni concede pagos, permisos, activación o comandos.
11. No hay backfill para las columnas nuevas: filas existentes empiezan con capacidad `UNKNOWN`, solicitud `null` y versión `0`. La
    corrección independiente de estados `INACTIVE` contaminados por el job de salud sí es obligatoria y se especifica más adelante.
12. La migración Prisma y la regeneración de `docs/SCHEMA_MAP.md` viajan con el cambio de schema.

| Estado vigente       | Evento                                   | Resultado                                                                              |
| -------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| vacío o estado final | nueva solicitud                          | `PENDING`; incrementa versión                                                          |
| `PENDING`            | solicitud nueva                          | nueva `PENDING`; la anterior queda `SUPERSEDED` en ActivityLog                         |
| `PENDING`            | ACK válido                               | `APPLIED` o `REJECTED`                                                                 |
| `PENDING`            | cambio local posterior a journal         | `REJECTED+LOCAL_OVERRIDE`; actualiza estado real al valor físico local                 |
| `PENDING`            | cancelar / TTL / retirar                 | `CANCELLED` / `EXPIRED` / `CANCELLED+DEVICE_RETIRED`                                   |
| `CANCELLED`          | ACK que demuestra aplicación previa      | `APPLIED+CANCEL_TOO_LATE`; actualiza estado real                                       |
| `EXPIRED`            | ACK de aplicación iniciada antes del TTL | `APPLIED+ACK_AFTER_EXPIRY`; actualiza estado real                                      |
| requestId anterior   | ACK tardío                               | actualiza sólo el estado físico reportado; no toca el request vigente y devuelve `409` |

No se reutilizan `systemInfo` ni `config`: el primero es telemetría general y el segundo preferencias. Tampoco se reutiliza
`TpvCommandQueue`: Android no consume esa cola hoy y convertir una acción acotada en un framework genérico ampliaría el rollout sin valor.

---

## Contrato efectivo del server

Un servicio puro y único —nombre propuesto `resolveDeviceCapabilities`— recibe el select mínimo de `Terminal` y devuelve:

```typescript
type CapabilityState = 'SUPPORTED' | 'UNSUPPORTED' | 'UNKNOWN'

interface EffectiveDeviceCapabilities {
  requiresActivation: boolean
  canManagePaymentConfiguration: boolean
  canAcceptTerminalPaymentRequests: boolean
  customerDisplay: {
    presence: CapabilityState
    invertibility: CapabilityState
    canRequestInversion: boolean
    observedAt: string | null
    stale: boolean
  }
  supportedRemoteCommands: TpvCommandType[]
}
```

El DTO de listas y detalle agrega el campo opcional `capabilities` y, en detalle, `customerDisplayRequest`; no elimina ni renombra campos
existentes. `canRequestInversion` es una comodidad calculada, no autorización: sólo vale `true` cuando la app implementa el protocolo, el
hardware es invertible y la observación está vigente. La ruta exige además `tpv:update`.

### Matriz inicial

| `TerminalType`     | Activación | Config. cobro                                                       | Solicitudes de pago a terminal | Display cliente / inversión                   | Comandos remotos                             |
| ------------------ | ---------- | ------------------------------------------------------------------- | ------------------------------ | --------------------------------------------- | -------------------------------------------- |
| `TPV_ANDROID`      | Sí         | Sí                                                                  | Sí                             | `UNSUPPORTED` en esta experiencia             | Allowlist del executor real de `avoqado-tpv` |
| `TPV_IOS`          | Sí         | Sí por contrato provisionado; verificar filas reales antes del plan | No hasta comprobar consumidor  | `UNSUPPORTED`                                 | Ninguno hasta que exista consumidor probado  |
| `POS_ANDROID`      | No         | No                                                                  | No por defecto                 | Presencia e inversión reportadas por separado | Sólo intención tipada de display en v1       |
| `POS_IOS`          | No         | No                                                                  | No                             | `UNSUPPORTED` en v1                           | Ninguno en v1                                |
| `POS_DESKTOP`      | No         | No                                                                  | No                             | `UNSUPPORTED` en v1                           | Ninguno en v1                                |
| `KDS`              | No         | No                                                                  | No                             | `UNSUPPORTED`                                 | Ninguno en v1                                |
| `PRINTER_*` legacy | No         | No                                                                  | No                             | `UNSUPPORTED`                                 | Ninguno                                      |

La allowlist de `TPV_ANDROID` se mantiene junto al resolver y se prueba contra el enum/modelo que consume `avoqado-tpv`. No se usa
`type.startsWith('TPV_')` para conceder comandos: `TPV_IOS` existe en el enum, pero no hay evidencia de un cliente que ejecute la cola.
`POS_IOS` puede originar una solicitud de pago/refund dirigida a otra TPV; la columna “Solicitudes de pago a terminal” describe qué aparato
las **acepta/ejecuta**, no quién puede solicitarlas. Ese flujo iOS → server → TPV Android permanece intacto.

### Reglas de resolución

- Lo derivable de la familia de app lo decide el server: activación, configuración de merchants/procesador y comandos.
- Lo dependiente del hardware instalado lo aporta el aparato: presencia actual de salida de cliente e invertibilidad real.
- `customerDisplayPresent=true` puede coexistir con `customerDisplayInvertible=false`, como en el display virtual de una Sunmi T3 Pro.
- Marca/modelo ayudan a nombrar y diagnosticar, nunca a conceder `canRequestInversion`.
- `formFactor=COUNTERTOP_POS` no implica pantalla secundaria.
- `displayModeProtocolVersion===1` es obligatorio para una intención remota; un APK que sólo sabe publicar su estado no la recibe. V1 valida
  exactamente `1`; una versión futura exige negociación explícita y no se activa por un `>=` accidental.
- Una observación tiene vigencia de **7 días**. Android la refresca al menos cada 24 horas mientras tenga sesión y conexión. Si expira,
  presencia/invertibilidad pasan a `UNKNOWN` para acciones, aunque el detalle conserva el último valor y su fecha como diagnóstico.
- `customerDisplayInverted=true` no demuestra capacidad: sólo registra el último estado que el dispositivo confirmó como aplicado.
- `canAcceptTerminalPaymentRequests` se deriva del canal de pagos realmente registrado/consumido, no de que la fila se llame `Terminal`.
  Dashboard y MCP no deben ofrecer cobro/reembolso en un POS sólo porque aparece en `list_devices`.

---

## Reporte Android de la segunda pantalla

### Endpoint nuevo y aditivo

```http
PUT /api/v1/mobile/venues/:venueId/device-capabilities
Authorization: Bearer <staff token>
X-Device-ID: <existing SyncOutbox.deviceId>
X-Device-Platform: ANDROID

{
  "customerDisplay": {
    "present": true,
    "invertible": false
  },
  "displayModeProtocolVersion": 1
}
```

El endpoint:

1. autentica y exige membresía del venue;
2. toma la identidad del header existente, nunca un `terminalId` arbitrario del body;
3. resuelve exactamente `[venueId, deviceUid]`;
4. si es el primer request autenticado, usa un helper compartido `ensureDeviceTerminal` para crear/enlazar la fila sin activación; ante el
   `P2002` de dos requests simultáneos vuelve a leer `[venueId, deviceUid]` en vez de asumir que la fila ya está disponible;
5. marca el request como atendido para que el hook pasivo de `res.finish` no vuelva a registrar el mismo heartbeat; este flag/refactor es
   trabajo nuevo, no una capacidad que hoy exponga `registerDevice.middleware.ts`;
6. sólo acepta estas observaciones para `POS_ANDROID` y valida la relación `invertible ⇒ present`;
7. guarda los campos tipados y el timestamp del server de forma atómica e idempotente;
8. acepta de nuevo un reporte idéntico y refresca `capabilitiesObservedAt`; eso confirma que la observación sigue vigente, pero no genera
   `ActivityLog`;
9. si no consigue establecer la identidad por un error transitorio, devuelve un código retryable y Android conserva el `pending`; nunca
   convierte el fallo de telemetría en fallo de login o venta.

Un token de venue A no puede reportar sobre un dispositivo de venue B. Tampoco se acepta `supportedRemoteCommands` desde el body: un cliente
modificado no puede autoconcederse acciones peligrosas.

### Fuente local de verdad

Android no contará displays a ciegas. Reutiliza `resolveDisplayRoles` y `chooseCustomerDisplayId`, que ya filtran AnyDesk/captura remota:

- `present = customerDisplayId != null`: existe una superficie válida para presentar contenido, incluida la virtual OEM de T3 Pro.
- `invertible = roles.invertible`: la superficie elegida es física/no-default y puede intercambiarse con la de cajero.

No se usa `Build.MANUFACTURER == SUNMI` ni `displays.size > 0`. Casos mínimos: D3 `true/true`, T3 Pro `true/false`, teléfono `false/false`,
display virtual remoto `false/false`.

`CustomerDisplayState` se extiende como única fuente observable del snapshot combinado. `CustomerDisplayManager.refresh()` publica el
snapshot sólo después de observar los roles reales; el coordinator lo consume y no crea un segundo `MutableStateFlow` ni reporta
`false/false` mientras el primer snapshot siga siendo `null`.

Eventos que recalculan el snapshot:

- arranque autenticado;
- `onDisplayAdded`;
- `onDisplayRemoved`;
- `onDisplayChanged` cuando cambie el resultado efectivo;
- cambio de venue con la misma Activity.
- refresco periódico al menos cada 24 horas mientras exista sesión autenticada, aunque no cambie el hardware.

### Comportamiento sin red

El reporte de capacidad **degrada y lo dice sólo donde importa**: nunca bloquea login, cobro, impresión ni pantalla del cliente. Es estado
derivado, no una mutación que el usuario haya solicitado, por lo que no entra al reducer de intents de órdenes.

Las cuatro respuestas obligatorias:

1. **¿Qué ve el usuario sin red?** El POS sigue funcionando igual. En el dashboard, que sí es online, queda visible la última observación y
   su fecha; si nunca hubo una, aparece "Capacidad sin confirmar" sin ofrecer el toggle.
2. **¿Se pierde algo si muere el proceso antes del PUT?** Android persiste el snapshot más reciente y una marca `pending` antes de intentar
   la red. Al reiniciar vuelve a enviarlo.
3. **¿En qué orden se reproduce?** No se conserva una cola de cada enchufe/desenchufe; sólo interesa el estado actual. Se usa trabajo único
   reemplazable. Si el hardware cambia durante un request, el `pending` sólo se limpia cuando el hash enviado coincide con el snapshot
   todavía vigente; de lo contrario se agenda otra pasada.
4. **¿Qué pasa al volver la red?** El último estado local reemplaza el snapshot observado de ese mismo dispositivo. Nunca se aplica a otra
   fila ni a otro venue. La ausencia de un header/reporte de un cliente viejo no borra lo conocido.

La persistencia local se identifica por `[venueId, deviceId]`. Un cambio de venue agenda un snapshot para la fila nueva y jamás reenvía el
pendiente del venue anterior usando las credenciales del actual. Volver al venue anterior vuelve a observar y reportar el hardware.

No se escribe `ActivityLog` por cada reporte: es telemetría derivada y potencialmente frecuente, igual que un heartbeat.

### Solicitudes remotas sin red

La intención de inversión sí es una mutación solicitada por una persona y tiene semántica distinta al reporte:

1. El dashboard crea `PENDING` y muestra **Solicitud pendiente**. Si Android está offline, el server conserva una sola intención vigente.
2. Android obtiene la intención en su GET de settings. Antes de aplicarla comprueba que el `requestId` no fue visto, que el display sigue
   presente/invertible y que el deseo difiere o necesita confirmación.
3. Android persiste localmente el `requestId` y resultado antes del ACK. Si muere después de aplicar, al reiniciar reenvía el mismo ACK; no
   vuelve a alternar el modo por tratar la orden como `toggle`.
4. El contrato siempre envía un **valor deseado** (`desiredInverted`), nunca “invierte lo que haya”, por lo que repetirlo es idempotente.
5. Si el hardware ya no es invertible, Android responde `REJECTED/DISPLAY_NOT_INVERTIBLE`, reporta las capacidades actuales y conserva el
   último estado aplicado.
6. Un request nuevo puede superar al viejo. Si el aparato aplicó el viejo tarde, su ACK recibe `409`; al sincronizar ve el deseo vigente y
   converge a él.
7. No se requiere que el dashboard permanezca abierto. Al volver, detalle y lista leen el estado `PENDING/APPLIED/REJECTED` del server.

Android serializa este mini-journal: si ya aplicó A, persiste y entrega el resultado de A (un `409` por superseded cuenta como recibido)
antes de empezar a aplicar B. Así un reintento viejo nunca llega después del ACK de un modo más nuevo y no hace retroceder
`customerDisplayInverted` en el server.

La intención no bloquea login, pedidos ni cobro. El trabajo de sincronización usa backoff y queda separado del outbox transaccional de
órdenes, pero su `requestId`/ACK sí se persiste porque fue una acción explícita del usuario.

---

## Validación autoritativa de acciones

Ocultar un botón no basta. Todas las entradas que terminan en una acción usan el mismo resolver antes de mutar o encolar.

### Comandos remotos

La creación de cola ya está centralizada en `command-queue.service.ts` y ya llama `validateCommandForTerminal`; no se crea otro pipeline. Se
extiende ese validador para recibir/selectar `type` y `supportedRemoteCommands`, de modo que cubra dashboard venue, dashboard org,
superadmin, rutas legacy y futuros callers.

- Comando soportado: conserva el flujo actual de cola, heartbeat y ACK.
- Dispositivo sin ese comando: no crea fila en la cola y devuelve `422 DEVICE_ACTION_UNSUPPORTED` con texto explícito.
- Bulk: encola sólo destinos compatibles y devuelve `queued` + `skipped[]` con `deviceId`, código y razón; nunca finge éxito total.
- Reintentar un comando histórico vuelve a validar la capacidad actual.
- Programaciones y geofences validan al crearse y otra vez al materializar el comando, porque la terminal pudo cambiar o retirarse entre
  ambos momentos.
- Ser superadmin no salta el límite técnico del aparato.

Una TPV desconectada puede conservar el comportamiento actual de **encolar para cuando vuelva**, porque sí tiene consumidor. Un POS sin
consumidor no puede usar "está offline" como explicación: se rechaza porque no soporta el comando.

### Inversión de pantalla: intención y ACK

Después de desplegar el dashboard nuevo y agotar la ventana de clientes web cacheados, el update general de terminal deja de aceptar
`customerDisplayInverted`; ese campo no forma parte de un PATCH genérico editable. La acción usa endpoints tipados:

```http
POST /api/v1/dashboard/venues/:venueId/terminals/:terminalId/display-mode-request
{ "desiredInverted": true }

DELETE /api/v1/dashboard/venues/:venueId/terminals/:terminalId/display-mode-request/:requestId

GET /api/v1/mobile/venues/:venueId/display-mode-request

200 OK
{
  "data": {
    "terminalId": "terminal-cuid",
    "request": null
  }
}

PATCH /api/v1/mobile/venues/:venueId/terminals/:terminalId/display-mode
{
  "customerDisplayInverted": true,
  "requestId": "uuid-opcional",
  "outcome": "APPLIED",
  "resultCode": null
}
```

La solicitud de dashboard verifica tenant, `tpv:update`, observación vigente, `capabilities.customerDisplay.canRequestInversion=true` y
`displayModeProtocolVersion===1`. Escribe `PENDING` y responde `202`; no cambia el estado aplicado. `UNSUPPORTED` devuelve
`422 DEVICE_ACTION_UNSUPPORTED`; `UNKNOWN` o stale devuelve `422 DEVICE_CAPABILITY_UNKNOWN` con una explicación accionable. La respuesta
incluye `expiresAt`; a los 15 minutos un job CAS la marca `EXPIRED` y nunca se vuelve a entregar.

**Cancelar solicitud pendiente es best-effort:** exige el mismo tenant/permiso y CAS sobre un request todavía `PENDING`, pero no revierte
algo que el aparato ya alcanzó a aplicar. Si llega después un ACK `APPLIED`, el server actualiza el estado real y cambia el resultado a
`APPLIED/CANCEL_TOO_LATE`; la UI explica que para revertir hay que crear una solicitud nueva con el valor contrario. Nunca se promete una
cancelación física retroactiva.

La ruta móvil cumple otra función: reporta el resultado del **propio aparato**. Exige membresía y que `terminalId` corresponda exactamente
al `X-Device-ID` autenticado, pero deliberadamente **no se bloquea por capacidad observada**. Eso permite el despliegue server-first y que
APKs viejos sigan publicando su estado antes de haber enviado el nuevo reporte. Un cliente no puede usarla para modificar otra terminal.

- Con `requestId`: resuelve por compare-and-set la intención vigente como `APPLIED` o `REJECTED` y registra el ACK con actor dispositivo.
- Sin `requestId`: registra un cambio local del modo y conserva cualquier intención remota pendiente; no genera un falso ACK.
- Con `requestId` y `REJECTED/LOCAL_OVERRIDE`: resuelve la intención y registra el valor físico elegido localmente después de que el request
  ya estaba in-flight.
- Con `requestId` viejo: registra el estado físico realmente reportado, preserva el request nuevo, devuelve `409 DEVICE_REQUEST_SUPERSEDED`
  y obliga a consultar el deseo vigente.
- Repetir el mismo ACK ya resuelto es idempotente y devuelve el mismo resultado.

La entrega usa únicamente el GET móvil ligero, resuelto desde `X-Device-ID` + venue autenticado. Su respuesta devuelve siempre el
`terminalId` exacto junto con la intención o `null`; así Android puede construir el PATCH de ACK tras reiniciar sin depender de
`TpvSettingsRepository` ni crear un ciclo Hilt entre settings y el coordinator:

```json
{
  "data": {
    "terminalId": "terminal-cuid",
    "request": {
      "requestId": "uuid",
      "desiredInverted": true,
      "requestedAt": "2026-08-29T18:00:00.000Z",
      "expiresAt": "2026-08-29T18:15:00.000Z"
    }
  }
}
```

Una solicitud resuelta/cancelada/expirada no se vuelve a entregar. Desconectar una pantalla no fuerza `customerDisplayInverted=false`:
reporta `present/invertible` actuales, y si había una solicitud pendiente Android la rechaza explícitamente en lugar de fingir que fue
aplicada.

### Cadencia y latencia de entrega

Un coordinador application-scoped —nombre propuesto `DeviceCapabilitySyncCoordinator`— corre sólo con sesión autenticada y proceso en
foreground:

- consulta el endpoint ligero cada **15 segundos con jitter**, además de hacerlo inmediatamente en login, cambio de venue, `onResume` y
  recuperación de red;
- suspende el poll en background/offline y usa backoff ante errores; una venta nunca espera este request;
- entrega la intención a una única sección crítica local y drena ACKs en orden antes de aplicar la siguiente para no aplicar dos veces ni
  hacer retroceder el estado confirmado;
- refresca el reporte de capacidades si han pasado 24 horas y también en eventos de topología de display;
- persiste request/ACK por `[venueId, deviceId, requestId]`, no de manera global en el aparato.

Objetivo verificable: con Android en foreground, sesión válida y red sana, **p95 menor o igual a 20 segundos** desde `202` del dashboard
hasta inicio de aplicación en el aparato. V1 usa polling deliberadamente simple; push/Socket.IO sólo se evaluará si las métricas de volumen
demuestran que el poll es costoso. El presupuesto se hace explícito: 15 segundos equivalen como máximo a 2,880 GET por dispositivo en una
jornada continua de 12 horas. Se observan volumen, latencia y errores por versión antes de ampliar el rollout; el poll nunca corre en
background ni bloquea una venta.

### Activación, creación y borrado

- `requiresActivation` se deriva del tipo/lifecycle, nunca de `activatedAt === null` por sí solo.
- **Solicitar/registrar TPV** conserva el wizard y crea sólo una TPV provisionada.
- Un POS auto-registrado nunca muestra Activar, Generar código ni Eliminar por falta de `activatedAt`.
- `tpv.dashboard.service.ts` ya rechaza borrar dispositivos auto-registrados o con historia; se reutiliza esa protección y se elimina la
  oferta incorrecta en UI, sin atribuirla como trabajo nuevo de backend.
- Cuando se diseñe el retiro de POS, será una acción explícita que cambia `status=RETIRED`, preservando órdenes, pagos y atribución.

`tpv-health.service.ts:checkOfflineTerminals()` tampoco puede usar `activatedAt=null` como selector de equipos a deshabilitar: hoy alcanza a
POS auto-registrados y puede escribir `INACTIVE`, que el dashboard traduce erróneamente como “deshabilitado por administrador”. En esta
entrega la regla se separa:

- conexión se calcula desde `lastHeartbeat` y se presenta como online/offline;
- activación sólo aplica cuando `requiresActivation=true`;
- el job de salud excluye sólo `POS_ANDROID`, `POS_IOS` y `POS_DESKTOP` mediante `type: { notIn: [...] }`; conserva exactamente el
  comportamiento legacy de TPV, KDS y periféricos existentes;
- `INACTIVE` administrativo nunca se infiere únicamente por silencio de red.

La migración incluye una reparación de datos acotada: filas `selfRegistered=true`, `type IN (POS_ANDROID, POS_IOS, POS_DESKTOP)`,
`activatedAt IS NULL` y `status=INACTIVE` vuelven a `ACTIVE`. Hoy no existe un flujo de producto que deshabilite administrativamente un POS;
ese estado sólo puede venir del job o de acceso interno genérico. La migración imprime/valida el conteo antes y después, preserva
`MAINTENANCE`/`RETIRED` y no toca TPVs provisionadas. Si en el futuro existe deshabilitación explícita de POS, necesitará causa y auditoría
propias para no confundirse otra vez con liveness.

Retirar un dispositivo cancela por CAS cualquier intención `PENDING` con `DEVICE_RETIRED`. Una reinstalación que genera otro `deviceUid`
crea otra fila y nunca recibe la intención de la anterior; la solicitud huérfana vence a los 15 minutos.

### Configuración de cobro

Asignar merchants, cambiar procesador o ejecutar acciones de afiliación sólo aparece y se acepta cuando
`canManagePaymentConfiguration=true`. Un `POS_ANDROID` puede correr en hardware Sunmi y aun así no ser una TPV de cobro Avoqado; marca y
forma física no cambian ese hecho.

### Solicitudes de pago/reembolso en aparato

`TerminalPaymentRequest` es un canal distinto de `TpvCommandQueue`, pero apunta al mismo inventario visible. Las herramientas MCP y callers
que permiten elegir un aparato validan `canAcceptTerminalPaymentRequests` antes de confirmar/crear una solicitud. En v1 se deriva únicamente
del tipo/canal TPV que realmente consume esas solicitudes; un POS auto-registrado no las acepta por compartir la tabla `Terminal`.

El servicio bajo nivel de pago/refund **no añade una lectura Prisma**: hoy trabaja con la identidad normalizada del `terminalRegistry`, que
puede ser serial y no `Terminal.id`, y ya falla si no hay socket o si el venue no coincide. El filtro nuevo vive en selección/DTO y en el
caller MCP, que resuelve por `id` o serial dentro del venue antes de mostrar confirmación. Esta regla no altera el cobro dentro del propio
POS Android ni aumenta la latencia del camino crítico de pagos.

---

## Dashboard: experiencia y compatibilidad de rutas

### Navegación canónica

Se agregan rutas de producto nuevas sin mover los endpoints:

| Canónica              | Compatibilidad                                  |
| --------------------- | ----------------------------------------------- |
| `/devices`            | `/tpv` redirige preservando query string        |
| `/devices/:deviceId`  | `/tpv/:tpvId` redirige al mismo id              |
| `/devices/orders/:id` | `/tpv/orders/:id` permanece como alias/redirect |

Las rutas de `orders` se declaran antes que `:deviceId`, como ya ocurre con `tpv`, para que `orders` no se capture como un id. Los
componentes no se duplican: ambos paths terminan en la misma pantalla durante la transición.

Las rutas canónicas y sus aliases viven dentro del mismo bloque actual de `PermissionProtectedRoute permission="tpv:read"` y
`KYCProtectedRoute`. El renombre nunca crea una entrada lateral que evite permiso o KYC; los tests cubren acceso denegado tanto en
`/devices` como en `/tpv`.

No se renombran endpoints del server. `dashboard` puede exponer tipos locales `Device`/`deviceId` adaptando la respuesta legacy, mientras
los servicios HTTP siguen llamando `/tpv` y usando `tpvId`. Si algún día se publica `/devices` en API, será alias aditivo con deprecación y
métricas, no requisito de esta entrega.

### Lista

Título y sidebar: **Dispositivos**. Cada renglón deja claro:

- propósito: TPV de cobro, POS, KDS o periférico legacy;
- plataforma y forma física;
- auto-registrado o provisionado;
- última conexión;
- activación sólo cuando aplica;
- capacidades relevantes con `SUPPORTED`, `UNSUPPORTED`, `Sin confirmar` o `Observación vencida`.

Los filtros de activación sólo incluyen equipos con `requiresActivation=true`; un POS deja de contaminar métricas de "sin activar". Los
filtros de origen y forma física existentes permanecen.

El botón genérico **Nuevo dispositivo** se reemplaza por **Solicitar/registrar TPV**, porque ésa es la única alta manual que realmente
ejecuta. Cerca de él, el copy explica: "Los POS con Avoqado aparecen automáticamente al iniciar sesión". No se añade un botón para crear
teléfonos o tablets a mano.

### Detalle y drawer de organización

La UI evalúa siempre:

```typescript
const visible = hasPermission(requiredPermission) && deviceSupports(action, capabilities)
```

- `supportedRemoteCommands` decide cada botón, no un booleano global.
- **Invertir pantalla** sólo aparece si `customerDisplay.canRequestInversion` es `true`.
- `UNKNOWN` se muestra en información/diagnóstico, pero no como control ejecutable.
- Merchants/procesador sólo aparecen en TPV de cobro.
- Activación sólo aparece para el lifecycle provisionado.
- `OrgTerminalDrawer` usa exactamente el mismo helper y no mantiene una segunda matriz local.

La ausencia por incompatibilidad técnica no necesita un teaser de paywall. En el detalle sí se explica el estado (por ejemplo, "Este POS no
admite comandos remotos desde Avoqado"), para que no parezca un problema de permisos.

La inversión no usa optimismo visual:

- al aceptar el server: **Solicitud pendiente**, conserva visible el estado aplicado anterior y deshabilita un segundo click idéntico;
- `APPLIED`: mueve el toggle al valor confirmado y muestra quién lo solicitó/cuándo lo confirmó el aparato;
- `REJECTED`: conserva el valor aplicado y explica `DISPLAY_NOT_PRESENT`, `DISPLAY_NOT_INVERTIBLE` o fallo de aplicación;
- una solicitud contraria mientras hay otra pendiente la supera de forma explícita; la UI no simula dos comandos en cola.

El detalle puede actualizarse por polling/invalidación de query al inicio; tiempo real no es requisito de v1. Lista y drawer consumen el
mismo estado, no mantienen una copia local del deseo.

### Permisos

La primera versión conserva `tpv:read`, `tpv:update`, `tpv:command`, `tpv:create`, etc. Renombrarlos a `devices:*` ahora obligaría a migrar
overrides persistidos en `VenueRolePermission` y a coordinar varios clientes sin mejorar la experiencia visible.

Si se hace después, requiere alias bidireccional en `PERMISSION_DEPENDENCIES`, actualización sincronizada de clientes, migración de datos y
auditoría `npm run audit:permissions`. No forma parte de este cambio.

---

## Impacto por repo en la primera entrega

### `avoqado-server` — sí

- migración aditiva de los campos tipados de observación + intención y regeneración de schema map;
- schema Zod y endpoint móvil de reporte;
- `resolveDeviceCapabilities` y tests de matriz;
- `capabilities` aditivo en listas/detalles venue y organización;
- extender el validador central de comandos existente;
- endpoint de solicitud remota + ACK idempotente/compare-and-set de display;
- endurecer la ruta móvil para que `terminalId` coincida con el `X-Device-ID` del request, no sólo con el venue;
- conservar temporalmente el campo legacy del PUT general y medir su uso; retirarlo/rechazarlo sólo después del dashboard nuevo;
- corregir liveness/activación para que el job offline no deshabilite POS auto-registrados;
- conservar las protecciones de borrado legacy ya existentes;
- respuestas estables y accionables para acción no soportada/capacidad desconocida;
- `src/mcp/tools/terminals.ts:list_devices` con el mismo DTO efectivo.

### `avoqado-web-dashboard` — sí

- consumir el contrato efectivo;
- retirar inferencias por `activatedAt`, marca o estado genérico;
- aplicar capacidad + permiso en lista, detalle y drawer de organización;
- representar `PENDING/APPLIED/REJECTED` sin éxito optimista;
- rutas canónicas `/devices` con aliases `/tpv`;
- copy, traducciones y analítica de navegación renombradas;
- mantener los servicios HTTP legacy en esta fase.

### `avoqado-android` — sí, acotado

- reportar por separado `present` e `invertible` desde la lógica existente;
- persistir el último snapshot/pending;
- reportarlo al endpoint en arranque, reconexión y cambios de display;
- adoptar una intención remota por valor deseado, persistir `requestId` y confirmar `APPLIED/REJECTED` de forma idempotente;
- cambiar `DisplayModeSync` para que una intención vigente sea autoridad remota explícita, sin convertir el GET normal en “server siempre
  gana”;
- actualizar el comentario y el test P1 que aún afirman “un valor por negocio”, cubriendo por separado diferencia libre vs intención tipada;
- no cambiar login, auto-registro, activación ni flujo de venta;
- no implementar la cola genérica de reinicio/lock/mantenimiento.

### `avoqado-tpv` — no en la primera entrega

El consumidor de comandos ya existe y el server deriva capacidades desde `TPV_ANDROID`. Tocar el APK sólo para repetir esa información
añadiría costo de rollout y podría romper versiones antiguas. Una fase futura puede hacer que anuncie versión/capacidades si aparece una
diferencia real entre modelos o versiones que el server no pueda derivar.

### `avoqado-ios` — no en la primera entrega

El auto-registro ya funciona. El server resuelve sin comandos y sin display de cliente para `POS_IOS`; no hace falta que iOS anuncie
`false`. Si se implementa salida externa o una acción nativa real, iOS entra con su propia observación versionada.

### Presentación comercial

Antes de cerrar la implementación se busca "Terminales", "TPV" y administración de dispositivos en los cuatro HTML canónicos de
`Avoqado-HQ/operations/marketing/platform-presentation/`. **Sólo** si la búsqueda encuentra una afirmación afectada se actualizan los HTML
correspondientes y se regeneran sus cuatro PDF. La variante sin NexGo se mantiene en sync cuando cambie el deck base. Si no hay una promesa
relevante, se registra el resultado y no se toca el repo comercial —especialmente si contiene WIP ajeno.

---

## Compatibilidad y orden de despliegue

```text
1. Server aditivo
   └── acepta reportes/ACK opcionales + devuelve capabilities + endpoint de intención; conserva el PUT legacy sin cambios

2. Android
   └── reporta presencia/invertibilidad, consume intención v1 y confirma; TPV/iOS/APKs viejos siguen funcionando

3. Verificación en hardware
   └── Sunmi dual=true, Android simple=false, display remoto filtrado

4. Dashboard capability-aware
   └── habilita solicitud remota sólo para clientes v1; después copy y rutas /devices

5. Deprecación segura y limpieza gradual
   └── tras al menos 7 días y métrica legacy en cero, rechazar customerDisplayInverted en PUT general; medir aliases /tpv
```

### Por qué este orden es seguro

- El server sale primero y todos los campos nuevos son opcionales/aditivos.
- Clientes viejos ignoran `capabilities` y continúan auto-registrándose.
- La ruta móvil de estado no exige haber reportado capacidad, así que un APK existente no se rompe durante el rollout server-first.
- TPVs viejas conservan comandos porque su capacidad se deriva del tipo, no de un reporte nuevo.
- Android se despliega y se verifica antes de que el dashboard pueda crear intenciones; `displayModeProtocolVersion` evita enviar una a un
  APK que sólo publica estado.
- El server inicial conserva exactamente la semántica del PUT general que consume el dashboard viejo. No se retira el campo en el paso 1.
- Tras desplegar dashboard, se instrumenta el uso del campo legacy. Sólo después de siete días y cero llamadas se cambia a
  `422 LEGACY_DISPLAY_MODE_ENDPOINT`; así una pestaña JS cacheada recibe error explícito y nunca un `200` no-op.
- El renombre visible sale al final; para entonces la lógica ya está correcta bajo ambos nombres.
- No hace falta feature flag: el rollout se controla por compatibilidad del contrato y orden de deploy, no por una bifurcación permanente de
  producto.

### Rollback

- Revertir dashboard devuelve el copy/rutas viejas e impide crear nuevas solicitudes; el server sigue bloqueando comandos imposibles y las
  solicitudes pendientes existentes siguen siendo consumibles o cancelables por endpoint.
- Revertir Android deja la última observación hasta que venza; no la convierte en `false`. Antes del rollback se cancelan solicitudes
  pendientes si esa versión dejará de consumirlas.
- Revertir el uso del DTO no exige revertir la migración: los campos nullable/JSON pueden permanecer sin lectores.
- La eliminación física de columnas se posterga a una migración separada y sólo si se abandona el diseño; nunca forma parte de un rollback
  urgente.

---

## Errores y estados de UI

| Situación                               | Server                                                        | Dashboard                                                     |
| --------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| POS Android viejo, sin reporte          | presencia/inversión `UNKNOWN`                                 | "Capacidad sin confirmar"; sin toggle                         |
| Reporte con más de 7 días               | capacidad efectiva `UNKNOWN`, conserva diagnóstico            | "Observación vencida; abre el POS con conexión"; sin toggle   |
| Android simple `false/false`            | presencia e inversión `UNSUPPORTED`                           | "Sin pantalla secundaria"; sin toggle                         |
| T3 Pro `true/false`                     | display presente, inversión `UNSUPPORTED`                     | Customer display visible; sin acción de invertir              |
| D3 físico `true/true`, intent v1        | `canRequestInversion=true`                                    | Muestra acción si además tiene `tpv:update`                   |
| Dashboard solicita inversión            | `202`, request `PENDING`; actual sin cambio                   | "Solicitud pendiente", no “Aplicado”                          |
| Android confirma                        | request `APPLIED`; actual cambia                              | Toggle confirmado y hora de ACK                               |
| Hardware cambia antes de aplicar        | request `REJECTED`; actual sin cambio                         | Explicación específica y capacidad refrescada                 |
| Aparato no vuelve en 15 minutos         | request `EXPIRED`; no se entrega                              | “La solicitud venció”; permite enviar otra                    |
| Cancelación llegó después de aplicar    | actual cambia; `APPLIED/CANCEL_TOO_LATE`                      | Explica que cancelar no revirtió y ofrece solicitud contraria |
| ACK de solicitud superada               | `409 DEVICE_REQUEST_SUPERSEDED`                               | Mantiene el deseo vigente; Android resincroniza               |
| Intento directo de invertir sin soporte | `422 DEVICE_ACTION_UNSUPPORTED`                               | Mensaje específico, nunca éxito optimista                     |
| Intento de comando en POS               | No crea cola; `422 DEVICE_ACTION_UNSUPPORTED`                 | Acción ausente; si había UI vieja, muestra explicación        |
| TPV soportada desconectada              | Cola normal existente                                         | "Se enviará al conectarse"                                    |
| Bulk mezcla TPV y POS                   | Encola TPV, reporta POS en `skipped[]`                        | Resumen parcial explícito                                     |
| Display se desconecta estando invertido | Conserva último estado aplicado, reporta `present/invertible` | Control oculto; explica última observación                    |
| Reporte falla por red                   | No afecta request de negocio                                  | POS sigue; reintento silencioso del snapshot                  |

---

## Seguridad, tenancy y auditoría

- Cada lectura/escritura de capacidad filtra por `venueId` u `orgId`.
- El reporte móvil sólo puede actualizar el `deviceUid` del propio request dentro del venue autenticado.
- El body no acepta terminal id, permisos, comandos, merchant ids ni flags de activación.
- Los campos observados son evidencia no confiable y limitada a hardware; las capacidades peligrosas se derivan en server.
- Las acciones siguen usando su permiso exacto. Capacidad no concede acceso y permiso no inventa soporte técnico.
- La validación central también cubre superadmin y bulk; no hay bypass por usar otra ruta.
- Reportes/heartbeats no generan `ActivityLog` por volumen. La solicitud remota registra al staff que la creó; el ACK registra
  `staffId=null`, `source=DEVICE_ACK`, `deviceUid`, `requestId`, resultado, `requestedAt`, `resolvedAt` y `latencyMs`. Un cambio local usa
  `source=DEVICE_LOCAL` y sólo atribuye al staff autenticado esa acción local real. Así la sincronización no fabrica una cadena de cambios
  del cajero.
- Crear/superar/cancelar una solicitud y su resolución se audita; el historial no depende de conservar para siempre el JSON de la última
  solicitud en `Terminal`.
- El `PUT` dashboard legacy registra `LEGACY_DISPLAY_MODE_UPDATE_USED` desde la primera fase aditiva, sin alterar su respuesta y sin PII. Un
  reporte read-only agrega `DISPLAY_MODE_REQUESTED`, `DISPLAY_MODE_RESOLVED`, `DISPLAY_MODE_EXPIRED` y ese evento legacy para calcular
  cobertura, tasa de ACK, p95 y tendencia de expirados antes del cutoff.
- Los mensajes de error al usuario están en español y no exponen Prisma, nombres de tablas ni detalles internos en el MCP.

---

## Verificación requerida durante la implementación

### Server

1. Tabla completa del resolver por `TerminalType`.
2. `POS_ANDROID` sin reporte o stale ⇒ `UNKNOWN`; `true/false` separa presencia de invertibilidad.
3. Un cliente no puede reportar `supportedRemoteCommands` ni cambiar otro `deviceUid`/venue.
4. Primer reporte puede auto-registrar sin activación; dos requests concurrentes que chocan en el unique re-leen la misma fila.
5. Clientes sin headers conservan respuestas/flujo actuales y el hook no duplica un reporte ya atendido.
6. `queueCommand` permite los comandos actuales de `TPV_ANDROID` y rechaza POS/iOS/KDS/periféricos sin crear cola.
7. Bulk devuelve parciales correctos sin fingir éxito.
8. Crear intención exige capability vigente + permiso, responde `202/PENDING` y no cambia el estado aplicado.
9. ACK coincidente aplica/rechaza; ACK repetido es idempotente; ACK superado no pisa el request nuevo.
10. Carreras reales con `Promise.all` (crear/crear, crear/ACK, cancelar/ACK) sólo permiten una transición CAS por versión; los perdedores
    recargan o reciben el código estable correspondiente.
11. El PATCH móvil self-device funciona para APK viejo aún en `UNKNOWN`; la ruta de dashboard sí se capability-gatea.
12. Cambio local sin `requestId` actualiza actual y no simula ACK; si ocurre después de journalizar un request, el ACK lo resuelve como
    `REJECTED/LOCAL_OVERRIDE`; si era dirty antes, la intención posterior lo supera.
13. Una intención expirada no se entrega/aplica y pasa a `EXPIRED`; una nueva puede reemplazarla.
14. `RETIRED` cancela pendientes y un `deviceUid` nuevo no recibe requests de la fila anterior.
15. Activación/métricas/borrado no tratan a un POS como TPV por `activatedAt=null`.
16. El job offline no pone `INACTIVE` a `POS_*`; TPV, KDS y periféricos conservan su comportamiento legacy; la migración repara filas ya
    contaminadas y verifica conteos.
17. Durante pasos 1–4 el PUT general conserva su contrato; en paso 5 el campo legacy devuelve 422 y nunca 200 sin escritura.
18. Listas, detalle, organización y `list_devices` devuelven la misma resolución, incluida capacidad de pagos terminales.
19. Regresión: heartbeat/ACK de PAX y NexGo siguen entregando sus comandos.

### Dashboard

1. Matriz de acción por capacidad y permiso: ambos son obligatorios.
2. Activación y CTA manual sólo para TPV.
3. Inversión sólo con `canRequestInversion=true` y observación vigente.
4. Cada comando se filtra por `supportedRemoteCommands` en lista, detalle y org drawer.
5. `/devices`, detalle y pedido abren directo; cada URL `/tpv` redirige preservando id, search y hash.
6. Métricas/filtros de activación excluyen POS.
7. Copy explica que POS aparece al iniciar sesión.
8. Cliente viejo/estado `UNKNOWN` es visible y explicable, no un botón muerto.
9. Solicitud aceptada muestra `PENDING`; sólo un ACK `APPLIED` mueve el estado confirmado.
10. `REJECTED`, stale y T3 Pro presente/no invertible tienen copy distinto y accionable.
11. `EXPIRED` permite reenviar; `CANCEL_TOO_LATE` explica que cancelar no revirtió y ofrece mandar el valor contrario.

### Android

1. La observación usa el resolver real: D3 `true/true`, T3 Pro OEM `true/false`, captura/remoto `false/false`.
2. Arranque, hot-plug y refresco de 24 horas actualizan el reporte.
3. Estado persistido antes de red; muerte del proceso no lo pierde.
4. Trabajo único conserva la observación más reciente si cambia durante un PUT.
5. 401/403 no entra en loop agresivo; espera auth/membresía válida. Errores de red reintentan con backoff.
6. Ningún error de reporte afecta pedidos, efectivo, impresión o customer display local.
7. Sin intención, el modo local sigue siendo autoridad y se reporta; una diferencia legacy del server no lo voltea.
8. Con intención v1, Android adopta el valor deseado, persiste `requestId` antes del ACK y no ejecuta dos veces un toggle.
9. Si aplicar falla o deja de ser invertible, confirma `REJECTED` y conserva el estado actual.
10. Un request superado hace fetch del vigente y converge; no entra en ping-pong.
11. El coordinador inicia/para con sesión + foreground, dispara en `onResume`/reconexión y usa jitter/backoff sin paralelizar polls.
12. Un payload vencido nunca se aplica y el dedupe se separa por `[venueId, deviceId, requestId]`.
13. Tras process death, un resultado A persistido se entrega/terminaliza antes de aplicar B; el ACK viejo no llega después del nuevo.
14. `applyRemoteIntent` es sincronizado; un cambio físico local posterior al journal conserva dirty, rechaza con `LOCAL_OVERRIDE` y no se
    borra silenciosamente por el ACK remoto.

### QA en aparatos reales

1. Sunmi D3 con display físico: `present/invertible=true`, dashboard crea intención, Android invierte y confirma.
2. Sunmi T3 Pro con display virtual OEM: `present=true/invertible=false`, contenido cliente funciona pero invertir no aparece.
3. Android teléfono/tablet de una pantalla: `false/false`, no aparece la acción.
4. AnyDesk/screen-cast sin pantalla física: no produce falso `present` ni `invertible`.
5. Desconectar antes de consumir una intención la rechaza; reconectar refresca capacidad sin alterar ventas.
6. Con la app ya abierta y sin reiniciar, 100 solicitudes automatizadas/debidamente registradas cumplen p95 ≤20 s desde 202 hasta inicio de
   aplicación y dejan evidencia de volumen de polling, errores y ACK.
7. Solicitar offline, matar/reabrir app y reconectar antes de 15 min: aplica una vez, confirma el mismo `requestId` y no bloquea venta.
8. Si nunca empezó a aplicar, reconectar después de 15 min muestra `EXPIRED` y no voltea físicamente hasta una solicitud nueva; un ACK
   atrasado de una aplicación iniciada antes del TTL actualiza la verdad como `ACK_AFTER_EXPIRY`.
9. Dos solicitudes contrarias rápidas: el resultado final coincide con la más nueva y el ACK viejo no la borra.
10. Cancelar durante aplicación: si llegó tarde, el estado real se actualiza y UI explica `CANCEL_TOO_LATE`.
11. Retirar/reinstalar: no entrega una intención a otra fila/deviceUid.
12. PAX/NexGo: reinicio, mantenimiento y lock siguen visibles/ejecutables con ACK esperado.
13. POS Android y iOS: reinicio/lock/mantenimiento no aparecen ni se encolan.
14. APK Android anterior: sigue entrando, publicando su estado legacy y operando; queda sin intención remota hasta actualizar, sin
    activación.

Las verificaciones pesadas se ejecutan mediante `./scripts/avq-verify.sh` según las reglas del workspace. La prueba offline y de pantalla
doble no se declara aprobada sólo con unit tests: requiere hardware real.

---

## Criterios de aceptación

El cambio se considera terminado cuando:

1. un POS nuevo se auto-registra exactamente como hoy, sin alta ni activación;
2. existe una sola fila `Terminal` por `[venueId, deviceUid]` y no hay modelo `Device` paralelo;
3. `/devices/:deviceId` muestra propósito, forma física, origen y capacidad efectiva;
4. un usuario sólo ve y ejecuta acciones que cumplen capacidad **y** permiso;
5. el server impide encolar comandos para clientes que no los consumen;
6. sólo un Android con presencia, invertibilidad, `displayModeProtocolVersion===1` y observación vigente obtiene `canRequestInversion=true`;
7. un display presente pero no invertible puede mostrar contenido de cliente sin recibir la acción de invertir;
8. dashboard crea una intención pendiente y sólo el ACK del aparato cambia el estado aplicado; con app foreground/red sana se inicia en p95
   ≤20 segundos;
9. request/ACK son idempotentes, sobreviven offline dentro de su TTL, expiran a los 15 minutos y un ACK viejo no pisa un deseo nuevo;
10. marca/modelo/form factor nunca sustituyen la observación de display;
11. clientes viejos siguen funcionando y `UNKNOWN` no se convierte en activación pendiente;
12. POS offline no se marca como deshabilitado por administrador y las filas ya contaminadas quedan reparadas;
13. `/tpv` y endpoints existentes siguen siendo compatibles;
14. `list_devices` y dashboard no discrepan, incluidas acciones de cobro/reembolso;
15. la prueba real dual físico, virtual OEM, simple, remoto y offline está documentada;
16. el renombre visible no obligó a renombrar tabla, endpoints ni permisos;
17. el gate de cutoff se obtiene de un reporte reproducible: cero uso legacy por 7 días, cobertura Android ≥95%, tasa/latencia de ACK
    visible y sin crecimiento sostenido de expirados.

---

## Fases posteriores explícitamente fuera de esta entrega

- Comandos remotos de POS Android/iOS, sólo si aparece una necesidad que el portal OEM no resuelva.
- Anuncio de capacidades por `avoqado-tpv` para diferencias reales entre versiones/modelos.
- Customer display en iOS o desktop.
- Retiro/autoservicio completo de POS con su UX y políticas de reasignación.
- Migración de permisos `tpv:*` a `devices:*`.
- Alias públicos de API `/devices` y deprecación formal de `/tpv`.
- Limpieza/migración de filas `TerminalType.PRINTER_*` a modelos especializados.
- Inventario de periféricos que no ejecutan Avoqado.

Esas fases reutilizan el resolver y las observaciones tipadas; ninguna justifica ampliar el alcance inicial ni retrasar la corrección de las
acciones engañosas de hoy.
