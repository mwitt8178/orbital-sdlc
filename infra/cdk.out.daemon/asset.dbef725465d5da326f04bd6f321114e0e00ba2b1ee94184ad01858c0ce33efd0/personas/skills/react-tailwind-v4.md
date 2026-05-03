# Skill: React + Tailwind v4

Tailwind v4 is a ground-up rewrite. The mental model is **CSS-first
configuration**, not a JS config file. Treat it as such.

## What changed from v3

- No `tailwind.config.js`. Configuration lives in CSS via `@theme`.
- Single `@import "tailwindcss";` replaces the three `@tailwind` directives.
- Custom tokens are CSS variables under `@theme`. They generate utilities
  automatically.

## Setup

```css
/* src/index.css */
@import "tailwindcss";

@theme {
  --font-sans: 'Inter', sans-serif;
  --color-brand-500: oklch(60% 0.2 250);
  --color-brand-600: oklch(52% 0.2 250);
  --radius-card: 0.75rem;
  --spacing-18: 4.5rem;
}
```

Each variable becomes a utility:
- `--color-brand-500` → `bg-brand-500`, `text-brand-500`, `border-brand-500`
- `--spacing-18` → `p-18`, `mt-18`, `gap-18`
- `--radius-card` → `rounded-card`

## Rules

- **Utility-first, always.** Avoid `@apply` except for unavoidable cases
  (third-party HTML you cannot control). If you reach for it, reconsider.
- **CSS variables over arbitrary values.** Recurring value? Define it under
  `@theme`. Prefer `p-18` over `p-[4.5rem]`.
- **No `tailwind.config.js`.** Do not create or reference one.
- **Mobile-first responsive.** Base style is mobile; layer breakpoints with
  `md:`, `lg:`, etc.
- **`oklch` for custom colors.** Tailwind v4 uses `oklch` internally; this
  enables opacity modifiers (`bg-brand-500/50`).

## Class organization

Use `prettier-plugin-tailwindcss` to enforce canonical order. Manual order:
1. Layout (flex, grid, hidden)
2. Position (relative, absolute, z-10)
3. Sizing (w-full, h-12, max-w-xl)
4. Spacing (p-4, mt-2, gap-3)
5. Typography (text-sm, font-semibold)
6. Color (bg-white, text-gray-900)
7. Effects (shadow-md, rounded-card, transition)

## React component example

```jsx
import clsx from 'clsx'

function Button({ variant = 'primary', children, ...props }) {
  return (
    <button
      className={clsx(
        'inline-flex items-center rounded-md px-4 py-2 text-sm font-medium transition',
        {
          'bg-brand-600 text-white hover:bg-brand-700': variant === 'primary',
          'bg-white text-gray-800 border border-gray-300 hover:bg-gray-50':
            variant === 'secondary',
          'text-red-600 hover:bg-red-50': variant === 'danger',
        },
      )}
      {...props}
    >
      {children}
    </button>
  )
}
```

## Custom variants and utilities

```css
@variant dark (&:where(.dark, .dark *));
@variant hocus (&:hover, &:focus-visible);

@utility content-auto {
  content-visibility: auto;
}
```

## Overriding the theme

To replace defaults entirely, set to `initial` first:

```css
@theme {
  --color-gray-*: initial;
  --color-gray-100: oklch(97% 0.003 260);
  --color-gray-900: oklch(18% 0.01 260);
}
```

## Anti-patterns

- A `tailwind.config.js` file appearing somewhere in the repo. It does
  nothing in v4.
- `@apply` chains in a separate stylesheet — that is the v3 way. Just put
  the utilities on the element.
- Arbitrary values everywhere (`p-[13px]`, `bg-[#abc123]`). Define them in
  `@theme` once.
