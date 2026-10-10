# Embernest design system

Direction: calm, modern, content-first. A neutral base (near-black slate in dark, off-white in light) with **one** warm
ember/amber accent, used sparingly: primary buttons, the active nav item, focus rings and sliders. Subtle borders instead of
heavy shadows. Review everything in `src/web/styleguide.html` (not linked from the app).

Files: `src/web/css/tokens.css` (the only place with raw colours), `base.css`, `components.css`, `layout.css`, `screens.css` (Create, Models, Settings), `chat.css` (Chat) and `guide.css` (model guide: welcome, suggestions, explainers, hints). Chat logic is in `src/web/js/chat.js`.
`src/web/js/theme.js` handles the theme.

## Tokens

Theme is `<html data-theme="auto|light|dark">`, stored per device in `localStorage` (`pixelkilnTheme`).
`?theme=light|dark` overrides it for one page load (used for screenshots).

| Role | Dark | Light |
|---|---|---|
| `--bg` | #0d0f12 | #f6f5f2 |
| `--surface` | #14171b | #ffffff |
| `--surface-2` | #1b1f25 | #f1efeb |
| `--border` | #272c34 | #e3e0da |
| `--text` | #e9ebee | #1b1c1f |
| `--text-muted` | #8e97a3 | #5d6570 |
| `--accent` | #f59e0b | #b45309 |
| `--accent-text` (on accent) | #1a1203 | #ffffff |
| `--accent-ink` (accent as text) | #fbbf5a | #9a4507 |
| `--danger` / `--success` / `--warning` | #f87171 / #4ade80 / #fbbf24 | #b91c1c / #15803d / #a16207 |

Body and muted text meet WCAG AA on their surfaces in both themes.

- **Spacing:** 4px scale, `--space-1` (4) to `--space-12` (48).
- **Radii:** `--r-sm` 8, `--r-md` 10, `--r-lg` 12, `--r-pill`.
- **Shadows:** `--shadow-sm`, `--shadow-md`; only for floating things (sheet, dialog, toast).
- **Type:** system font stack, mono for code and numbers. Body 15px, line height 1.55; scale `--fs-xs` to `--fs-2xl`.
- **Motion:** `--dur-fast` 120ms, `--dur` 200ms, `--dur-slow` 320ms. All go to 0 under `prefers-reduced-motion`.
- **Tap target:** `--tap` 44px minimum for anything pressable.

## Components

- **Button:** `.btn` secondary; `.btn-primary` (one per view); `.btn-ghost`; `.btn-danger`; `.btn-icon`; sizes `.btn-sm`, `.btn-lg`.
- **Input, select, textarea:** 44px tall, 16px text (no iOS zoom), accent focus ring. **Switch:** `label.toggle`. **Slider:** `input[type=range]`.
- **Segmented control:** `.segmented` with children marked `aria-current="page"` (links) or `aria-pressed="true"` (buttons). **Tabs:** `.tabbar`.
- **Card:** `.card`, 1px border, 12px radius. **Chip:** `.chip` (toggle with `aria-pressed`). **Badge/pill:** `.badge-*`, `.pill`.
- **Sheet:** `.scrim > .sheet`, a bottom sheet on phone and a side panel on desktop with `.scrim.is-side`. **Dialog:** `.dialog`.
- **Toast:** `.toast` with `is-ok` / `is-error`; sits above the bottom nav on phone.
- **Empty state:** `.empty`. **Skeleton:** `.skeleton`. **Note:** `.note`, `.note-info`, `.note-danger`. **Progress:** `.progress`.

## Layout

- Desktop (>= 768px): left sidebar with the app name, four nav items (Chat, Create, Models, Settings) and the engine status.
- Phone (< 768px): slim top bar (name and status) and a bottom nav with the same four items. At most five items; Settings is one of them.
- Create has a segmented switch: Generate, Transform, Edit.
- Deep links: `#tab=chat|create|models|settings`, `#tab=models&goal=<goal>` (Suggested tab), `#explain=<checkpoint|inpainting|lora|embedding|vae|families>` (opens a "What is this?" sheet), `#tab=create&mode=generate|transform|edit`, `#tab=chat&c=<conversation id>`, `#tab=chat&new=1`, `#tab=chat&persona=<id>&edit=1[&focus=memories]`. Old `#edit`-style links still work.
- Chat on phone: the list is its own screen, and opening a conversation pushes a history entry, so Back returns to the list (the chat header arrow does the same).
- Chat shows skeleton rows in the list and the pane until its first data arrives, then the empty or not-set-up states.
- Support 360px wide and up, with no horizontal page scroll. Respect `env(safe-area-inset-*)`.
