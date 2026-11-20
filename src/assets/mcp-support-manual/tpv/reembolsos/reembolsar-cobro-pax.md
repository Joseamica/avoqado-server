---
title: Reembolsar un cobro con tarjeta en la terminal PAX
description: Devuelve todo o parte de un cobro con tarjeta desde el historial de pagos de la terminal PAX; el cliente presenta su tarjeta.
product: tpv
category: reembolsos
task: reembolsar-cobro
deviceFamily: PAX
requiredPermissions:
  - payments:refund
money: true
versionMin: 2.9.1
sourceRepo: avoqado-tpv
sourceRef: 031f14db2969606125a4a04c9f8f30bdd402a660
keywords:
  - reembolso
  - devolver un cobro
  - devolución con tarjeta
  - reembolso parcial
  - cancelar un cobro
---

## Pasos

1. En el inicio, toca *Pagos* y, en *Historial de Pagos*, toca el cobro que vas a devolver.
2. En *Detalle del Pago*, toca *Procesar Reembolso*.
3. Para devolver sólo una parte, activa *Reembolso parcial* y escribe el *Monto*. Si sale *Incluir propina en el reembolso*, déjala o quítala.
4. Elige el *Motivo del Reembolso* y toca *Procesar Reembolso* con el monto.
5. Cuando diga *Acerca o inserta la tarjeta para reembolso*, el cliente acerca o inserta la tarjeta con la que pagó.
6. Al salir *Reembolso Aprobado*, toca *Listo* para volver al historial de pagos.

## Problemas frecuentes

- «Solo administradores pueden procesar reembolsos»: tu usuario no tiene el permiso de reembolsos.
- «Los pagos en efectivo no pueden reembolsarse con tarjeta»: un cobro en efectivo no se devuelve desde aquí.
- «Este pago pertenece a otro dispositivo (…). Reembolsa desde ese equipo.»: hazlo en la terminal que cobró.

## Sin internet

El reembolso necesita conexión: si se cae a media devolución, puede salir «Sin conexión a internet.» con «Verifique su conexión e intente nuevamente.». Si sale un aviso que empieza con «La devolución SÍ se hizo», el dinero ya se devolvió: nunca vuelvas a reembolsar. Si dice que «se completará sola en cuanto haya conexión», no hace falta más. Si dice que «el servidor la rechazó» o que no pudo registrarla «ni en el servidor ni en este equipo», avisa al supervisor con la referencia.
