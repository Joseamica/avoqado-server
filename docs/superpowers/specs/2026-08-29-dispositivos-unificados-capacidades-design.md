# Dispositivos unificados: una identidad, capacidades reales y acciones honestas

**Fecha:** 2026-08-29 · **Estado:** diseño para aprobación; no implementar antes de convertirlo en plan escrito

**Repos y superficies involucradas:**

| Alias | Ruta / superficie | Papel en el cambio inicial |
| --- | --- | --- |
| `server` | `avoqado-server/` | Fuente de verdad de identidad, capacidades efectivas y validación de acciones |
| `dashboard` | `avoqado-web-dashboard/` | Renombre visible a Dispositivos y controles condicionados por capacidad + permiso |
| `android` | `avoqado-android/` | Reporta únicamente el hecho de hardware que sólo el aparato conoce: segunda pantalla disponible |
| `tpv` | `avoqado-tpv/` | Sin cambio inicial; el server deriva sus comandos existentes por el tipo de app |
| `ios` | `avoqado-ios/` | Sin cambio inicial; conserva el auto-registro y no anuncia capacidades que aún no implementa |
| `customer MCP` | `server/src/mcp/` | `list_devices` expone el mismo contrato efectivo que el dashboard |

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
autenticado con headers `X-Device-*`. La fila nace `ACTIVE` y `selfRegistered=true`; no pide activación. Ese flujo es correcto y se conserva.

### El problema está en las acciones, no en la identidad

El dashboard ya mezcla estos dispositivos en `src/pages/Tpv/Tpvs.tsx`, pero decide acciones con señales que no significan capacidad:

- `activatedAt === null` hace aparecer acciones de alta/borrado también en POS auto-registrados.
- mantenimiento y reinicio aparecen para cualquier renglón si el usuario tiene `tpv:command`.
- `customerDisplayInverted` aparece en el detalle sin comprobar que exista segunda pantalla.
- `OrgTerminalDrawer.tsx` ofrece reinicio, sincronización, bloqueo y mantenimiento sin distinguir el cliente que consume el comando.

El server también permite encolar comandos por varias entradas (`tpvCommandExecutionService`, `orgTerminalsService`, superadmin y rutas
legacy) sin una validación única de familia/capacidad. El resultado engañoso es un comando marcado como enviado o encolado para una app que
nunca lo va a leer.

### La capacidad real ya está implementada en un solo cliente

- `avoqado-tpv` recibe y ejecuta comandos desde el heartbeat mediante `CommandExecutor`; no necesita anunciar esa capacidad en la primera
  versión porque el server la puede derivar de `TPV_ANDROID` sin romper APKs viejas.
- `avoqado-android` no consume `TpvCommandQueue`. Sí implementa pantalla de cliente con la API estándar de Android
  (`DisplayManager + Presentation`) en `CustomerDisplayManager.kt`, filtra displays virtuales/remotos y reacciona a conexión/desconexión.
  Ese cliente es quien puede observar si la inversión es realmente posible.
- `avoqado-ios` manda identidad y `formFactor`, pero no tiene comandos remotos ni la experiencia de pantalla de cliente de Android.

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

| Alternativa | Ventaja | Costo/riesgo | Veredicto |
| --- | --- | --- | --- |
| Crear un modelo `Device` y migrar `Terminal` | Nombre técnico limpio desde el inicio | Duplica o mueve relaciones de órdenes, pagos, salud, comandos y merchants; exige backfill y coordinación cross-repo | Descartada |
| Mantener Terminales y abrir otra sección Dispositivos | Cambio inicial pequeño | Un mismo aparato puede aparecer dos veces y cada pantalla acaba con reglas/acciones distintas | Descartada |
| Renombrar DB, API, permisos y UI a `Device` en una sola entrega | Consistencia nominal total | Rompe contratos, overrides de permisos, bookmarks y clientes con versiones desfasadas; rollback difícil | Descartada |
| Renombrar sólo el producto y añadir capacidades sobre `Terminal` | Resuelve la confusión visible y técnica con cambios aditivos | Conviven nombres legacy internos durante un tiempo | **Elegida** |

