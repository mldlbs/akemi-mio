# Living Workbench UI Design

Date: 2026-08-07

## Problem

Akemi Mio already has a distinctive paper-workbench direction: warm white surfaces, etched lines, serif display type, muted vermilion accents, and a calm desktop assistant tone. The current UI also has the right structural pieces: top bar, session rail, main chat/work area, bottom input bar, and right-side workbench.

The weak point is that the interface still feels more like a static Electron chat shell than a living assistant workspace. Important system states are present but visually quiet, tool execution feels detached from the input action, and the right panel behaves like a simple tabbed drawer instead of a place where observation, memory, execution, and bookmarks become legible.

The design goal is to make the UI feel more forward-looking through interaction, hierarchy, and state choreography, while preserving the existing quiet paper identity.

## Goals

1. Turn the existing shell into a "living workbench" where assistant state, tool work, memory, and user intent are visible without becoming noisy.
2. Make the right panel feel like a real execution and observation column, not a generic drawer.
3. Make the input bar feel like a command surface with clear idle, composing, thinking, executing, and approval states.
4. Preserve the product personality: calm, literate, focused, and slightly futuristic.
5. Keep the first implementation scoped to renderer UI and CSS, with minimal behavioral risk.

## Non-goals

1. Rebuilding the full chat message renderer.
2. Changing agent routing, tool semantics, IPC contracts, storage, or voice pipelines.
3. Introducing a new UI framework or a large component library.
4. Replacing the current paper visual system with a dark cockpit or marketing-style layout.
5. Solving every settings or workflow screen in the first pass.

## Visual Direction

### Frontend design log

- Style: Resonant Stark with editorial workbench details.
- Color archetype: Mineral paper base with vermilion, aged gold, moss, and steel accents.
- Font pair: Newsreader for display, Noto Sans SC/Aptos for body, Cascadia Code for instrument labels.
- Layout archetype: Narrow rail plus flat third column.
- Motion pattern: Staggered reveal, fine-line scan, restrained state pulse.

### Principles

The interface should feel like a precise paper instrument, not a decorative dashboard.

Use:

- very thin dividing lines
- high-quality spacing
- tabular numeric labels for status
- compact typographic scales inside panels
- subtle state rails and progress strokes
- restrained vermilion/gold accents for decisions and action
- cool steel/moss accents for observation and memory

Avoid:

- floating card stacks inside other cards
- large frosted glass panels
- purple-blue gradient defaults
- oversized hero typography in tool surfaces
- decorative blobs, bokeh, or unrelated atmospheric effects

## Proposed Design

### 1. Shell as a three-zone workbench

The desktop layout remains three zones:

1. Left rail: session and mode index.
2. Main surface: chat, writing, previews, workflows, and active content.
3. Right workbench: execution, observation, memory, and bookmarks.

The important visual change is that the three zones should feel intentionally bound together. The left rail can keep a flat paper background, the main area can keep its generous reading surface, and the right panel should become the active instrument column with stronger hierarchy and state.

### 2. Right workbench redesign

`RightPanel` becomes the main focus of the first pass.

Header:

- Keep a compact title, but add a system-state strip that communicates the current mode.
- Replace equal-weight tab labels with a clearer instrument navigation pattern.
- Active tab should read as a selected working lane, not just a colored underline.

Evolution tab:

- Treat evolution as the top operational summary.
- Surface stage, progress, queue, safety mode, last run, and current plan as a compact status stack.
- Make the progress line feel like a live system trace, with a restrained pulse only while running.
- Keep manual trigger available, but visually separate it from passive status.

Monitor tab:

- Group behavior state, active plan, resources, lock status, and recent changes into scanning rows.
- Use dense row layouts instead of card-heavy blocks.
- Make locked/unlocked state immediately legible without relying on text alone.

Tools tab:

- Convert tool buttons into a command list with lifecycle states.
- Clicking a command with required input opens an inline input row under that command.
- Running tools should show queued/running/success/error states in the same surface as the command.
- Feedback should be concise and time-bound.

Memory tab:

- Present memory cards as small editorial notes with tier, confidence, pinned state, and topics.
- Keep text truncation stable so cards do not resize awkwardly.
- Empty state should feel calm and useful.

Bookmarks tab:

- `BookmarkPanel` should inherit the right workbench language.
- Search becomes an etched input line.
- Bookmark items should show play/favorite/delete actions as icon controls with clear hover and active states.
- Playing state should be visible through a slim rail or waveform-like stroke, not a large color fill.

### 3. Input bar as command surface

`InputBar` should become the most tactile interaction surface.

Idle:

- Quiet etched input lane.
- Voice and writing controls remain compact and icon-first.
- Send button stays subdued until the user has input.

Composing:

- Input lane gains a thin focus beam using vermilion to gold.
- Send button becomes more assertive but still paper-like.

Thinking or tool execution:

- Show a fine top progress stroke or subtle animated scan line.
- Stop button becomes visually clear without feeling alarming.
- If the assistant is executing tools, show a short status phrase near the input surface when available.

