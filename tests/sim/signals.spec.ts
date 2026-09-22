import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { holderState } from '@sim/intersections/admission';
import { zoneShareable } from '@sim/intersections/claims';

/**
 * What a signal plan is FOR.
 *
 * A signalised junction exists so that a driver with a green may cross the
 * junction without meeting anybody who also has a green. The reported defect
 * was the opposite: cars leaving one street on green met cars crossing the
 * other street on green, and both sat there.
 *
 * The plan validator already asserted coverage and liveness - that no group is
 * left permanently dark and that some stage serves vehicles. It never asserted
 * SAFETY: that the movements a stage greens together can actually be taken
 * together. That is the property below, and it is checked against the engine's
 * own conflict-point index rather than against an assumption about geometry,
 * so it holds for skewed and many-legged junctions too.
 *
 * The rule the simulation actually implements, and therefore the rule to test:
 *
 *   - a THROUGH movement on green is PROTECTED. `rightOfWay` returns
 *     'signalGreen' for it and it does not yield to anything;
 *   - every TURN is 'yield' even on a full green, so it must find a gap.
 *
 * So two protected through movements sharing a conflict point is a plan that
 * contradicts itself, and nothing downstream can rescue it. A turn conflicting
 * with anything is permissive and is resolved by gap acceptance.
 */

interface Fixture {
  readonly doc: RoadDoc;
  readonly net: Network;
  readonly sim: SimWorld;
}

function signalised(bearingsDeg: readonly number[], type = 3): Fixture {
  const doc = new RoadDoc();
  const centre = doc.addNode({ x: 0, y: 0 });
  for (const deg of bearingsDeg) {
    const r = (deg * Math.PI) / 180;
    const far = doc.addNode({ x: Math.cos(r) * 430, y: Math.sin(r) * 430 });
    doc.addSegment(centre.id, far.id, type);
  }
  doc.setNodeControl(centre.id, 'signal');
  const net = new Network(doc);
  net.rebuild();
  const sim = new SimWorld(doc, net, 0x5eed);
  sim.rebuildTopology();
  sim.trafficIntensity = 1.6;
  sim.demandMultiplier = 1.6;
  sim.clock.paused = false;
  return { doc, net, sim };
}

/** Every unsafe pair of simultaneously-protected movements, as text. */
function unsafePairs(fixture: Fixture): string[] {
  const { sim } = fixture;
  const bad: string[] = [];

  for (const controller of sim.controllers.values()) {
    const junction = sim.graph.junctions.get(controller.node);
    if (!junction) continue;

    for (const [index, stage] of controller.plan.stages.entries()) {
      const green = new Set(stage.greenGroups);
      if (green.size < 2) continue;

      const protectedMovements = junction.connectors
        .map((id) => sim.connector(id))
        .filter((c) => !!c && green.has(c.group) && c.turn === 'through');

      for (let i = 0; i < protectedMovements.length; i++) {
        for (let j = i + 1; j < protectedMovements.length; j++) {
          const a = protectedMovements[i];
          const b = protectedMovements[j];
          if (!a || !b || a.group === b.group) continue;
          if (sim.conflicts.conflict(a.id, b.id)) {
            bad.push(
              `node ${controller.node} stage ${index} greens ${[...green].join('+')}: ` +
                `${a.id} and ${b.id} are both protected and cross each other`,
            );
          }
        }
      }
    }
  }
  return bad;
}

describe('signal plans', () => {
  it('never greens two conflicting protected movements on a four-leg cross', () => {
    expect(unsafePairs(signalised([0, 90, 180, 270]))).toEqual([]);
  });

  it('never greens two conflicting protected movements on a skewed cross', () => {
    // Opposite-ish but not exactly 180 apart, which is where a tolerance-based
    // pairing rule is most likely to pair the wrong two approaches.
    expect(unsafePairs(signalised([0, 78, 186, 262]))).toEqual([]);
  });

  it('never greens two conflicting protected movements on a five-leg star', () => {
    expect(unsafePairs(signalised([0, 72, 144, 216, 288]))).toEqual([]);
  });

  it('never greens two conflicting protected movements on a three-leg T', () => {
    expect(unsafePairs(signalised([0, 90, 180]))).toEqual([]);
  });

  it('holds for every road class', () => {
    for (const type of [0, 1, 2, 3]) {
      expect(unsafePairs(signalised([0, 90, 180, 270], type)), `type ${type}`).toEqual([]);
    }
  });

  it('still serves every approach after pairing', () => {
    // Safety must not be bought by never greening anything.
    const fixture = signalised([0, 90, 180, 270]);
    const controller = [...fixture.sim.controllers.values()][0];
    expect(controller).toBeDefined();

    const served = new Set<number>();
    for (const stage of controller?.plan.stages ?? []) {
      for (const g of stage.greenGroups) served.add(g);
    }
    expect(served.size).toBe(controller?.plan.groups.length);
  });

  it('does not let two vehicles occupy the same conflict point', () => {
    // The live counterpart of the static check: run it and watch the claims.
    const fixture = signalised([0, 90, 180, 270]);
    const offences: string[] = [];

    fixture.sim.clock.run(Math.round(240 / DT), () => {
      step(fixture.sim, { traffic: true, pedestrians: true });

      const held = new Set<number>();
      for (const v of fixture.sim.vehicles.values()) {
        for (const p of fixture.sim.claims.points(v.id)) held.add(p);
      }
      for (const point of held) {
        const holders = fixture.sim.claims.holdersAt(point);
        if (holders.length < 2) continue;
        // Several holders are legal only on the SAME movement (a convoy), or
        // when their bodies cannot touch in that zone: sizes that never meet
        // there, or one of them already past it.
        const zone = fixture.sim.conflicts.points[point];
        for (let i = 0; i < holders.length; i++) {
          for (let j = i + 1; j < holders.length; j++) {
            const a = holders[i]!;
            const b = holders[j]!;
            if (a.connector === b.connector) continue;
            const sa = holderState(fixture.sim, a);
            const sb = holderState(fixture.sim, b);
            if (zone && sa && sb && zoneShareable(zone, { connector: a.connector, state: sa },
              { connector: b.connector, state: sb })) continue;
            offences.push(`point ${point} held by ${a.vehicle}@${a.connector}, ${b.vehicle}@${b.connector}`);
          }
        }
      }
    });

    expect(offences.slice(0, 5)).toEqual([]);
  });
});