La convivencia interna es deliberada, no deuda accidental: se podrá retirar cada alias cuando las métricas demuestren que ya no tiene
consumidores. El usuario obtiene el concepto correcto sin pagar el riesgo de un big bang.

---

## Decisiones cerradas

| # | Decisión | Elección |
| --- | --- | --- |
| D1 | Fuente de verdad de identidad | Una sola fila `Terminal` por aparato/venue; no hay modelo `Device` nuevo |
| D2 | Nombre visible | **Dispositivos** en dashboard, navegación, títulos y copy |
| D3 | Nombre técnico | `Terminal`, `/tpv`, `/terminals` y `tpv:*` permanecen inicialmente por compatibilidad |
| D4 | Alta de POS | Auto-registro actual; sin creación manual ni activación |
| D5 | Alta de TPV de cobro | Conserva compra/provisionamiento + activación existentes |
| D6 | Capacidad | Contrato efectivo calculado por server; no una lista confiada ciegamente al cliente |
| D7 | Hechos de hardware | El cliente reporta sólo lo que el server no puede saber, empezando por segunda pantalla Android |
| D8 | Autorización | Una acción requiere **capacidad AND permiso**; ninguna sustituye a la otra |
| D9 | Seguridad | El backend rechaza acciones no soportadas aunque se invoque la API directamente |
| D10 | Desconocido | `UNKNOWN` no equivale a `UNSUPPORTED`; se muestra el estado, pero no se ofrece una acción que podría mentir |
| D11 | Comandos POS | No se construyen en Android/iOS en esta fase |
| D12 | Tier | Funcionalidad base disponible desde FREE; no es `Feature`, `Module` ni upsell |
| D13 | Activación de producto | Sin switch de venue: no existen dos clientes que necesiten registros de dispositivos opuestos |
| D14 | Preferencia de inversión | `customerDisplayInverted` se conserva aunque la pantalla se desconecte; no se borra una preferencia por un estado temporal |
| D15 | Retiro | Un POS no se borra por tener `activatedAt=null`; el retiro futuro es `status=RETIRED`, nunca eliminación histórica |

La D12 no elimina permisos. "Es core" contesta si el venue puede usarlo; `tpv:read`, `tpv:update`, `tpv:command` y equivalentes siguen
contestando quién puede verlo o administrarlo.

---

## Modelo mental y vocabulario

```text
Terminal (identidad persistida)
  ├── type         = qué app/propósito tiene
  ├── formFactor   = qué forma física tiene
  ├── origin       = provisionada o auto-registrada
  ├── lifecycle    = si requiere activación y cuál es su estado
  ├── observed     = hechos que reportó el hardware
  └── capabilities = acciones efectivas que resuelve el server

Acción visible/ejecutable = capability(device) AND permission(staff)
```

| Término | Significado |
| --- | --- |
| `type` | Familia funcional. Nunca se deduce desde el tamaño de pantalla |
| `formFactor` | Forma física. No concede acciones |
| `observedCapabilities` | Snapshot de hechos reportados por el aparato y validado por el server |
| `capabilities` | DTO calculado y autoritativo que consumen dashboard y MCP |
| `supportedRemoteCommands` | Subconjunto de `TpvCommandType` que la app de ese dispositivo sí consume |
| `UNKNOWN` | Cliente viejo o dispositivo que aún no reportó; no es una afirmación de soporte ni de ausencia |

---

## Persistencia: dos campos aditivos en `Terminal`, no un modelo nuevo

El schema sí necesita guardar el hecho observado para que el dashboard pueda consultarlo aunque el dispositivo no esté conectado en ese
instante. El cambio propuesto es pequeño, nullable y sin backfill obligatorio:

```prisma
model Terminal {
  // ...campos existentes...
  observedCapabilities Json?
  capabilitiesObservedAt DateTime?
}
```

`observedCapabilities` guarda un snapshot versionado y validado, no JSON libre. Versión 1:

```json
{
  "schemaVersion": 1,
  "customerDisplay": {
    "available": true
  }
}
```

Reglas:

