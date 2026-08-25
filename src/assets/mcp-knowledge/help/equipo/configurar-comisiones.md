---
title: Configurar comisiones
description: Administra reglas y seguimiento de comisiones del equipo.
product: dashboard
category: equipo
featureCode: AVOQADO_COMMISSIONS
dashboardRoutes:
  - commissions
roles:
  - OWNER
  - ADMIN
  - MANAGER
lastVerified: 2026-05-20
sourceRepo: avoqado-web-dashboard
relatedArticles:
  - gestionar-miembros
  - gestionar-turnos
---

## Antes de empezar

Comisiones debe configurarse con reglas claras. Antes de crear o modificar una regla, define a quien aplica, sobre que ventas se calcula, con que frecuencia se revisa y quien aprueba cambios. Una regla mal definida puede generar diferencias con el equipo o afectar reportes de rentabilidad.

Revisa primero roles, miembros activos y fuentes de venta. Si el equipo rota entre sucursales, confirma si la comision aplica por local o por usuario.

## Pasos

1. Abre **Equipo > Comisiones**.
2. Revisa las configuraciones existentes antes de crear una nueva.
3. Define periodo, miembros incluidos, condiciones y estado de la regla.
4. Guarda cambios y valida que aparezcan en el listado.
5. Revisa pagos o reportes relacionados para confirmar que el calculo tenga sentido.
6. Comunica internamente cualquier cambio antes de usarlo para pagos al equipo.

## Problemas frecuentes

Si una comision no aparece, revisa periodo, miembro y estado de configuracion. Si el calculo no coincide, valida si se basa en ventas brutas, netas, propina, producto o meta. Si no puedes crear reglas, falta permiso de comisiones. Si hay dudas de pago, conserva evidencia del periodo revisado.

## Validacion antes de pagar

Antes de usar una comision para pago real, compara la regla contra ventas del periodo y confirma que los miembros incluidos sean correctos. Si la comision depende de productos, categorias, propinas o metas, revisa una muestra manual para confirmar que la logica coincide con el acuerdo interno.

Evita cambiar reglas historicas sin registrar motivo. Si una regla nueva reemplaza a otra, conserva fechas de vigencia para explicar por que un periodo fue calculado diferente.

## Cuando pedir ayuda

Escala si el calculo no se explica despues de revisar regla, periodo y ventas base, o si una regla activa no genera resultados. Comparte nombre de regla, periodo, miembros afectados y captura de la configuracion.
