# Seriales virtuales de Blumon TPV — multi-merchant en UN solo aparato

> 🔴 **Si ves un `MerchantAccount.blumonSerialNumber` con un dígito de más que el serial de la terminal física: NO es un typo, NO lo
> "alinees" con Blumon, NO lo corrijas.** Es una estrategia deliberada del founder y corregirlo rompe la separación de cobros de ese local.

## Qué son

Blumon liga UNA afiliación por "terminal" registrada. Para que un mismo aparato físico pueda cobrar por VARIAS afiliaciones
(multi-merchant), en Blumon se dan de alta terminales adicionales cuyo serial es **el base + un dígito extra**, y se instalan sobre el mismo
dispositivo:

```
Terminal FÍSICA   2840744167   → afiliación A   (existe en `Terminal`)
Serial VIRTUAL    28407441672  → afiliación B   (existe SOLO en `MerchantAccount`)
```

Casos reales en prod (venue Berthe, 2026-07-30):

| Base       | Virtual (+ dígito) | `MerchantAccount.displayName` |
| ---------- | ------------------ | ----------------------------- |
| 2841548624 | `28415486242`      | MAKADI - B                    |
| 2840744167 | `28407441672`      | Goia                          |
| 2841548627 | `28415486272`      | PKMAKEUP - A                  |

## Dónde vive cada identidad (esto es lo que se olvida)

|                              | Tabla                                              | Contiene             |
| ---------------------------- | -------------------------------------------------- | -------------------- |
| Terminal física              | `Terminal.serialNumber` (con prefijo `AVQD-`)      | SOLO el serial base  |
| Afiliación (incl. virtuales) | `MerchantAccount.blumonSerialNumber` (sin prefijo) | base **y** virtuales |

**Un serial virtual NUNCA tiene fila en `Terminal`.** Cualquier código que resuelva "¿este serial es nuestro?" preguntando solo a `Terminal`
va a descartar cobros reales.

## El bug que esto ya causó (2026-07-30, $9,324)

`processBlumonPaymentWebhook` cortaba con `UNKNOWN_TERMINAL` usando `if (payload.serialNumber && !terminal)`. Un cobro real de $9,324 por la
afiliación "Goia" (serial virtual `28407441672`) se tiró a la basura **antes** de llegar a la cascada de matcheo. El pago estaba bien y el
banco lo aprobó; lo que se perdió fue el sello del webhook, y 40 min después el job de auditoría lo denunció como "cobro sin webhook" (falsa
alarma correcta en la forma, equivocada en la causa).

Lo irónico: `resolveBlumonScope` —que corre en el MISMO `Promise.all`, dos líneas arriba— **sí** resolvía el merchant. El sistema sabía de
quién era el cobro; el gate le preguntó a la tabla equivocada.

**Fix:** el gate acepta cualquiera de las dos identidades (`!terminal && !merchantAccountId`). Tests:
`tests/unit/services/tpv/blumon-webhook.matching.test.ts` → describe "Serial virtual (multi-merchant)".

## Reglas al tocar resolución de seriales

1. **"¿Es nuestro?" = `Terminal` OR `MerchantAccount.blumonSerialNumber`.** Nunca solo una de las dos.
2. **El match SIEMPRE exacto en ambas tablas.** Jamás comparación difusa, `LIKE`, `startsWith`, ni "quitarle el último dígito para ver si
   pega" — rutear dinero con seriales aproximados es peor que perder un webhook.
3. **`canonicalizeBlumonSerial` solo antepone `AVQD-`** y eso está bien: es para `Terminal`. No le agregues lógica de variantes.
4. **`Terminal` sigue siendo la estampa de ubicación física** del evento; el merchant es la de la afiliación que cobró. Son cosas distintas,
   no las colapses.
5. Si un serial no resuelve por NINGUNA de las dos vías, `UNKNOWN_TERMINAL` es la respuesta correcta (probablemente es de otro integrador).

## Al diagnosticar "cobro sin webhook"

Antes de concluir "el dato está mal, hay que alinear con Blumon", **verifica si el serial es una afiliación virtual**:

```sql
SELECT "displayName", "blumonSerialNumber", "blumonPosId"
FROM "MerchantAccount" WHERE "blumonSerialNumber" = '<serial del webhook>';
```

Si devuelve fila, el dato está BIEN y el problema es de código.
