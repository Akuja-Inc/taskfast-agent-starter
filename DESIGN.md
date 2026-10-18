---
name: TaskFast agent console
description: An international airport sign system for the local console that watches and steers honest TaskFast marketplace agents.
colors:
  schiphol-yellow: "#FFCC00"
  sign-black: "#0B0B0B"
  ground: "#F2F2EF"
  panel: "#FFFFFF"
  soft-ink: "#3D3D38"
  muted-ink: "#5E5E56"
  hairline: "rgba(11,11,11,.72)"
  agent-ultramarine: "#1D4ED8"
  cli-violet: "#7C3AED"
  money-green: "#1D6B34"
  money-amber: "#B45309"
  amber-tint: "#FDF3E3"
  money-red: "#B3261E"
  code-ink: "#E9E7DC"
  env-local: "#2E5E8C"
  env-staging: "#F2C14E"
  staging-ink: "#2B2000"
  header-line: "#4A4E55"
  state-running: "#56D364"
  state-paused: "#F85149"
  ground-dark: "#131311"
  panel-dark: "#1C1C19"
  ink-dark: "#F2F1EA"
  soft-ink-dark: "#C9C8BE"
  muted-ink-dark: "#A3A298"
  hairline-dark: "rgba(242,241,234,.5)"
  agent-ultramarine-dark: "#7AA8FF"
  cli-violet-dark: "#B794F6"
  money-green-dark: "#56D364"
  money-amber-dark: "#D29922"
  amber-tint-dark: "#3A2E10"
  money-red-dark: "#F85149"
  square-dark: "#000000"
typography:
  display:
    fontFamily: "\"Segoe UI\", Frutiger, \"Frutiger Next\", Roboto, \"Helvetica Neue\", \"Noto Sans\", \"Liberation Sans\", Arial, system-ui, sans-serif"
    fontSize: "clamp(48px, 6vw, 64px)"
    fontWeight: 800
    letterSpacing: "-.02em"
    fontFeature: "tabular-nums"
  headline:
    fontFamily: "\"Segoe UI\", Frutiger, \"Frutiger Next\", Roboto, \"Helvetica Neue\", \"Noto Sans\", \"Liberation Sans\", Arial, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    letterSpacing: ".01em"
  banner:
    fontFamily: "\"Segoe UI\", Frutiger, \"Frutiger Next\", Roboto, \"Helvetica Neue\", \"Noto Sans\", \"Liberation Sans\", Arial, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    letterSpacing: ".04em"
  title:
    fontFamily: "\"Segoe UI\", Frutiger, \"Frutiger Next\", Roboto, \"Helvetica Neue\", \"Noto Sans\", \"Liberation Sans\", Arial, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.45
  body:
    fontFamily: "\"Segoe UI\", Frutiger, \"Frutiger Next\", Roboto, \"Helvetica Neue\", \"Noto Sans\", \"Liberation Sans\", Arial, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "\"Segoe UI\", Frutiger, \"Frutiger Next\", Roboto, \"Helvetica Neue\", \"Noto Sans\", \"Liberation Sans\", Arial, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  tag:
    fontFamily: "\"Segoe UI\", Frutiger, \"Frutiger Next\", Roboto, \"Helvetica Neue\", \"Noto Sans\", \"Liberation Sans\", Arial, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: ".07em"
  code:
    fontFamily: "ui-monospace, \"SFMono-Regular\", Menlo, monospace"
    fontSize: "13px"
    fontWeight: 400