1. El body se valida con un schema Zod estricto y mensajes en español; una clave desconocida se rechaza para que un typo no parezca un
   reporte exitoso que el server ignoró.
2. `capabilitiesObservedAt` lo escribe el server. No se confía en el reloj del aparato.
3. Un reporte nuevo reemplaza el snapshot observado completo de esa versión; no hace merges de claves viejas que el cliente ya retiró.
4. La ausencia de reporte no escribe `false`. Un cliente viejo deja el estado en `UNKNOWN`.
5. Este JSON nunca concede pagos, permisos, activación ni comandos. Sólo aporta hechos permitidos por una allowlist del server.
6. No se indexa en v1: la lista ya lee cada `Terminal` y no existe una consulta operativa que filtre millones de snapshots por JSON.
7. Cualquier edición futura de `schema.prisma` debe llevar migración Prisma y regeneración de `docs/SCHEMA_MAP.md` en el mismo commit.

Se descarta reutilizar `systemInfo` o `config`: el primero describe salud/telemetría y el segundo preferencias. Mezclar ahí una capacidad
haría imposible distinguir "el aparato puede" de "el venue configuró".

---

## Contrato efectivo del server

Un servicio puro y único —nombre propuesto `resolveDeviceCapabilities`— recibe el select mínimo de `Terminal` y devuelve:

```typescript
type CapabilityState = 'SUPPORTED' | 'UNSUPPORTED' | 'UNKNOWN'

interface EffectiveDeviceCapabilities {
  requiresActivation: boolean
  canManagePaymentConfiguration: boolean
  customerDisplay: {
    state: CapabilityState
    canInvert: boolean
    observedAt: string | null
  }
  supportedRemoteCommands: TpvCommandType[]
}
```

El DTO de listas y detalle agrega el campo opcional `capabilities`; no elimina ni renombra campos existentes. `canInvert` es una comodidad
calculada, no una autorización: vale `true` sólo cuando la familia de app implementa la experiencia y el hardware observado está
`SUPPORTED`.

### Matriz inicial

| `TerminalType` | Requiere activación | Configuración de cobro | Pantalla de cliente | Comandos remotos |
| --- | --- | --- | --- | --- |
| `TPV_ANDROID` | Sí | Sí | `UNSUPPORTED` en esta experiencia | Derivados del executor real de `avoqado-tpv` |
| `TPV_IOS` | Sí | Sí | `UNSUPPORTED` | Ninguno hasta que exista consumidor probado |
| `POS_ANDROID` | No | No | Reportada: `SUPPORTED` / `UNSUPPORTED`; sin reporte: `UNKNOWN` | Ninguno en v1 |
| `POS_IOS` | No | No | `UNSUPPORTED` en v1 | Ninguno en v1 |
| `POS_DESKTOP` | No | No | `UNSUPPORTED` en v1 | Ninguno en v1 |
| `KDS` | No | No | `UNSUPPORTED` | Ninguno en v1 |
| `PRINTER_*` legacy | No | No | `UNSUPPORTED` | Ninguno |

La allowlist de `TPV_ANDROID` se mantiene junto al resolver y se prueba contra el enum/modelo que consume `avoqado-tpv`. No se usa
`type.startsWith('TPV_')` para conceder comandos: `TPV_IOS` existe en el enum, pero no hay evidencia de un cliente que ejecute la cola.

### Reglas de resolución

- Lo derivable de la familia de app lo decide el server: activación, configuración de merchants/procesador y comandos.
- Lo dependiente del hardware instalado lo aporta el aparato: presencia actual de segunda pantalla.
- Marca/modelo ayudan a nombrar y diagnosticar, nunca a conceder `canInvert`.
- `formFactor=COUNTERTOP_POS` no implica pantalla secundaria.
- La versión del cliente puede usarse en el futuro para retirar una capacidad con un bug conocido, pero no forma parte de v1.
- `customerDisplayInverted=true` no demuestra capacidad: es una preferencia guardada, no un sensor.

---

## Reporte Android de la segunda pantalla

### Endpoint nuevo y aditivo

