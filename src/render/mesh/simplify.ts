import { BufferAttribute, type BufferGeometry } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer';

/**
 * A coarser copy of a mesh for when it is a few pixels big: welded, then
 * simplified edge by edge with meshoptimizer, keeping its silhouette and its
 * colours (`color` weighs in the error). `ratio` is the share of triangles
 * aimed at, `error` the deviation allowed as a share of the mesh's size.
 * Resolves to the source itself when the simplifier cannot run.
 */
export async function simplified(source: BufferGeometry, ratio: number, error: number): Promise<BufferGeometry> {
  try {
    await MeshoptSimplifier.ready;
  } catch {
    return source;
  }
  const welded = mergeVertices(source.clone(), 1e-4);
  const index = welded.getIndex();
  const position = welded.getAttribute('position');
  if (!index || !position) return source;
  const positions = new Float32Array(position.array as ArrayLike<number>);
  const colour = welded.getAttribute('color');
  const colours = colour ? new Float32Array(colour.array as ArrayLike<number>) : null;
  const indices = new Uint32Array(index.array as ArrayLike<number>);
  const target = Math.max(3, Math.floor((indices.length * ratio) / 3) * 3);
  const [kept] = colours
    ? MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, colours, 3, [0.5, 0.5, 0.5], null, target, error, [])
    : MeshoptSimplifier.simplify(indices, positions, 3, target, error, []);
  welded.setIndex(new BufferAttribute(kept, 1));
  welded.computeBoundingSphere();
  welded.computeBoundingBox();
  return welded;
}
