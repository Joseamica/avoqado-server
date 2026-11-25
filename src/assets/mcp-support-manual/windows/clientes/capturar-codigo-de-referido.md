---
title: Capturar el código de quien recomendó al cliente en el POS Windows
description: En el carrito de Cobrar, escribe el código de referido de quien recomendó al cliente nuevo para darle su descuento de primera compra.
product: windows
category: clientes
task: capturar-codigo-de-referido
requiredPermissions: []
featureCode: REFERRAL_PROGRAM
gateKind: FEATURE
money: true
versionMin: 2.22.2
sourceRepo: avoqado-android
sourceRef: 78e5372f37ed7791d86fc1fe621d4a073e5a09ff
keywords:
  - código de referido
  - me recomendó alguien
  - código de recomendación
  - descuento por referido
  - el código no funciona
  - cliente recurrente
---

## Antes de empezar

La sección «¿Te recomendó alguien?» sale en el carrito de *Cobrar*. Viene en el plan Pro: sin él, dice «Esta función es parte del plan Pro…». El programa de referidos se prende en el panel, en *Clientes* › *Programa de Referidos*. Si la ventana está angosta, toca antes *Ver carrito*.

## Pasos

1. Con los productos en el carrito, elige al cliente nuevo: arriba del carrito toca *Agregar cliente* y búscalo o créalo.
2. En «¿Te recomendó alguien?», escribe el código que te da el cliente en *CÓDIGO*.
3. Toca *Validar*.
4. Si es correcto, sale «Referido por …» y «Se aplicó …% descuento». Cobra la venta como siempre.
5. Para quitarlo antes de cobrar, toca *Quitar*.

## Problemas frecuentes

- Si dice «Selecciona un cliente primero para usar un código de referido.», agrega primero al cliente a la venta.
- «Código no encontrado»: no existe ese código; revisa que esté bien escrito o toca *Intentar otro código*.
- «No puedes referirte a ti mismo»: el código es del mismo cliente que elegiste.
- «Cliente recurrente»: ese cliente ya compró antes, así que no aplica el descuento de cliente nuevo. *Forzar atribución (próximamente)* todavía no funciona.
- «Programa inactivo»: el negocio no tiene prendido el programa de referidos o lo pausó.
- «No se pudo validar el código»: revisa la conexión e intenta de nuevo o usa otro código.
