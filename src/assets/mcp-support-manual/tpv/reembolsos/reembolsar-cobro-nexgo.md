---
title: Reembolsar un cobro con tarjeta en la terminal Nexgo
description: Devuelve el total de un cobro con tarjeta desde el historial de pagos de la terminal Nexgo, antes del corte de AngelPay.
product: tpv
category: reembolsos
task: reembolsar-cobro
deviceFamily: NEXGO
requiredPermissions:
  - payments:refund
money: true
versionMin: 2.12.5
sourceRepo: avoqado-tpv
sourceRef: 031f14db2969606125a4a04c9f8f30bdd402a660
deviceTested: 2026-11-18
keywords:
  - reembolso
  - devolver un cobro
  - devolución con tarjeta
  - cancelar un cobro
  - angelpay
---

## Antes de empezar

En la Nexgo se devuelve siempre el cobro completo (no hay reembolso parcial). Desde la terminal sólo se puede devolver antes del corte de AngelPay: las 11 pm del día de la venta; lo cobrado a las 11 pm o después, hasta las 11 pm del día siguiente.

## Pasos

1. En el inicio, toca *Pagos* y, en *Historial de Pagos*, toca el cobro que vas a devolver.
2. En *Detalle del Pago*, toca *Procesar Reembolso*.
3. En *Confirmar Reembolso*, revisa *Monto a Reembolsar* (es el total del cobro) y elige el *Motivo del Reembolso*.
4. Toca *Procesar Reembolso* con el monto y espera mientras dice *Procesando...*.
5. Si AngelPay lo devuelve, sale el mensaje del reembolso y la terminal regresa a *Historial de Pagos*.

## Problemas frecuentes

- «Ya pasó el corte de AngelPay (11 pm del día de la venta). La devolución se gestiona con soporte de AngelPay.»: desde la terminal ya no se puede.
- «Solo administradores pueden procesar reembolsos»: tu usuario no tiene el permiso de reembolsos.
- «Los pagos en efectivo no pueden reembolsarse con tarjeta»: un cobro en efectivo no se devuelve desde aquí.
- «Este pago pertenece a otro dispositivo (…). Reembolsa desde ese equipo.»: hazlo en la terminal que cobró.

## Sin internet

Sin red puede salir «No se pudo consultar la venta en AngelPay (…). No se reembolsó nada.». Si AngelPay lo devolvió pero Avoqado no pudo registrarlo, nunca vuelvas a reembolsar: si el mensaje dice que «quedó guardada en este equipo y se completará sola», no hace falta más; si dice «El servidor rechazó el registro» o que no pudo registrarla «ni en el servidor ni en este equipo», avisa al supervisor con la referencia; si dice «Backend no registró el reembolso», contacta a soporte.