rounded:
  sm: "2px"
  md: "6px"
  pill: "999px"
  circle: "50%"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  band:
    backgroundColor: "{colors.schiphol-yellow}"
    textColor: "{colors.sign-black}"
    typography: "{typography.headline}"
    padding: "8px 18px"
  band-plate:
    backgroundColor: "{colors.sign-black}"
    textColor: "#FFF"
    width: "44px"
    height: "44px"
  button-primary:
    backgroundColor: "{colors.sign-black}"
    textColor: "#FFF"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "44px"
  button-primary-dark:
    backgroundColor: "{colors.schiphol-yellow}"
    textColor: "{colors.sign-black}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "44px"
  button-outline:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.sign-black}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "44px"
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.sign-black}"
    rounded: "{rounded.md}"
    padding: "10px"
    height: "44px"
  card:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.sm}"
    padding: "16px 18px"
  card-attention:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.sm}"
    padding: "16px 18px"
  note:
    backgroundColor: "{colors.amber-tint}"
    textColor: "{colors.sign-black}"
    rounded: "{rounded.sm}"
    padding: "12px 16px"
  pre:
    backgroundColor: "{colors.sign-black}"
    textColor: "{colors.code-ink}"
    typography: "{typography.code}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
  tag:
    backgroundColor: "{colors.sign-black}"
    textColor: "#FFF"
    typography: "{typography.tag}"
    rounded: "{rounded.sm}"
    padding: "5px 8px"
  tag-warn:
    backgroundColor: "{colors.money-amber}"
    textColor: "#FFF"
    typography: "{typography.tag}"
    rounded: "{rounded.sm}"
    padding: "5px 8px"
  tag-bad:
    backgroundColor: "{colors.money-red}"
    textColor: "#FFF"
    typography: "{typography.tag}"
    rounded: "{rounded.sm}"
    padding: "5px 8px"
  sq:
    backgroundColor: "{colors.sign-black}"
    textColor: "#FFF"
    size: "28px"
  sq-agent:
    backgroundColor: "{colors.agent-ultramarine}"
    textColor: "#FFF"
    size: "28px"
  sq-you:
    backgroundColor: "{colors.schiphol-yellow}"
    textColor: "{colors.sign-black}"
    size: "28px"
  sq-cli:
    backgroundColor: "{colors.cli-violet}"
    textColor: "#FFF"
    size: "28px"
  sq-ok:
    backgroundColor: "{colors.money-green}"
    textColor: "#FFF"
    size: "28px"
  sq-warn:
    backgroundColor: "{colors.money-amber}"
    textColor: "#FFF"
    size: "28px"
  sq-bad:
    backgroundColor: "{colors.money-red}"
    textColor: "#FFF"
    size: "28px"
  sq-fix:
    backgroundColor: "{colors.money-amber}"
    textColor: "#FFF"
    size: "28px"
  sq-dismiss:
    backgroundColor: "{colors.sign-black}"
    textColor: "#FFF"
    size: "28px"
  banner-local:
    backgroundColor: "{colors.env-local}"
    textColor: "#FFF"
    typography: "{typography.banner}"
    padding: "6px 24px"
  banner-staging:
    backgroundColor: "{colors.env-staging}"
    textColor: "{colors.staging-ink}"
    typography: "{typography.banner}"
    padding: "6px 24px"
  banner-prod:
    backgroundColor: "{colors.money-red}"
    textColor: "#FFF"
    typography: "{typography.banner}"
    padding: "6px 24px"
  agent-state:
    textColor: "{colors.state-running}"
    size: "20px"
  agent-state-paused:
    textColor: "{colors.state-paused}"
    size: "20px"
  task:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.sign-black}"
    rounded: "{rounded.sm}"
    padding: "6px 36px 6px 10px"
  calls-chip:
    textColor: "{colors.cli-violet}"
    typography: "{typography.label}"
    height: "28px"
  dot-warn:
    backgroundColor: "{colors.money-amber}"
    rounded: "{rounded.circle}"
    size: "8px"
  dot-bad:
    backgroundColor: "{colors.money-red}"
    rounded: "{rounded.circle}"
    size: "8px"
  sample-chip:
    textColor: "{colors.soft-ink}"
    rounded: "{rounded.pill}"
    padding: "4px 12px"
    height: "30px"
---

# Design System: TaskFast agent console

## Overview

**Creative North Star: "The Yellow Signage"**

The console is an international airport sign system pointed at one agent that moves real money. Saturated yellow bands name each section the way gate signs name a concourse: one message per band, black sentence-case text, pinned to the top of the section while the content scrolls. State and role arrive as solid white pictograms on black squares: the agent's robot, the operator's person, the taskfast CLI's server. Today's spend renders at monumental gate-number scale with tabular numerals, and the attention band carries its count on a black plate of its own.

