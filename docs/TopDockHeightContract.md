# Top Dock Height Contract v1

Status: Approved for implementation by Master on 2026-08-12.

## Purpose

Keep the HumStudio Top Dock at one stable height while switching between MAIN, PIANO ROLL, and MIXER. The browser content viewport may resize, but every Dock must resolve to the same height for the same viewport.

## Normal Workspace Contract

The current MAIN Dock responsive height is the authority:

```css
--top-dock-content-height: clamp(484px, calc(54dvh + 164px), 754px);
```

The Top Dock viewport owns the outer height. Its border and vertical padding add 13 px to the shared content height.

MAIN, PIANO ROLL, MIXER, and any future Top Dock must use the shared content height rather than defining an independent normal-workspace cap.

For representative browser content viewport heights:

| Viewport height | Shared Dock content height |
| ---: | ---: |
| 720 px | 552.8 px |
| 768 px | 578.72 px |
| 960 px | 682.4 px |
| 1080 px | 747.2 px |
| 1093 px and above | 754 px |

Browser viewport height, not monitor resolution, controls the resolved CSS size. Browser chrome, fullscreen state, zoom, and window resizing may change the viewport height.

## Responsive Content Policy

- Dock switching must not change the Top Dock outer height, Timeline position, or document scroll position.
- Timeline expansion must preserve the page scrollbar gutter so Header and Dock outer widths do not change.
- The Top Dock viewport must reserve one stable scrollbar gutter in both normal and split modes so Dock content does not shift horizontally when scrolling becomes active.
- At desktop widths, each active Dock fills the shared content slot.
- At compact widths where MAIN panels stack, the Top Dock viewport retains the shared outer height and scrolls its content internally.
- Dock-specific content may own nested scrolling only when required by its established interaction model.
- Content overflow must never increase the outer Top Dock height.

## Split Workspace Contract

The existing split-workspace Top Dock viewport remains bounded by its compact responsive height:

```css
height: calc(clamp(180px, 28vh, 300px) + 13px);
```

MAIN and PIANO ROLL use compact panel geometry. MIXER retains its normal outer panel height and scrolls as a whole inside the bounded Top Dock viewport. Its Console Overview uses a fixed 313 px height and its Volume meter/fader level section uses a fixed 196 px height in both normal and split modes. The released 20 px is permanently reassigned to the Effects workspace. These Mixer dimensions do not vary with the browser viewport or Timeline expansion state.

## Acceptance Criteria

- MAIN, PIANO ROLL, and MIXER normal-workspace Top Dock outer heights differ by no more than 0.5 px at 1280x720, 1366x768, and 1920x1080 viewports.
- Switching Docks does not change `window.scrollY` or the Timeline top position.
- Expanding or collapsing the Timeline does not change the Header width, Top Dock outer width, or Top Dock content width.
- The normal Timeline height contract remains unchanged.
- The split Timeline height contract remains unchanged.
- At the approved 1920x1080 review layout, the fixed split-mode Mixer Volume meter and fader indicators end above the expanded Timeline edge.
- Expanding or collapsing the Timeline does not change Mixer Console, Volume meter/fader, or Effects workspace heights.
- The fixed 20 px Mixer Console reduction increases the Effects workspace in both modes.
- All Dock content remains reachable through the intended internal scroll container.
- No Dock defines a separate normal-workspace maximum height.

## Non-Goals

- This contract does not redesign MAIN, PIANO ROLL, or MIXER internal controls.
- This contract does not change Timeline height, Timeline expansion, Mixer routing, DSP, Playback, or Mixdown behavior.
