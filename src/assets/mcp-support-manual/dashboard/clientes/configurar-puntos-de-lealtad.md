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
sourceRef: 0dd71d0aff8c6b7c8baa30efe87db3dfe49a1354
keywords:
  - programa de lealtad
  - puntos por compra
  - configurar puntos
  - no le suman puntos
  - canjear puntos
  - puntos vencidos
  - se le borraron los puntos
  - caducan los puntos
  - no encuentro guardar cambios
---

## Antes de empezar

El programa de lealtad es para los negocios que lo tienen incluido en su plan. Necesitas permiso para ver y para editar la lealtad.

## Pasos

1. En *Clientes* › *Programa de Lealtad*, prende el interruptor de *Estado del Programa* para que diga *Activo*.
2. En *Reglas de Acumulación*, escribe los *Puntos por cada $1 gastado* y, si quieres, los *Puntos Bonus por Visita*.
3. En *Reglas de Canje*, escribe la *Tasa de Canje*, que es cuánto vale cada punto, y el *Mínimo de Puntos para Canjear*.
4. En *Expiración de Puntos*, prende *Habilitar Expiración* y escribe los *Días Hasta Expiración*, o déjalo apagado.
5. Toca *Guardar Cambios*, en la barra de abajo de la página: sale «Configuración de lealtad actualizada exitosamente».

## Problemas frecuentes

- *Guardar Cambios* se prende hasta que cambias algo.
- Con *Estado del Programa* en *Inactivo*, las ventas no suman puntos ni sellos.
- Para que una venta sume puntos, tiene que llevar al cliente.
- Con la expiración prendida, si un cliente pasa esos días sin movimientos en sus puntos (ganar, canjear o un ajuste), vencen todos sus puntos.
- Al prender la expiración, al volver a prender el programa o al bajar los días, los días sin movimientos empiezan a contar desde ese día: nadie pierde sus puntos por el cambio. Debajo de los días dice desde qué fecha cuentan.
- Si a un cliente le quedaron 0 puntos sin canjear, en su *Historial de Lealtad* sale «Vencieron … puntos: … días sin movimientos de puntos»: pasó los días de la expiración sin moverlos. Para devolvérselos, usa *Ajustar Puntos*.
- Si devuelves una venta cuyos puntos ya vencieron, al cliente no se le quitan los puntos que ganó después.
