# Pedestrian navigation audit

The pedestrian system has global destinations and A* routing on a graph derived
from the road network. Its edges represent footways, junction corners and
crossings. A corridor describes the walkable width around each edge. The local
agent selects a velocity using predicted time to collision; the crossing state
machine owns permission to enter the carriageway.

## Reproduced causes

- Corner sampling retained centimetre-scale reverse segments. Their normals
  flipped the lateral walking offset and prevented progress through the path.
  Short reversals are now removed before building the corridor, retaining exact
  kerb endpoints.
- Clearance and perception used raw polyline normals while movement and visible
  poses used the continuous corridor frame. This placed perceived neighbours
  away from their actual walking positions. Both now use the corridor frame.
- Neighbour velocity was calculated from the render interpolation snapshot.
  That snapshot is reset before the pedestrian stage, so agents processed later
  in the loop appeared stationary to earlier agents. Perception now captures
  velocities at the start of the stage and keeps them fixed for that step.
- The predictive agent was disabled on crossings. The older independent
  sideways/forward controller could stall inside the crossing and retain its
  traffic reservation. Footways and crossings now use the same local agent.
- Collision scoring alone could choose to stop behind a person indefinitely.
  The preferred line now includes the predictive free-space plan around people,
  as well as furniture. Crossing permission still gates entry.
- A conversation's own companions were treated as detours from its assigned
  places. They are excluded from that route adjustment, while physical collision
  checks remain active. Settled speakers face their companions' actual positions.
- Furniture from a nearby road leg could occupy the far landing of a crossing.
  The shared furniture layout now reserves crossing and landing space, keeping
  both the rendered obstacles and their collision footprints out of that access.
- A two-leg road node connected only one side's footway, while the crossing
  graph created edges even when the network suppressed the painted zebra.
  Both sides now connect around the node and crossing edges require an actual
  crossing distance from the road network.
- The local velocity sampler extrapolated a crossing's direction beyond its
  far kerb. Pedestrians on the next footway then looked like imminent obstacles
  before the walker reached the edge. Collision prediction now ends at the
  current route edge; the physical transfer gate checks the shared kerb.
- A runtime reservation audit compared entire connector and crossing IDs,
  reporting a conflict even when the pedestrian had already cleared the
  movement's swept span. It now uses the same crossing-span predicate as
  admission, preserving the physical conflict check.
- A signalised crossing could admit a walker beside a vehicle body that had
  reached the zebra without a connector token. The crossing gate now checks
  approach bodies before both signal and gap admission. The original generated
  map is retained as `pedestrian-vehicle-body-seed5.json`.
- A vehicle denied entry for an occupied crossing was held at the stop line,
  leaving its body beside the walker. The pedestrian stop constraint now
  reserves the near half of the zebra while the vehicle is still on its link.
  Vehicle avoidance also uses an oriented box and the same physical clearance
  as the hard collision gate; the earlier circles and extra comfort margin
  made an available gap look impassable. A walker commits to its passing side
  until the obstacle is behind it.

## Regression coverage

`pedPerception.spec.ts` checks that rendering snapshots cannot erase perceived
velocity and that clearance uses the same curved corridor positions as motion.
`pedContainment.spec.ts` checks corner reversals on the saved player map and six
junction layouts. The existing flow, motion, spacing, crossing and conversation
tests remain required gates. Passing finite fixtures does not establish that
every possible edited map or crowd density is correct.

## Research used

- [RVO2 integration documentation](https://gamma-web.iacs.umd.edu/RVO2/documentation/2.0/using.html):
  global navigation supplies preferred velocities; local collision avoidance
  resolves interactions each simulation step.
- [Explicit Corridor Map](https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.SoCG.2016.70):
  routes and available clearance belong to a shared navigation representation.
- [Karamouzas, Skinner and Guy](https://motion.cs.umn.edu/PowerLaw/):
  anticipatory interaction based on predicted time to collision.

Roadcraft's solver is a corridor-guided velocity sampler, not the ORCA linear
program. ORCA's guarantees must not be attributed to this implementation.
