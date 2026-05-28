# Email Template Standards - Claude Operational Guide

> Rules for creating/modifying email templates. Templates live in `src/services/email.service.ts` (most operational mail) and
> `src/services/resend.service.ts` (admin/onboarding digests).
>
> **The canonical visual reference is** `sendLowStockDigestEmail` in `email.service.ts` (the "Alertas de bajas existencias" email). Copy its
> structure when adding a new template.

---

## Design Specs

| Element              | Value                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------- |
| Background           | White `#ffffff`                                                                              |
| Text color           | Black `#000000`                                                                              |
| Muted text           | Gray `#666666` (secondary info, section labels)                                              |
| Subtle text          | Light gray `#999999` (footer disclaimers)                                                    |
| Link color           | Blue `#1a73e8`                                                                               |
| Table border         | Light gray `#e5e7eb`                                                                         |
| Inline-code bg       | `#f3f4f6`                                                                                    |
| Font family          | `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif` |
| Logo URL             | `https://avoqado.io/isotipo.svg` (32×32 header, 24×24 footer)                                |
| Max width            | `600px`                                                                                      |
| Border radius        | `8px` tables/content boxes, `6px` buttons                                                    |
| Title                | `28px`, weight `400`, color `#000`                                                           |
| Section labels (H2)  | `13px`, weight `600`, color `#666`, `text-transform: uppercase`, `letter-spacing: 0.5px`     |
| Table-row label cell | `13px`, color `#666`, width `160px`                                                          |
| Table-row value cell | `14px`, color `#000`                                                                         |
| Warning boxes        | Background `#fef3c7`, color `#92400e`                                                        |

---

## CTAs are ALWAYS black

```html
<a
  href="{url}"
  style="display:inline-block;background-color:#000000;color:#ffffff;
         padding:12px 24px;border-radius:6px;text-decoration:none;
         font-size:14px;font-weight:600;"
>
  Button label
</a>
```

No blue, no gradients, no brand-purple. Black background, white text. Same button on every template so users learn to recognize a "primary
action".

---

## Required HTML Structure

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{subject}</title>
  </head>
  <body
    style="font-family:-apple-system,...;line-height:1.6;margin:0;padding:0;
              background-color:#ffffff;color:#000000;"
  >
    <div style="max-width:600px;margin:0 auto;padding:32px 24px;">
      <!-- Header with Logo -->
      <div style="padding-bottom:32px;">
        <img
          src="https://avoqado.io/isotipo.svg"
          alt="Avoqado"
          width="32"
          height="32"
          style="display:inline-block;vertical-align:middle;"
        />
        <span style="font-size:18px;font-weight:700;color:#000;vertical-align:middle;margin-left:8px;">Avoqado</span>
      </div>

      <!-- Title + date -->
      <h1 style="margin:0 0 8px 0;font-size:28px;font-weight:400;color:#000;line-height:1.2;">{title}</h1>
      <p style="margin:0 0 24px 0;font-size:14px;color:#666;">{dateCapitalized}</p>

      <!-- Body content + section tables here -->
      <h2
        style="margin:32px 0 12px;font-size:13px;font-weight:600;color:#666;
                  text-transform:uppercase;letter-spacing:0.5px;"
      >
        Section Label
      </h2>
      <table
        cellpadding="0"
        cellspacing="0"
        style="width:100%;border-collapse:collapse;
                                                  border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;"
      >
        <tr>
          <td style="padding:12px 16px;border-bottom:1px solid #e5e7eb;width:160px;font-size:13px;color:#666;">Label</td>
          <td style="padding:12px 16px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#000;">Value</td>
        </tr>
      </table>

      <!-- CTA Button (ALWAYS black) -->
      <div style="margin:32px 0;text-align:left;">
        <a
          href="{url}"
          style="display:inline-block;background-color:#000000;color:#ffffff;
                                  padding:12px 24px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;"
        >
          {Action Label}
        </a>
      </div>

      <!-- Divider -->
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0;" />

      <!-- Footer -->
      <div style="padding-top:8px;">
        <div style="margin-bottom:16px;">
          <img
            src="https://avoqado.io/isotipo.svg"
            alt="Avoqado"
            width="24"
            height="24"
            style="display:inline-block;vertical-align:middle;"
          />
          <span style="font-size:14px;font-weight:700;color:#000;vertical-align:middle;margin-left:6px;">Avoqado</span>
        </div>
        <p style="margin:0 0 8px 0;font-size:12px;color:#999;">Servicios Tecnologicos Avo S.A. de C.V.</p>
        <p style="margin:0;font-size:12px;color:#999;">{disclaimer or unsubscribe link}</p>
      </div>
    </div>
  </body>
</html>
```

---

## Strict Rules

1. **NO emojis** in subject lines or H1 titles. Status icons in the body are OK if they replace a status word (e.g. `✓ Approved`), but **not
   decorative ones**.
2. **NO gradients** or vivid section backgrounds. No purple, no green hero, no dark-mode hero. White body, black text. Section dividers via
   `<h2>` labels above tables.
3. **NO emoji-only section headers.** Use uppercase muted-gray H2 labels (see "Section Labels" above).
4. **NO colored CTAs.** Buttons are always black background, white text, border-radius 6px.
5. **NO accented characters in plain-text body** (use `&iacute;` etc. in HTML for maximum compat, plain ASCII in `text:` body).
6. **Always include** the Avoqado isotipo in BOTH header (32px) AND footer (24px).
7. **Always include** the legal-entity line `Servicios Tecnologicos Avo S.A. de C.V.` in the footer.
8. **Inline styles only** — email clients ignore external CSS.
9. **Both `html` and `text` bodies** every time. Some clients block HTML.
10. **Subject under 60 chars** and front-load the recognizable token (`{venueName}: ...` reads better than
    `Avoqado notification: {venueName}`).

---

## Migration backlog (legacy templates that still need the standard treatment)

These predate the standard and use purple/green/dark gradient heroes. They still work but should be rewritten the next time they're touched:

| File                          | Function                        | Current sin                                 |
| ----------------------------- | ------------------------------- | ------------------------------------------- |
| `resend.service.ts`           | `sendKycSubmissionNotification` | Purple gradient header, emoji-only sections |
| `resend.service.ts`           | `sendKycDocumentsToBlumon`      | Dark-blue gradient header                   |
| `resend.service.ts`           | `sendPurchaseOrderEmail`        | Green gradient hero box                     |
| `email.service.ts:~1500-1800` | TPV-related alerts              | Mixed (some compliant, some not)            |

When a customer-visible email gets reworked, do the design migration in the same PR — don't leave a half-styled product.

---

## Testing

```bash
# Send all templates to a sandbox inbox and screenshot diff
npx ts-node scripts/test-all-emails.ts

# Quick unit-test of a single template's structural assertions
npx jest tests/unit/services/resend.newVenueDigest.test.ts
```

When you add a template, add a unit test asserting:

- Subject does not contain emoji
- HTML contains the Avoqado logo URL twice (header + footer)
- HTML contains `background-color:#000000` (the CTA button)
- Plain-text `text` body is non-empty and contains the title