Voice intent approval:

- The current intent card becomes a command approval slip.
- Primary action should be visually distinct from "send as chat" and dismiss.
- Tool sequence should be readable as compact chips or inline codes.

### 4. Top bar and workbench entry

`TopBar` should make the right workbench feel like part of the core product.

- Keep the logo and status area calm.
- Make the workbench trigger use the same state language as the right panel.
- When the panel is open, the trigger should read as active without becoming bulky.
- Slot dropdown should stay practical and compact.

### 5. Motion and responsiveness

Motion should clarify state changes.

- Right panel opens with a slight lateral reveal and content cascade.
- Tab changes should crossfade rows or use a short upward reveal.
- Running progress strokes can animate slowly.
- Hover motion should be minimal: small color or line changes, not moving layouts.
- Respect `prefers-reduced-motion`.

Responsive behavior:

- At small widths, opening the right workbench should replace the main area rather than squeezing it.
- The input bar should remain reachable when the main chat is active.
- When the workbench owns the screen on mobile, the input bar can be hidden as it is now.
- Fixed-format controls need stable dimensions so icon buttons and labels do not shift layout.

## Component Scope

First implementation pass:

- `src/renderer/src/components/RightPanel.tsx`
- `src/renderer/src/components/BookmarkPanel.tsx`
- `src/renderer/src/components/InputBar.tsx`
- `src/renderer/src/components/TopBar.tsx`
- `src/renderer/src/styles/tokens.css`
- `src/renderer/src/styles/workbench.css`
- related existing component CSS where necessary

Optional only if needed:

- `src/renderer/src/styles/components.css`
- `src/renderer/src/styles/layout.css`
- focused renderer tests that already cover the edited components

## Data Flow

No new backend data contracts are required for the first pass.

Existing state sources remain:

- `useSlots()` for active slot, sidebar, and right panel state
- `useDesktopToolbarStore()` for tool tasks and feedback
- Electron IPC dashboard streams for evolution, monitoring, memory, and behavior state
- `useBookmarkStore()` for bookmark list, search, favorite, delete, and loading state
- `useAgentStore()` for input busy states

UI changes should map existing state into clearer visual states. If a state is missing, the UI should degrade to an explicit empty or idle state rather than pretending live data exists.

## Error Handling

The first pass should not change error semantics.

UI expectations:

- Tool failure appears in the tool command list and feedback strip.
- Bookmark audio playback failure keeps the existing TTS fallback behavior.
- Missing dashboard data shows calm empty states.
- IPC errors should not break rendering.
- Loading indicators should not cause layout jumps.

## Accessibility

The design remains icon-forward, but controls must still be understandable.

Requirements:

- preserve or add `aria-label` for icon-only controls
- keep visible focus styles for keyboard users
- do not rely on color alone for active, locked, running, or error states
- maintain readable contrast on paper surfaces
- keep button hit targets stable and usable on touch screens
- respect reduced motion preferences

## Testing

### Static verification

- Type-check renderer code.
- Run existing renderer component tests if edited behavior affects tested components.
- Scan CSS for accidental palette drift into purple/blue gradient or dark cockpit styling.

### Visual verification

Use local screenshots after implementation:

- desktop with right workbench closed
- desktop with right workbench open on each major tab
- mobile width with right workbench closed
- mobile width with right workbench open
- input bar idle, focused, busy, and voice intent states if easy to trigger

### Behavioral verification

Confirm:

- right panel opens and closes
- tabs switch without layout collapse
- tool input rows open, submit, and cancel as before
- bookmark search, play, favorite, delete controls still call existing handlers
- input send/stop behavior remains unchanged
- mobile workbench takeover still hides the main area and input bar when appropriate

## Risks

1. The UI could become visually more complex without improving workflow.
Mitigation:
- prefer dense rows and line hierarchy over more cards
- keep the first pass focused on state clarity

2. Styling changes could affect unrelated slots.
Mitigation:
- scope workbench-specific rules under existing workbench and component classes
- avoid broad global selectors

3. The current text in some renderer files appears mojibake in the workspace.
Mitigation:
- avoid unnecessary text rewrites
- change labels only when the surrounding file encoding is safe to edit
- focus early implementation on structure and CSS when possible

4. Motion could distract from repeated desktop use.
Mitigation:
- keep animations short and state-driven
- honor `prefers-reduced-motion`

## Rollout Plan

1. Refine workbench tokens and CSS primitives.
2. Redesign the `RightPanel` header, tabs, and section layouts.
3. Align `BookmarkPanel` with the right workbench language.
4. Upgrade `InputBar` states and voice intent approval styling.
5. Tune `TopBar` workbench trigger.
6. Verify desktop and mobile screenshots.
7. Run type-check and targeted tests.

## Recommendation

Implement the first pass as a focused renderer/UI change under the Living Workbench concept.

The highest-value move is to make the right workbench and input surface feel connected: the user gives intent at the bottom, the assistant shows execution and memory on the right, and the main surface stays quiet enough for reading and creation.
