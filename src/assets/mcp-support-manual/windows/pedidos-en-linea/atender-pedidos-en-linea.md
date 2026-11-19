---
title: Atender los pedidos en línea en el POS Windows
description: Acepta o rechaza los pedidos de la tienda en línea, márcalos listos o entregados, reimprime su comanda o pausa los pedidos, en el POS Windows.
product: windows
category: pedidos-en-linea
task: atender-pedidos-en-linea
requiredPermissions:
  - orders:read
money: true
versionMin: 2.25.32
sourceRepo: avoqado-android
sourceRef: c07a2bbebf453598963bf96f3208f66193dd5efb
keywords:
  - pedidos en línea
  - tienda en línea
  - aceptar pedido
  - rechazar pedido
  - pedido listo
  - pausar pedidos
  - alarma de pedido nuevo
---

## Antes de empezar

En *Más*, toca *Pedidos en línea*. Aceptar, rechazar, *Listo*, *Entregado* y *Reimprimir* sólo aparecen con el permiso de actualizar pedidos. Con el POS abierto, un pedido nuevo sale arriba en «Nuevo pedido en línea #…»: toca *Ver* para abrir la bandeja. Si cierras el POS Windows, no avisa.

## Pasos

1. En «Por aceptar», toca *Aceptar* y elige en cuántos minutos estará listo (10, 15, 20 o 30 min).
2. Para no tomarlo, toca *Rechazar* y elige el motivo: *Sin ingredientes*, *Cerrado*, *Muy ocupados* u *Otro*.
3. Cuando esté preparado, en «En preparación» toca *Listo*.
4. Cuando el cliente se lo lleve, toca *Entregado*.
5. Para volver a imprimir su comanda en esta computadora, toca *Reimprimir*.
6. Para dejar de recibir pedidos nuevos un rato, toca *Pausar pedidos* arriba y elige 15, 30 o 60 min; para abrir otra vez, toca *Pausar pedidos* y luego *Reanudar*.

## Problemas frecuentes

- Si aparece en el pedido «Con tarjeta: se cobra al aceptar», no lo cobres en la caja: ese pedido no muestra *Cobrar*.
- Si aparece «Cobra el pedido antes de entregarlo.», ese pedido todavía no está pagado.
- Si aparece «No se pudo cobrar la tarjeta» en un pedido, quedó rechazado porque su tarjeta no se pudo cobrar.
- Si aparece «Tarjeta cobrada: devuélvela desde el panel», ese pedido no se completó (se rechazó, se canceló o venció) y su tarjeta sí se cobró: la devolución se hace desde el panel.
- Si el cliente ya no quiere un pedido aceptado y sin ningún pago, toca *Cancelar pedido* y confirma con *Cancelar pedido*. Ese botón sólo sale con el permiso de cancelar ventas sin cobrar.
- Si aparece «Ese pedido ya no está disponible», el pedido ya cambió (por ejemplo, otro aparato lo atendió o el cliente lo canceló).
- Pausar pide el permiso de pausar pedidos en línea (de fábrica: gerente, administrador y dueño). Sin él, si el negocio tiene prendido el PIN de gerente, un gerente lo autoriza con su PIN.
- Si aparece en *Más*, junto a *Pedidos en línea*, «Incluido en el Plan …», el plan del negocio no incluye los pedidos en línea.

## Sin internet

- Si aparece «Sin conexión: no llegan pedidos nuevos», aceptar, rechazar, *Listo*, *Entregado*, *Cancelar pedido* y *Pausar pedidos* quedan apagados hasta que vuelva la conexión.