```http
PUT /api/v1/mobile/venues/:venueId/device-capabilities
Authorization: Bearer <staff token>
X-Device-ID: <existing SyncOutbox.deviceId>
X-Device-Platform: ANDROID

{
  "schemaVersion": 1,
  "customerDisplay": { "available": true }
}
```

El endpoint:

1. autentica y exige membresía del venue;
2. toma la identidad del header existente, nunca un `terminalId` arbitrario del body;
3. resuelve exactamente `[venueId, deviceUid]`;
4. si es el primer request autenticado, reutiliza `registerDeviceSeen` para crear/enlazar el `Terminal` sin activación y marca ese request
   como ya registrado para que el hook pasivo de `res.finish` no duplique la escritura;
5. sólo acepta observaciones permitidas para `POS_ANDROID`;
6. guarda el snapshot y el timestamp del server de forma idempotente;
7. acepta de nuevo un snapshot idéntico y refresca `capabilitiesObservedAt`; eso confirma que la observación sigue vigente, pero no genera
   `ActivityLog`;
8. si no consigue establecer la identidad por un error transitorio, devuelve un código retryable y Android conserva el `pending`; nunca
   convierte el fallo de telemetría en fallo de login o venta.

Un token de venue A no puede reportar sobre un dispositivo de venue B. Tampoco se acepta `supportedRemoteCommands` desde el body: un
cliente modificado no puede autoconcederse acciones peligrosas.

### Fuente local de verdad

Android no contará displays a ciegas. Reutiliza la misma decisión pura que ya alimenta `CustomerDisplayManager` y filtra AnyDesk/captura
remota. El hecho reportado es equivalente a `roles.invertible`, no a `Build.MANUFACTURER == SUNMI` ni a `displays.size > 0`.

Eventos que recalculan el snapshot:

- arranque autenticado;
- `onDisplayAdded`;
- `onDisplayRemoved`;
- `onDisplayChanged` cuando cambie el resultado efectivo;
- cambio de venue con la misma Activity.

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

No se escribe `ActivityLog` por cada reporte: es telemetría derivada y potencialmente frecuente, igual que un heartbeat. Cambiar la
preferencia `customerDisplayInverted` sí conserva su auditoría existente.

---

## Validación autoritativa de acciones

Ocultar un botón no basta. Todas las entradas que terminan en una acción usan el mismo resolver antes de mutar o encolar.

### Comandos remotos

La validación vive en el punto central que crea `TpvCommandQueue`, no sólo en un controller. Eso cubre dashboard venue, dashboard org,
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

### Inversión de pantalla

Tanto el update general de dashboard como `PATCH /mobile/venues/:venueId/terminals/:terminalId/display-mode` verifican:

1. tenant correcto;
2. `capabilities.customerDisplay.canInvert === true`;
3. en dashboard, `tpv:update`;
4. en mobile, que `terminalId` sea exactamente el `Terminal` del `X-Device-ID` autenticado, además de la membresía del venue. El cajero
   puede configurar su propio mostrador sin recibir permiso para administrar cualquier aparato del local.

`UNSUPPORTED` devuelve `422 DEVICE_ACTION_UNSUPPORTED`. `UNKNOWN` devuelve `422 DEVICE_CAPABILITY_UNKNOWN` con una explicación accionable:
"Este dispositivo aún no ha confirmado una segunda pantalla; abre o actualiza Avoqado POS con conexión".

Desconectar una pantalla no pone `customerDisplayInverted=false`. El toggle desaparece y queda la preferencia guardada; al reconectar y
reportar `SUPPORTED`, el modo vuelve a estar disponible con el valor anterior.

### Activación, creación y borrado

- `requiresActivation` se deriva del tipo/lifecycle, nunca de `activatedAt === null` por sí solo.
- **Solicitar/registrar TPV** conserva el wizard y crea sólo una TPV provisionada.
- Un POS auto-registrado nunca muestra Activar, Generar código ni Eliminar por falta de `activatedAt`.
- El endpoint de borrado legacy rechaza dispositivos auto-registrados o con historia; el producto no presenta borrado como administración
  normal.
