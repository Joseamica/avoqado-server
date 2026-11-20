---
title: Liquidar o cancelar una cuenta por cobrar en el panel
description: Marca como pagada, o cancela, una cuenta que quedó por cobrar desde Reportes › Cuentas por Cobrar en el panel.
product: dashboard
category: cuentas-por-cobrar
task: liquidar-cuenta-por-cobrar
requiredPermissions:
  - tpv-reports:pay-later-aging
  - orders:update
money: true
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
browserTested: 2026-11-12
keywords:
  - cuentas por cobrar
  - fiado
  - liquidar orden
  - pagar después
  - cancelar cuenta
  - saldo pendiente
---

## Antes de empezar

*Liquidar Orden* registra el saldo pendiente como un pago en efectivo, aunque te hayan pagado de otra forma: anota cómo te pagaron en *Notas (opcional)*. Liquidar pide permiso para editar órdenes.

## Pasos

1. En *Reportes* › *Cuentas por Cobrar*, busca la cuenta y toca el botón ⋯ de su renglón.
2. Toca *Liquidar Orden*, revisa el *Saldo pendiente* y, si quieres, escribe en *Notas (opcional)* cómo te pagaron.
3. Toca *Liquidar Orden*. Si sale «Orden Liquidada», ya quedó pagada.
4. Para una cuenta que nunca se va a cobrar, toca *Cancelar orden* en ese mismo menú, escribe el *Motivo* y toca *Cancelar orden*.

## Problemas frecuentes

- *Cancelar orden* sólo sale si tienes permiso para cancelar cuentas sin cobrar, la cuenta no tiene ningún pago y no es de una mesa. Cancelarla no se puede deshacer.
- El *Cancelar orden* del cuadro se prende con un motivo de al menos 3 letras.
- Si sale «Ya estaba cancelada», la cuenta ya no está por cobrar.
- Si sale «Error» o «No se canceló», debajo dice por qué.
