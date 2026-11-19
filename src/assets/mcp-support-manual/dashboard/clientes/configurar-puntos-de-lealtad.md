---
title: Configurar los puntos de lealtad en el panel
description: Prende el programa de lealtad y define cuántos puntos gana el cliente, cuánto vale cada punto y si caducan, desde el panel.
product: dashboard
category: clientes
task: configurar-puntos-de-lealtad
requiredPermissions:
  - loyalty:read
  - loyalty:update
featureCode: LOYALTY_PROGRAM
gateKind: FEATURE
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
keywords:
  - programa de lealtad
  - puntos por compra
  - configurar puntos
  - no le suman puntos
  - canjear puntos
---

## Antes de empezar

El programa de lealtad es para los negocios que lo tienen incluido en su plan. Necesitas permiso para ver y para editar la lealtad.

## Pasos

1. En *Clientes* › *Programa de Lealtad*, prende el interruptor de *Estado del Programa* para que diga *Activo*.
2. En *Reglas de Acumulación*, escribe los *Puntos por cada $1 gastado* y, si quieres, los *Puntos Bonus por Visita*.
3. En *Reglas de Canje*, escribe la *Tasa de Canje*, que es cuánto vale cada punto, y el *Mínimo de Puntos para Canjear*.
4. En *Expiración de Puntos*, prende *Habilitar Expiración* y escribe los *Días Hasta Expiración*, o déjalo apagado.
5. Toca *Guardar Cambios*: sale «Configuración de lealtad actualizada exitosamente».

## Problemas frecuentes

- *Guardar Cambios* se prende hasta que cambias algo.
- Con *Estado del Programa* en *Inactivo*, las ventas no suman puntos ni sellos.
- Para que una venta sume puntos, tiene que llevar al cliente.
