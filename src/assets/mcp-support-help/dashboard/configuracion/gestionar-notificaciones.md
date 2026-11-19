---
title: Gestionar notificaciones
description: Revisa alertas del Dashboard y ajusta preferencias de notificación.
product: dashboard
category: configuracion
featureCode: AVOQADO_SETTINGS
dashboardRoutes:
  - notifications
  - notifications/preferences
roles:
  - OWNER
  - ADMIN
  - MANAGER
lastVerified: 2026-05-21
sourceRepo: avoqado-web-dashboard
relatedArticles:
  - editar-perfil
  - configurar-datos-local
keywords:
  - notificaciones
  - preferencias de notificación
  - alertas del dashboard
  - no me llegan avisos
  - recibo demasiadas notificaciones
  - aviso de otra sucursal
---

## Antes de empezar

Notificaciones tiene dos usos: revisar avisos que ya llegaron y decidir qué eventos debe recibir cada usuario. Antes de cambiar preferencias, separa alertas personales de alertas operativas del local. Un OWNER puede necesitar avisos de billing o configuración, mientras que un MANAGER puede necesitar ventas, pedidos, inventario o reservaciones.

También confirma que el usuario tenga correo correcto en su perfil. Si el canal de contacto está mal, cambiar preferencias no resolverá que el aviso llegue a la persona correcta.

## Pasos

1. Abre **Notificaciones** para revisar avisos recientes del Dashboard.
2. Identifica si el aviso aplica a tu usuario, al local o a una acción pendiente.
3. Si necesitas ajustar qué recibes, abre **Configuración > Notificaciones > Preferencias**.
4. Activa o desactiva categorías según la responsabilidad del usuario.
5. Guarda los cambios y vuelve a revisar después de la siguiente operación relevante.
6. Si administras al equipo, combina esta configuración con permisos y roles para que cada persona vea solo lo necesario.

## Problemas frecuentes

Si no recibes avisos, revisa primero perfil, correo y preferencias. Si recibes demasiados avisos, desactiva categorías no operativas en vez de silenciar todo. Si no ves preferencias, puede faltar permiso de configuración. Si una notificación menciona una sucursal distinta, confirma que tu usuario tenga acceso a varias sucursales y revisa cuál está activa.

## Recomendaciones por rol

OWNER y ADMIN suelen mantener alertas de pagos, facturación, integraciones, permisos y cambios del local. MANAGER suele enfocarse en operación diaria, como pedidos, reservaciones, equipo, inventario o eventos que requieren acción durante servicio. Los usuarios con acceso de solo consulta deberían recibir menos avisos para evitar ruido.

Evita usar notificaciones como reemplazo de procesos internos. Si algo requiere aprobación, define quién responde y en cuánto tiempo. El Dashboard puede avisar, pero el equipo necesita una regla clara para actuar.

## Cuándo pedir ayuda

Pide soporte si una preferencia guardada vuelve a su estado anterior, si varios usuarios dejan de recibir el mismo tipo de aviso o si una notificación llega con datos incorrectos. Incluye usuario, venue, tipo de alerta, fecha aproximada y captura de preferencias.
