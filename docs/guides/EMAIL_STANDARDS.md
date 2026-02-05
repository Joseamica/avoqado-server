# Email Template Standards - Claude Operational Guide

> Rules for creating/modifying email templates. All templates live in `src/services/email.service.ts`.

---

## Design Specs

| Element | Value |
|---------|-------|
| Background | White `#ffffff` |
| Text color | Black `#000000` |
| Link color | Blue `#1a73e8` |
| Border color | Light gray `#e0e0e0` |
| Font family | `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif` |
| Logo URL | `https://avoqado.io/isotipo.svg` |
| Max width | `600px` |
| Border radius | `8px` content boxes, `4px` buttons |
| Warning boxes | Background `#fef3c7`, color `#92400e` |

---

## Required HTML Structure

```html
<!-- Header -->
<div style="padding-bottom: 32px;">
  <img src="https://avoqado.io/isotipo.svg" alt="Avoqado" width="32" height="32">
  <span style="font-size: 18px; font-weight: 700; color: #000;">Avoqado</span>
</div>

<!-- Title -->
<h1 style="font-size: 32px; font-weight: 400; color: #000;">Email Title</h1>

<!-- Content box -->
<div style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px;">
  <!-- Content -->
</div>

<!-- CTA Button (black bg) -->
<a href="#" style="background: #000; color: #fff; padding: 14px 32px; border-radius: 4px; font-weight: 600;">
  Button Text
</a>

<!-- Footer -->
<hr style="border-top: 1px solid #e0e0e0;">
<div>
  <img src="https://avoqado.io/isotipo.svg" width="24" height="24">
  <span>Avoqado</span>
  <p>Footer text</p>
  <a href="https://avoqado.io/privacy">Politica de Privacidad</a>
</div>
```

---

## Strict Rules

1. **NO emojis** in subjects or content
2. **NO gradients** or colored backgrounds
3. **NO accented characters** (use `a` instead of `a` with accent for email client compat)
4. **Always include** Avoqado logo in header AND footer
5. **Always include** privacy policy link in footer
6. **Inline styles only** - email clients don't support external CSS

---

## Testing

```bash
npx ts-node scripts/test-all-emails.ts
```