- Cuando se diseñe el retiro de POS, será una acción explícita que cambia `status=RETIRED`, preservando órdenes, pagos y atribución.

### Configuración de cobro

Asignar merchants, cambiar procesador o ejecutar acciones de afiliación sólo aparece y se acepta cuando
`canManagePaymentConfiguration=true`. Un `POS_ANDROID` puede correr en hardware Sunmi y aun así no ser una TPV de cobro Avoqado; marca y
forma física no cambian ese hecho.

---

## Dashboard: experiencia y compatibilidad de rutas

### Navegación canónica

Se agregan rutas de producto nuevas sin mover los endpoints:

| Canónica | Compatibilidad |
| --- | --- |
| `/devices` | `/tpv` redirige preservando query string |
| `/devices/:deviceId` | `/tpv/:tpvId` redirige al mismo id |
| `/devices/orders/:id` | `/tpv/orders/:id` permanece como alias/redirect |

Las rutas de `orders` se declaran antes que `:deviceId`, como ya ocurre con `tpv`, para que `orders` no se capture como un id. Los
componentes no se duplican: ambos paths terminan en la misma pantalla durante la transición.

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
- capacidades relevantes con `SUPPORTED`, `UNSUPPORTED` o `Sin confirmar`.

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
- **Invertir pantalla** sólo aparece si `customerDisplay.canInvert` es `true`.
- `UNKNOWN` se muestra en información/diagnóstico, pero no como control ejecutable.
- Merchants/procesador sólo aparecen en TPV de cobro.
- Activación sólo aparece para el lifecycle provisionado.
- `OrgTerminalDrawer` usa exactamente el mismo helper y no mantiene una segunda matriz local.

