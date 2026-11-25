---
title: Capturar el código de quien recomendó al cliente en la terminal
description: En el carrito de Cobrar, con el cliente elegido, escribe el código de referido para darle su descuento de primera compra.
product: tpv
category: clientes
task: capturar-codigo-de-referido
requiredPermissions: []
featureCode: REFERRAL_PROGRAM
gateKind: FEATURE
money: true
versionMin: 2.14.0
sourceRepo: avoqado-tpv
sourceRef: 031f14db2969606125a4a04c9f8f30bdd402a660
keywords:
  - código de referido
  - me recomendó alguien
  - código de recomendación
  - descuento por referido
  - cliente recurrente
---

## Antes de empezar

La sección «¿Te recomendó alguien?» sale en el carrito de *Cobrar* y viene en el plan Pro (sin él, sale con la etiqueta Pro). El programa de referidos se prende en el panel, en *Clientes* › *Programa de Referidos*.

## Pasos

1. En *Cobrar*, abre el carrito y elige al cliente nuevo con *Agregar cliente*.
2. En «¿Te recomendó alguien?», escribe el código que te da el cliente en *CÓDIGO*.
3. Toca *Validar*.
4. Si es correcto, sale «Referido por …» y «Se aplicó …% descuento». Cobra la venta como siempre.
5. Para quitarlo antes de cobrar, toca *Quitar*.

## Problemas frecuentes

- Si dice «Selecciona un cliente primero para usar un código de referido.», agrega primero al cliente a la venta.
- «Código no encontrado»: revisa que esté bien escrito o toca *Intentar otro código*.
- «No puedes referirte a ti mismo»: el código es del mismo cliente que elegiste.
- «Cliente recurrente»: ese cliente ya compró antes, así que no aplica el descuento de cliente nuevo; «Requiere autorización de un manager.».
- «Programa inactivo»: el negocio no tiene prendido el programa de referidos o lo pausó.

## Sin internet

- Si la sección dice «Necesita internet», el código no se puede validar hasta que vuelva la conexión.