The system refuses the category default of neutral cards with one blue accent. Nothing here casts a shadow and nothing fades into a gradient: structure comes from hairline black frames and the shift between ground and panel. Dark and light are one design, not two. The bands stay #FFCC00 in the dark theme, the way road signage turns retroreflective at night, while the inks, grounds and status hues re-ink for legibility. A manual toggle stores the choice in localStorage under "tf-theme" and the default follows the OS preference.

Two product truths pin the palette. The environment banner always opens the screen in its reserved hue, and money-safety green, amber and red each keep one fixed meaning in both themes. One more product truth pins the rendering: everything the server or marketplace says appears as plain text, never markup. That is a safety boundary, not a style choice. The one exception is an agent reply: it renders a small markdown subset (emphasis, code, lists and http(s) links), built node by node, and its raw HTML and images stay text.

**Key Characteristics:**
- Yellow sign bands, one message per band, sticky at the top of each section.
- Solid pictograms on black squares as the only state and role marks: the agent's robot, the operator's person, the taskfast CLI's server.
- Money figures at monumental gate scale (weight 800, tabular numerals, up to 64px), and the attention count on its band's black plate.
- Hairline black frames and 2px corners on signs and cards; zero shadows, zero gradients.
- Two themes, one sign system: dark re-inks the grounds and hues, the bands stay yellow.
- Server and marketplace content always renders as plain text. Agent replies render only the markdown subset, built as nodes, never from a markup string.

## Colors

The palette is a sign cabinet: one saturated yellow for wayfinding, black and off-white for the legend, and small reserved hues for roles, environments and money safety. Values below are the light theme; the dark theme re-inks its own set under "-dark" token names.

