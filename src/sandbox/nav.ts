import { Crowd, type CrowdAgent, NavMeshQuery, init as initRecast } from '@recast-navigation/core';
import { generateSoloNavMesh } from '@recast-navigation/generators';
import { type Mesh, Vector3 } from 'three';

/**
 * The sandbox's walkable ground, as games do it: a navigation mesh built by
 * Recast from the level's geometry (ground and obstacles), paths and local
 * avoidance by Detour's crowd (recast-navigation-js, the library the game's
 * crowd uses). Metres; y up.
 */
export interface Nav {
  /** The closest walkable point to `p`, or null off the mesh. */
  closest(p: Vector3): Vector3 | null;
  addAgent(at: Vector3): CrowdAgent;
  update(dt: number): void;
}

export const AGENT_RADIUS = 0.3;
const CS = 0.08;
const CH = 0.04;

export async function buildNav(meshes: readonly Mesh[]): Promise<Nav> {
  await initRecast();
  const positions: number[] = [];
  const indices: number[] = [];
  const v = new Vector3();
  for (const mesh of meshes) {
    mesh.updateMatrixWorld(true);
    const g = mesh.geometry;
    const pos = g.getAttribute('position');
    const base = positions.length / 3;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      positions.push(v.x, v.y, v.z);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) indices.push(base + g.index.getX(i));
    else for (let i = 0; i < pos.count; i++) indices.push(base + i);
  }
  const result = generateSoloNavMesh(positions, indices, {
    cs: CS,
    ch: CH,
    walkableSlopeAngle: 40,
    walkableHeight: Math.ceil(1.8 / CH),
    walkableClimb: Math.ceil(0.25 / CH),
    walkableRadius: Math.ceil(AGENT_RADIUS / CS),
    maxEdgeLen: 40,
    maxSimplificationError: 1.1,
    minRegionArea: 8,
    mergeRegionArea: 20,
    maxVertsPerPoly: 6,
    detailSampleDist: 6,
    detailSampleMaxError: 1,
  });
  if (!result.success) throw new Error('Navmesh do laboratório não foi gerada');
  const navMesh = result.navMesh;
  const query = new NavMeshQuery(navMesh);
  const crowd = new Crowd(navMesh, { maxAgents: 16, maxAgentRadius: 0.6 });
  return {
    closest(p) {
      const found = query.findClosestPoint({ x: p.x, y: p.y, z: p.z }, { halfExtents: { x: 1.5, y: 2, z: 1.5 } });
      return found.success ? new Vector3(found.point.x, found.point.y, found.point.z) : null;
    },
    addAgent(at) {
      return crowd.addAgent({ x: at.x, y: at.y, z: at.z }, {
        radius: AGENT_RADIUS,
        height: 1.8,
        maxSpeed: 1.35,
        maxAcceleration: 5,
        collisionQueryRange: AGENT_RADIUS * 8,
        pathOptimizationRange: AGENT_RADIUS * 30,
        separationWeight: 1.5,
      });
    },
    update(dt) {
      crowd.update(dt);
    },
  };
}
