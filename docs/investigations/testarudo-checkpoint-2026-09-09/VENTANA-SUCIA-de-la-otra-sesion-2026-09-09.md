# Ventana sucia en `ContactlessKernelResult.kt` — quién la causó y qué hay que repetir

Escrito por la sesión que puso el sabotaje (`95e48431` → continúa como `b6f3a4f6`), a petición del
checkpoint de huellas. **Nada de esto es una hipótesis: las horas salen de
`~/.claude/avq-verify/log.jsonl`.**

## Qué se saboteó, y por qué

Estaba verificando que unas pruebas nuevas TUVIERAN DIENTES (romper el fix a propósito y comprobar
que truenan las correctas). El sabotaje vivió **sólo en el disco**, nunca en git y nunca en el
índice: no se corrió `git add` sobre ese archivo en ningún momento.

Dos sabotajes, ambos en
`avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/payment/presentation/ContactlessKernelResult.kt`:

- **A** — `confirmarEnElTelefono()` devolvía `ContactlessOutcome.OTHER` en vez de `SEE_PHONE`.
  🔴 **Éste es el que le pega a trabajo ajeno:** `SEE_PHONE` es uno de los seis casos de
  `KERNEL_REFUSALS_WITHOUT_CHARGE`. Con `OTHER`, ese desenlace **sale del conjunto**, así que el
  camino de pago llama `markIndeterminate(...)` donde debería llamar `markKernelRefused(...)`, y la
  terminal se queda RETENIDA en vez de liberarse.
- **B** — el mensaje de «no aceptada» perdía el motivo traducido. Sólo afecta texto de pantalla.

## Ventanas (hora local, del log de avq-verify)

| Ventana | Estado del archivo | Corridas de `avoqado-tpv` dentro |
|---|---|---|
| hasta 19:13:00 | ✅ limpio | `19:10:16` (147 s, rc=0) — corrida limpia de referencia |
| **19:13:00 – 19:21:00** | 🔴 **SABOTAJE A** | `19:15:50` (mía) · **`19:17:29` (31 s, AJENA)** · **`19:20:26` (59 s, AJENA)** |
| 19:21:00 – 19:34:00 | ✅ limpio (restaurado y verificado por md5) | — |
| **19:34:00 – 19:40:54** | 🔴 **SABOTAJE A + B** | `19:36:58` (111 s, mía) |
| desde **19:40:54** | ✅ limpio, md5 `604bf13a15328e69998f96624ec9a72d` | — |

⚠️ El momento exacto de la restauración de la ventana 1 no quedó registrado, así que **`19:20:26`
es "posiblemente afectada"**, no "afectada con certeza". `19:17:29` sí cae de lleno.

## Qué hay que repetir

Cualquier resultado de `avoqado-tpv` de las corridas **19:17:29** y **19:20:26** que toque el
camino contactless o `KERNEL_REFUSALS_WITHOUT_CHARGE` midió código roto a propósito. En concreto,
lo que el checkpoint dejó en duda:

- el **reembolso contactless** (medido en ventana sucia) → repetir;
- la **sonda de AngelPay** → no la toca este sabotaje (`AngelPayOutcomeClassifier` y
  `AngelPayPaymentViewModel` no pasan por `ContactlessKernelResult`), así que su duda viene de
  otra causa, no de aquí.

## Estado final, verificado

- Archivo restaurado a las **19:40:54**, md5 `604bf13a15328e69998f96624ec9a72d`, **idéntico** al
  respaldo `/tmp/avq-sabotaje/ORIGINAL.kt` — que se tomó DESPUÉS de la edición de la otra sesión,
  así que su constante sobrevivió (ellos ya lo comprobaron por su cuenta).
- `git status` del archivo: `M ` — índice y árbol de trabajo coinciden, sin sabotaje.
- **No se corrió `git add` ni `git commit` sobre ese archivo.**

## Lo que no vuelvo a hacer

1. Sabotear un archivo del árbol COMPARTIDO. La verificación por sabotaje va en un árbol propio.
2. `rm -rf` sobre `~/.claude/avq-verify/snap-avoqado-tpv/*/build`. Lo hice a las ~19:20 para
   destrabar un snapshot roto, y es posible que el `Unable to delete file` que vio la otra sesión
   lo haya causado eso.
