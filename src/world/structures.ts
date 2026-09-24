/**
 * The structural levels a road can be built at.
 *
 * A structure is not a fixed world height. `elevated` used to mean "asphalt at
 * y = 18", which is only correct on flat ground: over a hill the terrain simply
 * swallowed the deck, and next to a valley the deck hung far higher than any
 * viaduct would be built. What a structure really states is how much room it
 * keeps over the ground it spans, so that is what is stored — see `clearance`,
 * and `world/elevation.ts` for the solver that turns it into a deck height.
 */
export type RoadStructure = 'ground' | 'elevated' | 'bridge' | 'tunnel';

/**
 * Structure ids a saved map may still carry, and what each one loads as.
 *
 * `viaduct` was a second raised level beside `elevated`: the same deck on the
 * same piers, four metres of clearance instead of six. Players could not tell
 * them apart - photographed side by side the two differed only in a height the
 * fixed camera flattens - and the lower one did not even clear a lorry: ten
 * units of clearance to the deck SURFACE left 3.3 m under the soffit, against
 * the 4.5 to 5.5 m a road under a structure needs. Two buttons for one thing,
 * one of them unbuildable in reality, is one button too many. A segment saved
 * as a viaduct loads as elevated, never as a failure.
 */
const LEGACY_STRUCTURES: Readonly<Record<string, RoadStructure>> = { viaduct: 'elevated' };

/** The structure a stored id stands for today, or null when it is not one. */
export function migrateStructure(value: unknown): RoadStructure | null {
  if (isRoadStructure(value)) return value;
  if (typeof value !== 'string') return null;
  return LEGACY_STRUCTURES[value] ?? null;
}

export interface RoadStructureSpec {
  readonly id: RoadStructure;
  /** Translation key for the structure's name, resolved by `ui/i18n`. */
  readonly key: string;
  /**
   * Height the deck keeps above the highest ground under the span, in units.
   *
   * Zero for a road at grade, which simply follows the ground; negative for a
   * tunnel, whose bore runs below it.
   */
  readonly clearance: number;
  /** Thickness of the structural deck drawn under the asphalt. */
  readonly deck: number;
  /** Whether the structure stands on piers. */
  readonly supports: boolean;
}

/**
 * Clear height inside a tunnel bore, in units (about 4.4 m).
 *
 * Every other tunnel number is derived from this one, because they have to
 * agree: the depth has to be enough to fit the headroom plus the arch plus real
 * ground above it, and the portal has to stand exactly where the ground has
 * closed over the arch. Deriving them is what stops a portal hanging in open air
 * or a bore poking out of the top of its own hill.
 */
export const TUNNEL_HEADROOM = 11;
/** Thickness of the arch over the bore. */
export const TUNNEL_ARCH = 1.5;
/**
 * Depth of a tunnel's floor below the lowest ground along its span.
 *
 * Headroom, arch, and then a clear margin of real ground on top — without the
 * margin the hill closes over the bore only just, and the slightest dip in the
 * terrain reopens it halfway along.
 */
export const TUNNEL_DEPTH = TUNNEL_HEADROOM + TUNNEL_ARCH + 5;
/**
 * Cover at which the ground closes over the road: the mouth of the bore.
 *
 * The `ROOF`/`BORE` pair is deliberately NARROW — less than a unit apart. A
 * generous fade sounds gentler and produces the worst possible result: the
 * ground comes down towards the road over a long stretch, so for fifty units
 * before the bore the road runs under several units of earth with no opening
 * at all, and the first screenshot of it showed a road simply evaporating into
 * a meadow. A terrain heightfield cannot have a hole in it; what it can have is
 * a step, and a step is what a portal headwall is built to close. So the ground
 * is held down to the road right up to the mouth and steps up over it there.
 */
const TUNNEL_CLOSE = TUNNEL_HEADROOM + TUNNEL_ARCH + 1;
export const TUNNEL_ROOF = TUNNEL_CLOSE - 0.4;
export const TUNNEL_BORE = TUNNEL_CLOSE + 0.4;
/**
 * Cover at which the portal stands: where the ground FIRST rises over the road.
 *
 * Not where the bore closes, which is where it was first put and where a real
 * portal's arch sits. From a camera locked to a 48-degree diagonal you cannot
 * see into a tunnel mouth, so a headwall built at the closing depth is simply
 * buried in the hillside and the road appears to dissolve into a meadow. Built
 * at the foot of the cutting instead, the wall stands clear of the ground the
 * road is still running level with, and reads from above as what it is: a
 * concrete face with a road going into it and a hill rising behind.
 */
export const TUNNEL_PORTAL_COVER = 1.5;
/**
 * Design gradient of a tunnel's approach ramps.
 *
 * Steeper than a viaduct's, which is both true of real tunnels and the
 * difference between "draw a road across this hill and it becomes a tunnel" and
 * "draw a road eight hundred units long or get an open trench".
 */
export const TUNNEL_GRADE = 0.13;

export const ROAD_STRUCTURES: readonly RoadStructureSpec[] = [
  { id: 'ground', key: 'structure.ground', clearance: 0, deck: 0.55, supports: false },
  { id: 'elevated', key: 'structure.elevated', clearance: 15, deck: 1.6, supports: true },
  { id: 'bridge', key: 'structure.bridge', clearance: 7.5, deck: 1.15, supports: true },
  { id: 'tunnel', key: 'structure.tunnel', clearance: -TUNNEL_DEPTH, deck: 0.6, supports: false },
] as const;

/** Clearance a road at grade keeps over the terrain it is laid on. */
export const ROAD_GROUND_CLEARANCE = 0.3;

export const roadStructure = (id: RoadStructure): RoadStructureSpec =>
  ROAD_STRUCTURES.find((value) => value.id === id) ?? (ROAD_STRUCTURES[0] as RoadStructureSpec);

export const isRoadStructure = (value: unknown): value is RoadStructure =>
  value === 'ground' ||
  value === 'elevated' ||
  value === 'bridge' ||
  value === 'tunnel';

/** True for the structures that stand clear of the ground on piers. */
export const isRaised = (id: RoadStructure): boolean =>
  id === 'elevated' || id === 'bridge';

/**
 * True for the structures that run BELOW the ground.
 *
 * The mirror of `isRaised`, and the reason a tunnel is no longer solved as a
 * road at grade: a road at grade follows the ground, and a tunnel is defined by
 * not doing that.
 */
export const isSunken = (id: RoadStructure): boolean => id === 'tunnel';

/**
 * Whether tunnels are part of the game at all.
 *
 * ON. It was off because the terrain could not be cut at the portals: the bore
 * sat below ground with its portals anchored above it, so there was no honest
 * geometry to draw and none to drive on either, and the gate kept a hidden bore
 * from silently carrying traffic through something invisible.
 *
 * What changed is that the ground now comes to meet the roads (`shapeAt` in
 * `world/elevation.ts`). The same cut-and-fill rule that removed the walls
 * beside a road produces a tunnel for free: it fades its own weight out as a
 * road goes deeper, so the approach is an open cutting, the ground closes over
 * the arch, and the bore runs through intact hill. The portal is then a headwall
 * at a known depth rather than a guess.
 */
export const TUNNELS_DRAWN = true;
