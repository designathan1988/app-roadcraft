# CLAUDE.md — how work is done in this repository

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
