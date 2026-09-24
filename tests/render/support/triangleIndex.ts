import { Vector3, type BufferGeometry, type Matrix4 } from 'three';

/**
 * Triangles of some geometries in a uniform grid, for asking whether a short
 * segment crosses any of them - is this point of a seated body on the far
 * side of the bodywork from the seat it sits in?
 */
export class TriangleIndex {
  private readonly tris: Float32Array;
  private readonly cells = new Map<string, number[]>();
  readonly count: number;

  constructor(geometries: readonly { geometry: BufferGeometry; matrix?: Matrix4 }[], private readonly cell: number) {
    const all: number[] = [];
    const v = new Vector3();
    for (const { geometry, matrix } of geometries) {
      const g = geometry.index ? geometry.toNonIndexed() : geometry;
      const p = g.getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        if (matrix) v.applyMatrix4(matrix);
        all.push(v.x, v.y, v.z);
      }
    }
    this.tris = new Float32Array(all);
    this.count = all.length / 9;
    for (let t = 0; t < this.count; t++) {
      const o = t * 9;
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < 3; k++) {
        for (let c = 0; c < 3; c++) {
          lo[c] = Math.min(lo[c]!, this.tris[o + k * 3 + c]!);
          hi[c] = Math.max(hi[c]!, this.tris[o + k * 3 + c]!);
        }
      }
      for (let x = Math.floor(lo[0]! / cell); x <= Math.floor(hi[0]! / cell); x++) {
        for (let y = Math.floor(lo[1]! / cell); y <= Math.floor(hi[1]! / cell); y++) {
          for (let z = Math.floor(lo[2]! / cell); z <= Math.floor(hi[2]! / cell); z++) {
            const key = `${x},${y},${z}`;
            let list = this.cells.get(key);
            if (!list) this.cells.set(key, (list = []));
            list.push(t);
          }
        }
      }
    }
  }

  /**
   * The fraction along a->b of the first triangle it crosses, or null. Walks
   * the cells the segment's box covers, so it is meant for short segments.
   */
  firstHit(a: Vector3, b: Vector3): number | null {
    const c = this.cell;
    let best: number | null = null;
    const seen = new Set<number>();
    const x0 = Math.floor(Math.min(a.x, b.x) / c), x1 = Math.floor(Math.max(a.x, b.x) / c);
    const y0 = Math.floor(Math.min(a.y, b.y) / c), y1 = Math.floor(Math.max(a.y, b.y) / c);
    const z0 = Math.floor(Math.min(a.z, b.z) / c), z1 = Math.floor(Math.max(a.z, b.z) / c);
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const length = Math.hypot(dx, dy, dz);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      // Only cells the segment can pass through: its distance to the cell's
      // centre within the cell's half-diagonal.
      const cx = (x + 0.5) * c - a.x, cy = (y + 0.5) * c - a.y, cz = (z + 0.5) * c - a.z;
      const t = Math.max(0, Math.min(1, (cx * dx + cy * dy + cz * dz) / Math.max(1e-12, length * length)));
      const ex = cx - dx * t, ey = cy - dy * t, ez = cz - dz * t;
      if (ex * ex + ey * ey + ez * ez > 0.76 * c * c) continue;
      const list = this.cells.get(`${x},${y},${z}`);
      if (!list) continue;
      for (const tri of list) {
        if (seen.has(tri)) continue;
        seen.add(tri);
        const hit = this.segmentTriangle(a, dx, dy, dz, tri);
        if (hit !== null && (best === null || hit < best)) best = hit;
      }
    }
    return best;
  }

  /** Möller-Trumbore on the segment a + t (d), t in [0, 1]. */
  private segmentTriangle(a: Vector3, dx: number, dy: number, dz: number, tri: number): number | null {
    const T = this.tris;
    const o = tri * 9;
    const ax = T[o]!, ay = T[o + 1]!, az = T[o + 2]!;
    const e1x = T[o + 3]! - ax, e1y = T[o + 4]! - ay, e1z = T[o + 5]! - az;
    const e2x = T[o + 6]! - ax, e2y = T[o + 7]! - ay, e2z = T[o + 8]! - az;
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) return null;
    const inv = 1 / det;
    const sx = a.x - ax, sy = a.y - ay, sz = a.z - az;
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) return null;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) return null;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return t >= 0 && t <= 1 ? t : null;
  }
}
