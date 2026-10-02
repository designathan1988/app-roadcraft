# CLAUDE.md — how work is done in this repository

## Research on the internet first — always

Before implementing anything that is not trivial (performance, loading,
rendering, simulation, agents, tools, UI systems), **search the internet
first**, with the web tools:

1. The **official documentation** of the technology involved (three.js docs
   and source, MDN, Khronos, Electron; Unreal/Unity docs as references).
2. **How shipped games and studios solve the same problem**: GDC talks,
   engine documentation, post-mortems (GTA, Cities: Skylines 1 and 2,
   Assassin's Creed Unity, Unreal Mass / City Sample, and so on).
3. Tell the player what was found, **with the links**, which approach fits
   and why. Only then plan and write code.

Never improvise a technique, never "try and measure" in the dark, never wait
to be told to research. If you do not yet know how to do something properly,
research more before touching the code.

This rule is here because on 2026-10-02 the player had to say "PROCURA NA
INTERNET" over and over in one session: a loading screen that kept the
player waiting 16 s was built before checking that engines prepare
("cook") their assets offline.

## Interface work is not finished until it has been looked at

Every panel, button, tray, gallery or control is verified by **opening the
application and photographing it**, and by looking at the pictures one by one:

1. Start the app (dev server, or the built `dist`), drive the real interface.
2. Take a screenshot of **every option** the change touches - each group, each
   tool, each entry, each gallery, each parameter row, and the state the tool
   starts in.
3. Check in the picture that what was asked for is **there** and **works**:
   the buttons, the icons, the order, the labels, the way back.
4. Only then say it is done, and say it with the pictures attached.

Rules that follow from it:

- A passing test is not a verified interface. A test that a selector exists is
  a test that a selector exists; the picture is the proof.
- If a level of a panel can only be reached by a path the pictures do not show,
  the level is not there. Photograph the way back too.
- An empty row is a defect, not minimalism. Hidden shelves have twice removed
  the way out of a tool: the player is left looking at a panel with nothing in
  it.
- Never report an interface as finished from measurements alone (rects,
  computed styles, counts). Measure to diagnose; look to verify.

This rule is here because the Builder's tray shipped with its groups hidden
while "Select" was in hand: the panel was empty, there was no way back to the
building tools, and every test was green.

## When the player orders a new system, build the new system

When the player asks for a system to be replaced (pedestrian agents, traffic
agents, the person model, the road tool), the work is the NEW system, running
in the game. Patching the old one to hide a symptom is not that work, and
neither is preparation on its own.

- Do not patch the model being replaced. If a defect in it is reported while
  the replacement is being built, say so and fix it in the replacement.
- Preparation (design documents, research, seams, interfaces, refactors that
  change no behaviour) is not delivery. Never let it stand in for the
  replacement, and never report it as if something had changed in the game.
- Every status report says, in plain words, what is LIVE in the game now and
  what is not implemented yet. "Seams landed, behaviour unchanged" means the
  player sees exactly what they saw before: say that.
- Deliver the replacement in slices the player can see, each one switched on
  in the game (behind a flag at first, then by default), measured and
  photographed.

This rule is here because on 2026-09-30 the player ordered real pedestrian
and traffic agents; hours went into an architecture document, research and
behaviour-neutral seams, then into patching the old pedestrian model, while
pedestrians in the game still slid, popped and were dragged backwards at
crossings exactly as before.

## Tests measure what the player sees, and never run for an hour

- A green regression suite is not evidence that a visible defect is fixed.
  For motion, measure the drawn body per tick (`PedView`): moving against its
  heading, sideways faster than a shuffle, jumps, side-to-side flips — that
  probe takes seconds and catches what the player describes; then look at it
  in the game.
- Never launch long runs (full suites of ten minutes or more) in the
  background, and never several heavy jobs at once: they slow the player's
  machine while they play and cannot be stopped cleanly. Run the specs you
  touched, in the foreground, a couple of minutes at most.
- Do the work yourself. No parallel subagents unless the player asks for them.

## After a compaction: read the session memory first

The work in progress, its diagnosis, its measurements and what comes next are
kept in the session memory, not only in the conversation. Read it before
doing anything else after a compaction, and keep it up to date as work moves:

- Index: `C:/Users/jonathanrodriguesti/.claude/projects/C--Codex-Shared-Road/memory/MEMORY.md`
- Current work (agents: People locomotion rewrite, traffic locks):
  `C:/Users/jonathanrodriguesti/.claude/projects/C--Codex-Shared-Road/memory/agents-engine-rewrite.md`
