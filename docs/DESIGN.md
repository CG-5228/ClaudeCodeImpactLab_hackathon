# StopCode dashboard design system

Generated with the UI/UX Pro Max skill (`search.py "developer wellbeing productivity dashboard calm dark mode boundaries recovery" --design-system -p StopCode --variance 3 --motion 2 --density 6`) and adapted for a calm, boundary-respecting product.

- **Style:** Minimalism / Swiss. Clean grid, generous whitespace, high contrast, no decorative effects. Dark mode is the default; a light theme is optional, never required.
- **Voice:** calm, factual, short. No streaks, scores, leaderboards, confetti, or urgency.
- **Primary action:** one per screen. On Today it is **Clock out**.

## Tokens (CSS custom properties)

```css
:root {
  --color-bg: #0F172A;            /* page */
  --color-surface: #1B2336;       /* cards */
  --color-surface-2: #222B40;     /* nested surfaces, inputs */
  --color-muted: #272F42;         /* subtle fills */
  --color-border: #334155;        /* 1px borders */
  --color-border-strong: #475569;
  --color-fg: #F1F5F9;            /* body text, 14.9:1 on bg */
  --color-fg-muted: #94A3B8;      /* secondary text, 6.9:1 on bg */
  --color-fg-subtle: #CBD5E1;     /* labels */
  --color-accent: #22C55E;        /* primary CTA (Clock out), on-accent #0F172A */
  --color-accent-hover: #16A34A;
  --color-on-accent: #0F172A;
  --color-rest: #A78BFA;          /* quiet hours / parked states */
  --color-warn: #F59E0B;          /* after-hours, stale evidence, degraded */
  --color-danger: #EF4444;        /* destructive actions, failures */
  --color-info: #38BDF8;          /* integration events */
  --color-ring: #F8FAFC;          /* 2px focus ring + 2px offset */
  --font-sans: "IBM Plex Sans", "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, "Cascadia Code", Consolas, monospace;
  --text-xs: 0.75rem; --text-sm: 0.875rem; --text-base: 1rem; --text-lg: 1.125rem; --text-xl: 1.375rem; --text-2xl: 1.75rem;
  --leading-body: 1.55;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 24px; --space-6: 32px; --space-7: 48px;
  --radius-sm: 6px; --radius-md: 10px; --radius-lg: 14px;
  --shadow-1: 0 1px 2px rgba(0,0,0,.4);
  --dur-fast: 150ms; --dur-base: 220ms; --ease: cubic-bezier(.2,.7,.2,1);
}
```

No web-font downloads: the dashboard makes no external requests. The font stacks fall back to system fonts.

## Rules

- Contrast ≥ 4.5:1 for all text (muted text on cards is #94A3B8 on #1B2336 ≈ 6.1:1). Status is never conveyed by colour alone: every chip has a text label.
- Visible focus: `:focus-visible { outline: 2px solid var(--color-ring); outline-offset: 2px; }` on every control. Never remove outlines.
- Keyboard: tablist with roving tabindex (Left/Right/Home/End), Escape closes dialogs, dialogs trap focus and return it to the opener, a skip link to `#main`.
- Motion: only opacity/transform, ≤ 220ms, `@media (prefers-reduced-motion: reduce)` disables transitions.
- Touch targets ≥ 44×44 CSS px for primary controls; ≥ 24×24 for inline ones.
- Responsive breakpoints 375 / 768 / 1024 / 1440. Single column under 768, two columns from 1024.
- Icons: inline SVG (Lucide-style, 1.5px stroke) with `aria-hidden="true"` next to text, or `aria-label` when alone. No emoji as icons.
- Empty states say what is missing and what would fill it ("No activity observed yet. Start Claude Code with the plugin loaded."). Error states include a retry.
- Numbers use `font-variant-numeric: tabular-nums`.
- Chips: `verified` (accent outline), `reported complete` (warn outline), `in progress` (info outline), `not started` (muted), `blocked` (danger outline), `stale` (warn), `parked` (rest).
