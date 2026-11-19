---
title: Resolver un cobro sin confirmar en la terminal PAX
description: Qué hacer en la terminal PAX cuando un cobro con tarjeta se queda en Estamos confirmando el cobro.
product: tpv
category: cobro
task: cobro-sin-confirmar
deviceFamily: PAX
requiredPermissions:
  - payments:reconcile-uncharged
money: true
versionMin: 2.11.1
sourceRepo: avoqado-tpv
sourceRef: 031f14db2969606125a4a04c9f8f30bdd402a660
keywords:
  - cobro sin confirmar
  - estamos confirmando el cobro
  - no se cobró
  - cobro pendiente
  - cobro doble
---

## Antes de empezar

Si al cobrar sale *Estamos confirmando el cobro*, no vuelvas a pasar la tarjeta ni cobres en efectivo: puede que sí se haya cobrado.

## Pasos

1. Espera mientras dice «Esperando confirmación»; si cambia a *Cobro registrado*, el cobro sí pasó y no se vuelve a cobrar.
2. Si sigue sin confirmarse, toca *Consultar de nuevo*.
3. Si el cobro se empezó en la terminal y revisaste que no se cobró (por ejemplo, en la app del banco del cliente), toca *Ya revisé la terminal: no se cobró* si aparece: queda tu nombre y la hora.
4. Si el cobro lo mandó el punto de venta y el cliente no presentó tarjeta, celular ni reloj, un gerente toca *El cliente no presentó tarjeta*.
5. Cuando salga *Intento cerrado*, toca *Regresar* y vuelve a cobrar la venta.
6. Si después sale arriba que el cobro «SÍ pasó: Avoqado ya lo registró», no lo vuelvas a cobrar y toca *Entendido*.

## Problemas frecuentes

- *Hay evidencia de cobro*: no vuelvas a pasar la tarjeta ni cobres en efectivo; revisa el pago con el gerente.
- «Para dejar constancia de que no se cobró se necesita el permiso de conciliar cobros; pídeselo a tu gerente.»
- «Para declarar que no se cobró, debe entrar un gerente con permiso para resolver cobros pendientes.»

## Sin internet

Un cobro empezado en la terminal sólo se puede declarar desde la terminal si Avoqado ya contestó por él; si no, sale «Primero hay que consultar a Avoqado: conéctate a internet y toca «Consultar de nuevo».».