### Primary
- **Schiphol Yellow** (#FFCC00): the wayfinding hue. Section bands, the current tab, the operator's own square, the brand mark, text selection, and the primary button in the dark theme. Identical in both themes; the retroreflective constant. It never warns and never decorates.

### Secondary
- **Agent Ultramarine** (#1D4ED8): the agent's voice and the action accent. Links, the agent's pictogram square and display name, focus outlines, and form accents through accent-color.
- **CLI Violet** (#7C3AED): the taskfast CLI's mark. The server glyph and tabular count of the tool-calls ghost, and the CLI's square inside tool-call rows.

### Tertiary
- **Local Blue** (#2E5E8C): the development environment banner, with white text.
- **Staging Amber** (#F2C14E): the staging environment banner, with dark brown text (#2B2000). The production banner uses the theme's Money Red instead. These hues belong to the banner and nowhere else.

### Neutral
- **Sign Black** (#0B0B0B): band text and frames, the header bar, pictogram squares, tags, JSON panels, and the light theme's primary button.
- **Ground** (#F2F2EF): the page ground every sign and card sits on; also the turn head row and tool-call rows.
- **Panel** (#FFFFFF): the working surface for cards, inputs and buttons.
- **Soft Ink** (#3D3D38): form labels, the composer's sample chips and kbd hints, and tool-call error text.
- **Muted Ink** (#5E5E56): metadata, timestamps and helper text, plus input and sample-chip borders.
- **Hairline** (rgba(11,11,11,.72)): the 1px frame on cards, turn heads and task cards; the same value sets the band's qualifier text.
- **Code Ink** (#E9E7DC): text on the black JSON panel and its copy button, and code inside agent replies.
- **Header Line** (#4A4E55): the border on controls inside the black header.
- **State hues** (#56D364 running, #F85149 frozen): the freeze toggle's knob, track and label and the frozen budget figure on the dark budget plate, the same in both themes. The header's own state mark is the brand robot's glyph, deep green (#14532D) or deep red (#7F1D1D) on the constant yellow square; the paused red is a user-pinned stop signal, an explicit exception to The Red Means Money Rule.

### The dark theme
One sign system, re-inked for night: asphalt ground (#131311), night panel (#1C1C19), off-white ink (#F2F1EA), softened soft (#C9C8BE) and muted (#A3A298) inks, a lighter hairline (rgba(242,241,234,.5)), and true black squares (#000000) holding their edges with a 1px off-white outline. Role and safety hues brighten for contrast: ultramarine #7AA8FF, violet #B794F6, green #56D364, amber #D29922 on a #3A2E10 tint, red #F85149. Schiphol Yellow, the environment hues, the staging text brown, the black header and the JSON panel stay exactly as they are in the light theme.

### Money safety
- **Money Green** (#1D6B34): OK readiness checks, ok tool-call outcomes, copy confirmation.
- **Money Amber** (#B45309) on **Amber Tint** (#FDF3E3): uncertain money actions, failed or uncertain tool calls, readiness problems, the paused and limit-confirmation notes, the attention card frame, and the amber wrench that fixes an alert.
- **Money Red** (#B3261E): errors, frozen spending, abandoned and dead-lettered events, the failed tool-call dot, and the production banner. Red always means money danger or refusal.

### Named Rules
**The Yellow Means Wayfinding Rule.** Yellow names sections and marks the operator's own voice; in the dark theme it also carries the primary action. It never warns and never fails. Warnings are Money Amber, danger is Money Red.
**The Same Sign At Night Rule.** Dark and light are one design. A theme change may re-ink grounds, texts, status hues and square outlines, but the bands stay #FFCC00, the header stays black, and every hue keeps its meaning. A theme that changes a color's job is a defect.
**The Environment Never Hides Rule.** Every screen opens with a full-width banner naming the money environment in words and in its reserved hue: blue for development, amber for staging, red for production. No state of the page may render without it.
**The Red Means Money Rule.** Money Red appears only for the production banner, errors, frozen spending, and failed or refused money outcomes, plus two pinned exceptions: the paused robot glyph in the header (a user-pinned stop signal) and the fix square's red hover on an attention card. Never for emphasis.

## Typography

**Display Font:** the system sans stack: "Segoe UI", Frutiger, "Frutiger Next", Roboto, "Helvetica Neue", "Noto Sans", "Liberation Sans", Arial, system-ui. No font file is loaded. Frutiger, the classic airport signage face, speaks only on machines that already have it.
**Body Font:** the same stack at 15px with a 1.45 line height; agent replies tighten to 1.35.
**Label/Mono Font:** ui-monospace, with SFMono-Regular and Menlo fallbacks.

**Character:** a humanist wayfinding voice in sentence case. The sign says "Needs your attention", never a shouted acronym; only the 11px micro-tags set uppercase.

### Hierarchy
- **Display** (800, clamp(48px, 6vw, 64px), -0.02em tracking, tabular numerals): today's spend, the one monumental figure in the system.
- **Headline** (700, 15px, 0.01em tracking): the yellow band's message, sentence case.
- **Title** (700, 15px, 1.45): card headings and the "Agent console" wordmark.
- **Body** (400, 15px, 1.45): everything the operator reads or writes; agent replies run at 1.35.
- **Label** (400, 13px, 1.45): form labels in Soft Ink, metadata in Muted Ink, and the header's waiting count at 12px tabular. The environment banner tightens it to 600 with 0.04em tracking.
- **Tag** (700, 11px, line-height 1, 0.07em tracking, uppercase): the micro-caps on alert tags.
- **Code** (400, 13px, mono): tool calls, timestamps, ids and host addresses. JSON panels drop to 12px on Sign Black.

### Named Rules
**The Gate Scale Rule.** A figure the operator must read at a glance renders with tabular numerals. Today's spend earns the monumental gate scale; the attention count sits on its band's black plate. Nothing else earns monumental type.
**The System Is the Font Rule.** No font loading, no branding type. The stack prefers the humanist signage faces an OS already ships and falls through to system-ui. If the OS changes its face, the console changes with it.
**The Identifier Is Monospace Rule.** Anything the operator might copy or cross-check against the server (ids, tool calls, JSON, timestamps) is set in mono. Anything the model writes is set in proportional type, except what it marks as code (inline or fenced), which is set in mono on Sign Black.

## Layout

One centered column at most 1280px wide with 24px gutters. Under the black header the page splits into a main stream (flex basis 560px, grows first) and a sidebar (basis 320px) that wraps beneath it when space runs out. There is no separate phone design; the same components re-flow. Columns stack sections with 16px gaps, a section keeps 12px between band and card, and regions sit 24px apart. The shared 640px breakpoint collapses Briefing's three-column grid with 14px gaps, hides the timeline rail and composer hints, and moves queued-message actions below their text. The rhythm runs on 4, 8, 12, 16 and 24: 6 to 10px inside components, 16 to 18px of card padding, 24px between regions. Every band is sticky at the top of its section (top: 0, z-index 2), so the sign stays put while its content scrolls. Buttons, inputs, tabs and the copy button keep a 44px minimum height, and the tool-calls ghost extends an invisible 44px hit area; the dense inline marks are the exceptions, sample chips at 30px and attention action squares at 28px. The unlock screen is a single 560px column with 72px of air above it.

## Elevation & Depth

There are no shadows and no gradients anywhere in the system. Depth is framing and layering: a 1px hairline frame around every panel, the ground showing behind the panel, amber tints for alert surfaces, and black plates for JSON. Sticky bands cross above content by z-index alone, the way a suspended sign crosses your view without touching it. The dark theme adds the only two exceptions, and both serve legibility: bands gain a 3px black under-edge so the yellow plate reads as a solid sign against asphalt, and pictogram squares gain a 1px off-white outline so the mark keeps its shape.

### Named Rules
**The Flat Sign Rule.** A 1px frame plus a tonal shift is the maximum depth treatment. No elevation, no blur, no glow. The dark theme's 3px band under-edge and square outline belong to those elements only.

## Shapes

Corners stay nearly square, the way sign panels are. Signs, cards, tags, notes, JSON panels and task cards share a 2px radius. Operator controls, the buttons and inputs, soften to 6px. Pills (999px) shape the composer's dashed sample chips and the budget Freeze track. Circles shape the 8px state dot on the tool-calls ghost and the Freeze knob. Pictogram squares are true squares with sharp corners, and every panel carries a 1px frame instead of a shadow. Turn cards clip their contents so the head row's ground tint stops cleanly at the frame.

### Named Rules
**The Square Carries the Mark Rule.** State and role marks live only on solid squares with sharp corners: one silhouette per meaning, white on black or on its reserved hue. Plain controls outside squares use 2px stroke glyphs. Never place a solid pictogram on bare ground, and never round the square.

## Components

### Buttons
Physical sign-plate keys.
- **Shape:** gently rounded (6px), 44px minimum height, 16px horizontal padding, 1px ink frame.
- **Primary:** the highest-contrast plate of the theme: Sign Black with white text in the light theme, Schiphol Yellow with black text in the dark theme, 600 weight. One per region: Send, Add, Unlock, Run again, Save & reopen.
- **Outline (default):** Panel surface with ink text and a 1px ink frame. The workhorse: Pause/Resume, Discard, Remove, Run again, Raw event on an abandoned alert. Freeze spending is not a button: it is the animated toggle on the budget card.
- **Attention action squares:** the alert's affordances are not text buttons. Two solid 28px pictogram squares close the tag row: an amber wrench that drafts a fix-it message into the composer and focuses it, and a black X that marks the alert checked. They clear the alert only, never the ledger.
- **Tool-calls ghost:** the tool-call affordance is not a pill. A violet server pictogram with a tabular count at 28px, borderless, with an invisible 44px hit area. Failed and uncertain calls show as an 8px dot (Money Red for failed, Money Amber for uncertain), never as text the operator cannot act on. Only the newest turn's dots pulse; a historical failure stands still so an idle page keeps the compositor free. The pulse and the budget Freeze knob are the system's motion exceptions; both stand still under prefers-reduced-motion. The count and state stay in the aria-label.
- **Hover / Focus:** focus is a 2px Agent Ultramarine outline offset by 2px on everything. Hovers are absent by design; the exceptions are the copy button, which swaps its plate shade, the composer's sample chips, whose dashed frame turns solid, and the attention action squares, where the wrench turns Money Red and the X's glyph turns Money Amber. State changes render immediately, except the budget Freeze knob's short slide and color transition.

### Sign bands
The signature component.
- **Style:** a Schiphol Yellow plate with a black 1px frame, black sentence-case message at 700 weight, 8px 18px padding, sticky at the section top. The dark theme adds a 3px black under-edge.
- **Qualifier:** an optional second phrase at 500 weight in 72% black that completes the message, as in "Needs your attention" with "holds until you dismiss it".
- **Count:** the attention band carries its count in a 44px Sign Black plate at the right end (white 24px tabular numeral), grouping the numeral as its own small sign. The band centers vertically, and the title and qualifier group as a left cluster so the plate never drifts against them. Other bands carry no count.

**The One Message Per Band Rule.** A band carries one message: a sentence-case title, an optional muted qualifier, and at most one count. Never two messages, never an icon, never a button.

### Pictogram squares
- **Style:** a 28px black square bearing a solid white silhouette at 16px. The square shrinks to 20px inside tool-call rows and 18px on task cards. Sharp corners; a 1px off-white outline in the dark theme.
- **Roles:** the agent's robot on Agent Ultramarine, the operator's person on Schiphol Yellow with a black glyph and a faint dark outline, the taskfast CLI's server on CLI Violet.
- **States:** OK on Money Green, problem on Money Amber, failed or abandoned on Money Red.
- **Glyphs:** marks inside squares are solid silhouettes; controls outside squares (copy, theme toggle, raw-event chevron) use 2px stroke glyphs.

### Tags and status
- **Tag:** micro-caps (700, 11px, 0.07em, uppercase) on a black plate with a 2px radius and 5px 8px padding. It classifies alert kinds only (UNCERTAIN amber, ABANDONED and DEAD-LETTERED red); turn origins are carried by their pictogram squares, never by a text tag.
- **Agent state glyph:** the live agent state in the header is the brand robot itself: its glyph on the constant yellow square turns deep green (#14532D) while running and deep red (#7F1D1D) while paused. There is no pill and no separate status mark. The waiting count stays out of the glyph: it lives in the square's title and in a screen-reader-only status, and the paused note in the timeline names it.

### Cards and containers
- **Card:** the Panel surface with a 1px hairline frame, 2px radius, 16px 18px padding and 10px internal gaps. Headings at 15px.
- **Attention card:** the same card with a Money Amber frame, first in the main stream. Its tag row holds the state square, the alert tag, the id or reason, and a pair of solid action squares: an amber wrench that drafts a fix-it message into the composer and focuses it, and a black X that marks the alert checked.
- **Note:** an inline callout on Amber Tint with a 1px amber frame (2px radius, 12px 16px padding, 14px) for persistent states such as paused and for confirming spending-limit changes.
- **JSON panel:** a Sign Black plate with 12px Code Ink mono (2px radius, 10px 12px padding); long payloads wrap. The inset copy button sits top-right on a near-black plate with a Header Line frame, swaps to #2A2D31 on hover, and flashes Money Green on success or Money Red on failure.
- **Turn card:** a card with no padding. A head row on Ground (author square, relative timestamp in mono with the absolute value on its title attribute, the message at 15px full ink) over a 16px 18px body of replies. On an event turn the whole head row is a native button for the raw-event switch (keyboard-operable, aria-expanded, a chevron at the right edge that flips when open); there is no labeled pill. Authorship is one column at the 18px left edge: the operator's yellow person marks their message, the agent's robot leads every reply at a 1.35 line height, and machinery origins ride black squares (a clock for check-ins, a bell for marketplace events, an arrow for resumed work, an info mark for other input). There are no text tags and no signature row; origin names remain as screen-reader-only labels.
- **Reads card:** Settings' "What the agent reads every turn", one card with no padding that holds the prompt's owned blocks in the order the model reads them: your instructions, the agent's notes, your standing orders. Each block has a head row on Ground (author square, bold title, when a change applies in small muted type) over a 14px 18px body. Notes and orders are numbered rows from 1. Row actions are solid 28px Sign Black squares at the row's right end, each with an invisible 44px hit area; removing an order is not a money action, so it never takes Money Red. A disclosure at the foot shows the exact prompt text on a JSON-panel plate.

### Inputs and fields
- **Style:** Panel surface, 1px muted frame, 6px radius, 10px padding, 44px minimum height, full width.
- **Labels:** stacked above the field in 13px Soft Ink with a 6px gap.
- **Focus:** the global 2px ultramarine outline. No glow, no border swap. Checkboxes, radios and sliders take ultramarine through accent-color.

### Composer
The message form is a card pinned to the bottom edge of the timeline column (sticky, above the bands), so the operator can write at any scroll depth. The textarea and the primary Send share the first row; the Try sample chips and the right-aligned kbd hint line sit below. Under 640px the chips and hints drop out so the pinned card stays small. When the newest turn is out of view, a 44px Sign Black square with the arrow pictogram turned down sits centered above the card and jumps to the newest turn. The field carries no visible label: its name lives in an aria-label and a screen-reader-only span, the placeholder teaches by example, and the field takes focus when the page loads. A rebuild that hands the field its focus back never scrolls the page; only a deliberate ask, such as a fix-it draft or a sample chip, scrolls the field into view. The placeholder shows a real message the operator has sent before (e.g. "Post one copy-editing job under $15."). Sample chips are dashed pills that prefill the field, so a first-timer sees what a message can do. Enter sends, Shift+Enter adds a line, Ctrl+S steers; every path runs the same dedup-safe submit.

### Queued messages
The operator's queued messages sit just above the composer, oldest first, with no band. Each row recedes like a sample chip: Ground surface, a dashed hairline frame and Soft Ink text. The word "Queued" sits at the right end of the mode line in sentence case, 24px at 700 in Muted Ink at 20% opacity, the row's one quiet mark. The mode line reserves room for it, so no text runs underneath it. Screen readers skip the mark and hear "Queued" at the start of the mode line instead. The mode line says when the message reaches the agent: a follow-up on its next run, a steer after its current tool round, both only after Resume while paused. A follow-up carries an outline Steer button that changes it into a steer; both modes carry an outline Withdraw button that removes the message only before the agent receives it. Neither control uses money-danger red. The 44px actions stack beside the text on wide screens and wrap below it at 640px and narrower. While an action runs, its controls stay focusable and report themselves as unavailable instead of disabling. The notice line says "Changed to a steer." or "Message withdrawn." A placement or stale-row race says "The agent already has this message." without marking an unrelated draft as failed. Live updates keep rows keyed by request ID; removal moves keyboard focus to a neighboring Withdraw button or the composer. With nothing queued the queue area is hidden, but its notice stays visible.

### Timeline window and rail
The timeline opens at its newest turn and mounts only the newest 12; a card at the top says how many earlier turns there are and loads 20 more without moving the reader. The band qualifier names original turns, loaded originals and folded groups ("76 turns · 12 loaded · 1 unchanged group"). Beside the turns, a 30px rail sticky under the band holds one sharp mark per mounted turn, sharing the rail's height like a scrollbar: check-ins as faint muted marks, events and resumes in ink, the operator's turns as wide yellow marks with a black frame, and turns with a failed or uncertain call in Money Red or Money Amber. Turns not yet mounted compress into at most 12 fixed 4px marks at the top of the rail, above a dashed muted rule. Each compressed mark stands for a run of turns and takes the hue of its most telling turn (failed, then uncertain, then operator, then event, then check-in), and its peek names the run ("Turns 19–24 of 76, not loaded"). The rail ends 16px above the pinned composer, sized from the composer's measured height, so no mark hides behind it. The mark for the turn in view widens to full width in ink. Hovering or focusing a mark shows a framed peek of who spoke, when, and the first lines they said, as plain text. Clicking a mark goes to that turn, loading older turns first when needed; the rail is one tab stop and the arrow keys move along it. Under 640px the rail is hidden.

### Unchanged polling runs

The browser folds consecutive completed check-ins only when their agent replies match exactly and their supported successful reads match in full. A folded run is a Panel plate with a 1px Hairline frame and 2px corners. Its native summary pairs the clock square with "No changes", a check count, the first and last checked times, and the checked scope. The summary has a 44px minimum target and the existing chevron. Opening it reveals individual check-in disclosures; opening one restores the original turn and tool details. Different wording, failed or uncertain calls, writes and incomplete observations stay full-size. This is console-authored status, not a new agent reply. The band distinguishes original turns, loaded originals and unchanged groups. The initial window still mounts the newest 12 originals; live growth keeps the mounted start while the owner reads. Rail marks continue to address individual originals and open their disclosures on navigation. Focus and expansion follow original turn identity, not shifting transcript indices. The terminal UI and stored transcript do not fold.

### Navigation and header
- **Header:** a black bar in both themes with off-white content. The yellow brand square and the wordmark sit left with the tabs; the right cluster is a hairline rule, the agent switcher plate (yellow role square fused with the near-black select), the theme toggle, and Pause. Freeze spending lives in the budget card, not the header.
- **Tabs:** 44px text links. The current tab becomes a yellow plate with black 700 text, the wayfinding highlight. There is no hover state.
- **Environment banner:** a full-width strip above the header on the environment hue, 13px at 600 with 0.04em tracking. The host address sits demoted at its right edge (12px, 85% opacity). Always first, always visible.
- **Frozen strip:** when spending is frozen, a Money Red strip with white 14px text (10px 24px padding, role="alert") under the header.

### Readiness checklist
Rows pairing a state square (green check or amber exclaim) with a 700 word held 5em wide: OK in Money Green, Problem in Money Amber. The check name follows, then a 13px detail line. Money-critical rows only: wallet balance, unlock file, event stream, model, spending limits.

### Task card
A Panel plate with a hairline frame and an 18px arrow square pinned top-right (2px radius, 6px 36px 6px 10px padding). Origin as a humanized action name in muted 13px (Post Task, Escrow Sign, Bid, Accept Bid, Reject Bid, Claim, Submit; never the raw enum code), a bold title, one metadata line with relative times (due in 15h). It renders as a link only against a local development server; otherwise it is a plain div.

### Budget card
The band reads Budget with the UTC qualifier, and the card is the system's one dark data plate: a Sign Black surface (like the JSON panels) at 1.4x card padding. On it: the monumental spent figure, a 7px data bar where light ink is spent, Money Amber is the uncertain portion and the rest stays empty to the daily limit, a $0-to-limit scale line, and a 7-day sparkline of daily UTC spend (today in light ink, prior days muted, values on hover). Any uncertain amount is noted below.

The state lives here too: a full-width Freeze toggle follows the charts, with a 64px by 32px track, a 26px knob and a 14px state label. Frozen turns the track, the spent bar, the today spark and the figure Money Red, and the label to FROZEN. The card going dark-and-red is the whole stop signal.

The Freeze spending brake is this card's full-width toggle, not an ordinary outline button: the brake belongs with the budget it protects. Its knob slides 32px over .3s with cubic-bezier(.16, 1, .3, 1), and its color changes over .2s. Reduced-motion disables both transitions. The header keeps Pause, the state glyph, the theme toggle and the agent switcher.

## Do's and Don'ts

### Do:
- **Do** keep the environment banner as the first element of every screen, in its reserved hue (development #2E5E8C, staging #F2C14E, production Money Red).
- **Do** give every section its own yellow band with one sentence-case message; a section without its band is off the sign system.
- **Do** keep 44px minimum targets on primary controls (buttons, inputs, tabs, the copy button) and on the ghost's invisible hit area; only the dense inline marks (sample chips, attention action squares) run smaller.
- **Do** render today's spend at gate scale with tabular numerals, and the attention count on its band's black plate.
- **Do** set identifiers, tool calls, timestamps and raw payloads in the mono stack, and model or marketplace prose in the proportional stack.
- **Do** show server and marketplace content as plain text only; rendering it as markup is a security defect, not a style choice. Agent replies render only the markdown subset, node by node, with raw HTML and non-http(s) links left as text.

### Don't:
- **Don't** introduce shadows, gradients, hover lifts or transitions; signs are flat and state changes render immediately. The pinned exceptions are the newest turn's state-dot pulse on the tool-calls ghost and the budget Freeze knob's slide and color transition. Both respect prefers-reduced-motion.
- **Don't** use yellow for warnings or errors. Yellow means wayfinding and the operator; warnings are Money Amber and danger is Money Red.
- **Don't** use Money Red outside money danger, errors, frozen spending, the production banner, and the two exceptions The Red Means Money Rule pins.
- **Don't** place solid pictograms off their squares, round a square's corners, invent new roles for the reserved hues, or label what an icon and its fixed position already say (the author column, the state glyph, the alert actions).
- **Don't** load a custom font or add another accent color; the stack is the OS's own and every accent is already assigned.
- **Don't** treat the dark theme as a second design; re-ink only what legibility demands and keep every hue's meaning fixed.