La ausencia por incompatibilidad técnica no necesita un teaser de paywall. En el detalle sí se explica el estado (por ejemplo, "Este POS
no admite comandos remotos desde Avoqado"), para que no parezca un problema de permisos.

### Permisos

La primera versión conserva `tpv:read`, `tpv:update`, `tpv:command`, `tpv:create`, etc. Renombrarlos a `devices:*` ahora obligaría a migrar
overrides persistidos en `VenueRolePermission` y a coordinar varios clientes sin mejorar la experiencia visible.

Si se hace después, requiere alias bidireccional en `PERMISSION_DEPENDENCIES`, actualización sincronizada de clientes, migración de datos y
auditoría `npm run audit:permissions`. No forma parte de este cambio.

---

## Impacto por repo en la primera entrega

### `avoqado-server` — sí

- migración aditiva de los dos campos de observación y regeneración de schema map;
- schema Zod y endpoint móvil de reporte;
- `resolveDeviceCapabilities` y tests de matriz;
- `capabilities` aditivo en listas/detalles venue y organización;
- validación central de comandos, display mode, activación y borrado legacy;
- respuestas estables y accionables para acción no soportada/capacidad desconocida;
- `src/mcp/tools/terminals.ts:list_devices` con el mismo DTO efectivo.

### `avoqado-web-dashboard` — sí

- consumir el contrato efectivo;
- retirar inferencias por `activatedAt`, marca o estado genérico;
- aplicar capacidad + permiso en lista, detalle y drawer de organización;
- rutas canónicas `/devices` con aliases `/tpv`;
- copy, traducciones y analítica de navegación renombradas;
- mantener los servicios HTTP legacy en esta fase.

### `avoqado-android` — sí, acotado

- observar `roles.invertible` desde la lógica existente;
- persistir el último snapshot/pending;
- reportarlo al endpoint en arranque, reconexión y cambios de display;
- no cambiar login, auto-registro, activación ni flujo de venta;
- no implementar comandos remotos.

### `avoqado-tpv` — no en la primera entrega

El consumidor de comandos ya existe y el server deriva capacidades desde `TPV_ANDROID`. Tocar el APK sólo para repetir esa información
añadiría costo de rollout y podría romper versiones antiguas. Una fase futura puede hacer que anuncie versión/capacidades si aparece una
diferencia real entre modelos o versiones que el server no pueda derivar.

### `avoqado-ios` — no en la primera entrega

El auto-registro ya funciona. El server resuelve sin comandos y sin display de cliente para `POS_IOS`; no hace falta que iOS anuncie
`false`. Si se implementa salida externa o una acción nativa real, iOS entra con su propia observación versionada.

### Presentación comercial

Antes de cerrar la implementación se busca "Terminales", "TPV" y administración de dispositivos en los tres entregables canónicos de
`Avoqado-HQ/operations/marketing/platform-presentation/`. Si la capacidad está descrita, se actualizan los tres HTML y se regeneran sus tres
PDF en el mismo cambio. La búsqueda y su resultado quedan registrados aunque no haya ocurrencias.

---

## Compatibilidad y orden de despliegue

```text
1. Server aditivo
   └── acepta reportes opcionales + devuelve capabilities + bloquea acciones imposibles

2. Android
   └── reporta segunda pantalla; TPV/iOS viejos siguen funcionando

3. Verificación en hardware
   └── Sunmi dual=true, Android simple=false, display remoto filtrado

4. Dashboard capability-aware
   └── primero acciones; después copy y rutas /devices

5. Limpieza gradual
   └── medir aliases /tpv; no renombrar API/DB mientras sigan teniendo consumidores
```

### Por qué este orden es seguro

- El server sale primero y todos los campos nuevos son opcionales/aditivos.
- Clientes viejos ignoran `capabilities` y continúan auto-registrándose.
- TPVs viejas conservan comandos porque su capacidad se deriva del tipo, no de un reporte nuevo.
- Android se despliega y se verifica antes de que el dashboard oculte/muestre el toggle por observación.
- El renombre visible sale al final; para entonces la lógica ya está correcta bajo ambos nombres.
- No hace falta feature flag: el rollout se controla por compatibilidad del contrato y orden de deploy, no por una bifurcación permanente
  de producto.

### Rollback

- Revertir dashboard devuelve el copy/rutas viejas, pero el server sigue impidiendo comandos imposibles.
- Revertir Android deja la última observación; la ausencia posterior no la convierte en `false`.
- Revertir el uso del DTO no exige revertir la migración: los campos nullable pueden permanecer sin lectores.
- La eliminación física de columnas se posterga a una migración separada y sólo si se abandona el diseño; nunca forma parte de un rollback
  urgente.

---

## Errores y estados de UI

| Situación | Server | Dashboard |
| --- | --- | --- |
| POS Android viejo, sin reporte | `customerDisplay.state=UNKNOWN` | "Capacidad sin confirmar"; sin toggle |
| Android simple reporta `false` | `UNSUPPORTED` | "Sin pantalla secundaria"; sin toggle |
| Sunmi/Elo dual reporta `true` | `SUPPORTED`, `canInvert=true` | Muestra toggle si además tiene `tpv:update` |
| Intento directo de invertir sin soporte | `422 DEVICE_ACTION_UNSUPPORTED` | Mensaje específico, nunca éxito optimista |
| Intento de comando en POS | No crea cola; `422 DEVICE_ACTION_UNSUPPORTED` | Acción ausente; si había UI vieja, muestra explicación |
| TPV soportada desconectada | Cola normal existente | "Se enviará al conectarse" |
| Bulk mezcla TPV y POS | Encola TPV, reporta POS en `skipped[]` | Resumen parcial explícito |
| Display se desconecta estando invertido | Guarda preferencia, reporta `false` | Control oculto; explica última observación |
| Reporte falla por red | No afecta request de negocio | POS sigue; reintento silencioso del snapshot |

---

## Seguridad, tenancy y auditoría

- Cada lectura/escritura de capacidad filtra por `venueId` u `orgId`.
- El reporte móvil sólo puede actualizar el `deviceUid` del propio request dentro del venue autenticado.
- El body no acepta terminal id, permisos, comandos, merchant ids ni flags de activación.
- `observedCapabilities` es evidencia no confiable limitada a hardware; las capacidades peligrosas se derivan en server.
- Las acciones siguen usando su permiso exacto. Capacidad no concede acceso y permiso no inventa soporte técnico.
- La validación central también cubre superadmin y bulk; no hay bypass por usar otra ruta.
- Reportes/heartbeats no generan `ActivityLog` por volumen. Alta de dispositivo, cambios de preferencia, activación, retiro y comandos
  conservan la auditoría aplicable.
- Los mensajes de error al usuario están en español y no exponen Prisma, nombres de tablas ni detalles internos en el MCP.

---

## Verificación requerida durante la implementación

### Server

1. Tabla completa del resolver por `TerminalType`.
2. `POS_ANDROID` sin snapshot ⇒ `UNKNOWN`; `true` ⇒ `SUPPORTED`; `false` ⇒ `UNSUPPORTED`.
3. Un cliente no puede reportar `supportedRemoteCommands` ni cambiar otro `deviceUid`/venue.
4. Primer reporte puede auto-registrar sin activación y sigue siendo idempotente.
5. Clientes sin headers conservan respuestas/flujo actuales.
6. `queueCommand` permite los comandos actuales de `TPV_ANDROID` y rechaza POS/iOS/KDS/periféricos sin crear cola.
7. Bulk devuelve parciales correctos sin fingir éxito.
8. Display mode permite sólo `canInvert=true`; no resetea la preferencia al reportar `false`.
9. Activación/métricas/borrado no tratan a un POS como TPV por `activatedAt=null`.
10. Listas, detalle, organización y `list_devices` devuelven la misma resolución.
11. Regresión: heartbeat/ACK de PAX y NexGo siguen entregando sus comandos.

### Dashboard

1. Matriz de acción por capacidad y permiso: ambos son obligatorios.
2. Activación y CTA manual sólo para TPV.
3. Inversión sólo con `canInvert=true`.
4. Cada comando se filtra por `supportedRemoteCommands` en lista, detalle y org drawer.
5. `/devices`, detalle y pedido abren directo; cada URL `/tpv` redirige preservando id, search y hash.
6. Métricas/filtros de activación excluyen POS.
7. Copy explica que POS aparece al iniciar sesión.
8. Cliente viejo/estado `UNKNOWN` es visible y explicable, no un botón muerto.

### Android

1. La observación usa el resolver de display real y descarta displays virtuales de captura/remoto.
2. Arranque y hot-plug cambian el snapshot.
3. Estado persistido antes de red; muerte del proceso no lo pierde.
4. Trabajo único conserva la observación más reciente si cambia durante un PUT.
5. 401/403 no entra en loop agresivo; espera auth/membresía válida. Errores de red reintentan con backoff.
6. Ningún error de reporte afecta pedidos, efectivo, impresión o customer display local.

### QA en aparatos reales

1. Sunmi D3/T3 con dos pantallas: server registra `SUPPORTED`, dashboard muestra toggle y la inversión funciona.
2. Android teléfono/tablet de una pantalla: registra `UNSUPPORTED`, no aparece toggle.
3. AnyDesk/screen-cast sin pantalla física: no produce falso `SUPPORTED`.
4. Desconectar/reconectar la segunda pantalla actualiza estado y conserva preferencia.
5. Apagar WiFi antes del cambio, matar/reabrir app y reconectar: llega el snapshot más reciente sin afectar una venta.
6. PAX/NexGo: reinicio, mantenimiento y lock siguen visibles/ejecutables con ACK esperado.
7. POS Android y iOS: ningún comando remoto aparece ni se encola.
8. APK Android anterior: sigue entrando y operando; queda `UNKNOWN` hasta actualizar, sin pedir activación.

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
6. sólo un Android que observe segunda pantalla obtiene `canInvert=true`;
7. marca/modelo/form factor nunca sustituyen la observación de display;
8. clientes viejos siguen funcionando y `UNKNOWN` no se convierte en activación pendiente;
9. `/tpv` y endpoints existentes siguen siendo compatibles;
10. `list_devices` y dashboard no discrepan;
11. la prueba real dual, simple, remoto y offline está documentada;
12. el renombre visible no obligó a renombrar tabla, endpoints ni permisos.

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

Esas fases reutilizan el resolver y el snapshot versionado; ninguna justifica ampliar el alcance inicial ni retrasar la corrección de las
acciones engañosas de hoy.
