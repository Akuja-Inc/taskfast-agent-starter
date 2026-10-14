---
version: 1
slug: "src-console-page-ts"
primary_target: "src/console-page.ts"
related_targets: []
---

# Surface brief: agent console page

Scope: `src/console-page.ts` (the local operator console, timeline and briefing tabs, unlock page). Related surfaces that inherit later: `src/tui/` renders the same view and may adopt the role colors; it is out of scope for this build.

Visitor mode: Operate. The operator watches and steers their own money-moving agent: readiness, attention items, timeline, spend, tasks, standing orders, messages, pause, freeze, briefing edits.

Constraints pinned by product truth and the user: environment banner always first with its reserved hues (local #2E5E8C, staging amber, production red); money-safety hues keep single meanings (green OK, amber warning/uncertain, red frozen/error/production); server and marketplace content renders as text only; 44px touch targets; works on a phone; dark and light themes (user-pinned 2026-10-13) with a manual toggle, defaulting to the OS preference. User-pinned composition: agent switcher top right; the host address demoted (it is already in the browser bar and the launch terminal); message roles told apart by color (agent, operator, taskfast CLI).

## Direction contract

THESIS: The console is an airport sign system for one agent: yellow bands name each section, black pictogram squares carry state and role, and money figures sit at gate-number scale. It refuses the category default of neutral cards with one blue accent.

OWN-WORLD: Schiphol yellow (#FFCC00) bands with black sentence-case text; white glyph pictograms on black squares; sign black (#0B0B0B) on white ground (light) and off-white on asphalt (#131311, dark, where the bands read as retroreflective signage); humanist system sans with tabular numerals; hairline black frames, no shadows, no gradients. Role markers: agent ultramarine, operator yellow-on-black, taskfast CLI violet. Amber, green, red stay reserved to money state.

STORY: The operator glances and knows: which environment the money is in, what needs attention, what the agent did, what it spent, and where to act. Every section answers one question, one message per band.

FIRST VIEWPORT: Environment banner first. Black header band: console name and tabs left, status lamp, Freeze and Pause, theme toggle, agent switcher top right (user-pinned); host address only as small muted text inside the environment banner's right edge (user-pinned demotion). Below: the NEEDS YOUR ATTENTION band with its count at monumental scale, then TIMELINE as sticky-crowned sign bands over turn rows whose role squares color-code agent, operator, and CLI voices; the sidebar carries READY TO WORK, TASKS, SPEND TODAY (monumental figure), STANDING ORDERS under their own bands.

FORM: Wayfinding challenger, competitive verdict in the bolder hand (seed dd0ce7cd, re-roll round 1, register bolder), chosen by the user over the dealt leader. Signature move: sticky yellow sign bands with one message per band, plus pictogram squares as the only state and role marks.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
