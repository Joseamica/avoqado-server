---
title: Cancelar la venta de una tarjeta de regalo o liberar su cancelación en el panel
description: El mismo día y sin usarse, bloquea las tarjetas de una venta y devuelve su cobro completo; o, si la devolución no se hizo, libéralas.
product: dashboard
category: tarjetas-de-regalo
task: cancelar-venta-de-tarjetas-de-regalo
requiredPermissions:
  - giftCards:read
  - giftCards:manage
money: true
sourceRepo: avoqado-web-dashboard
sourceRef: 501e37072a13f5ed8f22e3d650f2598d3d8820b6
keywords:
  - cancelar tarjeta de regalo
  - devolver tarjeta de regalo
  - reembolsar tarjeta de regalo
  - se vendió mal la tarjeta de regalo
  - cancelación en curso
  - ya no cancelar
  - liberar tarjeta de regalo
---

## Antes de empezar

Cancelar la venta pide permiso para administrar tarjetas de regalo (de fábrica, gerente, administrador y dueño), y devolver el dinero pide además el permiso de reembolsar. Sólo se puede el mismo día de la venta y si ninguna de sus tarjetas se usó. Se cancelan juntas todas las tarjetas de esa venta, y cada cobro de la venta se devuelve completo, por donde se pagó.

## Pasos

1. En *Clientes* › *Tarjetas de regalo*, abre la tarjeta. En *Acciones del gerente*, toca *Cancelar la venta*.
2. Lee el aviso (cuántas tarjetas y cuánto) y toca *Bloquear y empezar*: sale «Tarjetas bloqueadas. Ahora devuelve el dinero desde la venta.».
3. Toca *Ir a la venta*. Devuelve completo cada cobro de la venta, por donde se pagó: en la terminal si fue con tarjeta, o desde el pago de esa venta.
4. Al quedar devueltos todos sus cobros, las tarjetas se cancelan solas. Mientras tanto se quedan bloqueadas («Cancelación en curso»).
5. Si comprobaste que la devolución NO se hizo, en la tarjeta toca *Ya no cancelar*, marca la casilla y toca *Ya no cancelar*: sale «Listo: las tarjetas se pueden usar otra vez.».

## Problemas frecuentes

- Si *Cancelar la venta* sale apagado, debajo dice por qué: «No se puede cancelar: sólo el mismo día de la venta.», «No se puede cancelar: una tarjeta de esta venta ya se usó.» o «Esta venta ya se canceló.».
- Si dice «Desbloquea la tarjeta antes de cancelar la venta.», la tarjeta está bloqueada por otro motivo: desbloquéala primero.
- Si sale «La venta de tarjetas se devuelve completa: reembolsa el cobro entero.», la devolución tiene que ser por todo lo cobrado.
- Si no sabes si la devolución se hizo, no toques *Ya no cancelar*: deja las tarjetas bloqueadas y revisa la venta.
- Si sale «No supimos si se guardó. Toca «Intentar otra vez»: no se aplica dos veces.», toca *Intentar otra vez*.
