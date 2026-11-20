---
title: Liquidar el saldo pendiente de un cliente en el panel
description: Marca como pagadas las cuentas pendientes de un cliente desde Clientes en el panel.
product: dashboard
category: cuentas-por-cobrar
task: liquidar-saldo-de-cliente
requiredPermissions:
  - customers:read
  - customers:settle-balance
money: true
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
browserTested: 2026-11-12
keywords:
  - liquidar saldo
  - saldo pendiente del cliente
  - fiado
  - el cliente ya pagó
---

## Antes de empezar

*Clientes* pide permiso para ver clientes; *Liquidar Saldo* sale si además tienes permiso para liquidar saldos y el cliente tiene *Saldo Pendiente*. Lo que liquida queda como pagos en efectivo, aunque te hayan pagado de otra forma: anota cómo te pagaron en *Notas (opcional)*.

## Pasos

1. En *Clientes* › *Todos los Clientes*, busca al cliente (el filtro *Con Saldo Pendiente* los muestra).
2. En su renglón, toca el botón ⋯ y luego *Liquidar Saldo*.
3. Revisa *Órdenes pendientes* y *Saldo total* y, si quieres, escribe en *Notas (opcional)* cómo te pagaron.
4. Toca *Liquidar Saldo*. Si sale «Saldo Liquidado», ahí mismo dice cuántas órdenes y por cuánto se liquidaron.

## Problemas frecuentes

- Algunas cuentas no se liquidan aquí, por ejemplo un pedido de Rappi en efectivo. Si después el cliente sigue con *Saldo Pendiente*, alguna cuenta no entró.
- Si sale «Error», debajo dice por qué.
