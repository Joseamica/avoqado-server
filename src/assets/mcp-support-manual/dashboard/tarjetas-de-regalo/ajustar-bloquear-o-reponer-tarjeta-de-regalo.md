---
title: Ajustar el saldo, bloquear o reponer el código de una tarjeta de regalo en el panel
description: Desde Clientes › Tarjetas de regalo, quien las administra ajusta el saldo de una tarjeta, la bloquea o, si se puede, le pone un código nuevo.
product: dashboard
category: tarjetas-de-regalo
task: ajustar-bloquear-o-reponer-tarjeta-de-regalo
requiredPermissions:
  - giftCards:read
  - giftCards:manage
money: true
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
browserTested: 2026-11-18
keywords:
  - tarjeta de regalo
  - ajustar saldo
  - bloquear tarjeta
  - perdió su tarjeta de regalo
  - reponer código
  - gift card
---

## Antes de empezar

Las *Acciones del gerente* de una tarjeta piden permiso para administrar tarjetas de regalo. Un ajuste de saldo queda en el historial de la tarjeta con tu nombre.

## Pasos

1. En *Clientes* › *Tarjetas de regalo*, busca la tarjeta por sus últimos 4, nombre, teléfono o correo, y ábrela.
2. En *Acciones del gerente*, toca *Ajustar saldo*. Elige *Sumar saldo* o *Quitar saldo*, escribe el *Monto*, elige el *Motivo*, escribe una *Nota* de al menos 5 letras y toca *Ajustar*.
3. Para que nadie pague con ella, toca *Bloquear*, elige el *Motivo* (con *Otro motivo*, escribe una nota de al menos 5 letras) y confirma con *Bloquear*. El saldo no cambia.
4. Para volver a usarla, toca *Desbloquear*, elige el *Motivo* de la misma forma y confirma con *Desbloquear*.
5. Si el cliente perdió el código y sale *Reponer código*, tócalo, escribe el *Folio de la compra (número de cuenta)* y toca *Reponer código*. El código nuevo se ve una sola vez: anótalo o entrégalo.

## Problemas frecuentes

- Si sale «No supimos si se guardó…», toca *Intentar otra vez*: no se aplica dos veces.
- *Quitar saldo* no deja quitar más del saldo que tiene la tarjeta.
- *Reponer código* no sale si la tarjeta ya se usó o si está guardada en la cartera de un cliente.
- Con el código nuevo, el anterior deja de servir; el saldo y la vigencia no cambian.
