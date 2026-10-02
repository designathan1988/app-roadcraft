import { RoadDoc, type SerializedDoc } from '@world/doc';
import type { Network } from '@world/network';
import { repairNearConnections } from './repair';

/**
 * Undo/redo over serialized document snapshots.
 *
 * Snapshots hold only the authoring document — nodes, segments, curves. Derived
 * geometry, lanelets, signal plans and agents are all rebuilt from it, so there
 * is exactly one thing to save and no chance of restoring a half-consistent
 * mixture of model and cache.
 */
export class History {
  /**
   * Each snapshot kept as its JSON text: written once, immutable, and its size
   * is its length. Kept as objects, every edit serialized the town three times
   * and rebuilt a whole document from it - `toJSON`, `RoadDoc.fromJSON`,
   * `toJSON` again, and `JSON.stringify` only to count its bytes - which on a
   * town of furnished buildings made adding a storey take seconds.
   */
  private readonly undoStack: string[] = [];
  private readonly redoStack: string[] = [];
  /** Approximate bytes held by each stack's entries, index-aligned. */
  private readonly undoBytes: number[] = [];
  private readonly redoBytes: number[] = [];

  /**
   * `limit` steps, and at most `byteBudget` bytes of snapshots across both
   * stacks. A count alone let 120 copies of a large city (thousands of terrain
   * stamps, every building) grow to hundreds of megabytes.
   */
  constructor(private readonly limit = 60, private readonly byteBudget = 96 * 1024 * 1024) {}

  /** Bytes currently held, approximately (UTF-16 of the serialized snapshots). */
  get bytes(): number {
    return sum(this.undoBytes) + sum(this.redoBytes);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Records the document as it was BEFORE a mutation. */
  record(doc: RoadDoc): void {
    this.recordText(serialize(doc));
  }

  /** Records a snapshot already written as text (`serialize`), as it was BEFORE a mutation. */
  recordText(text: string): void {
    this.push(this.undoStack, this.undoBytes, text);
    this.redoStack.length = 0;
    this.redoBytes.length = 0;
    this.trim();
  }

  undo(current: RoadDoc): SerializedDoc | null {
    const previous = this.undoStack.pop();
    if (previous === undefined) return null;
    this.undoBytes.pop();
    this.push(this.redoStack, this.redoBytes, serialize(current));
    this.trim();
    return JSON.parse(previous) as SerializedDoc;
  }

  redo(current: RoadDoc): SerializedDoc | null {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.redoBytes.pop();
    this.push(this.undoStack, this.undoBytes, serialize(current));
    this.trim();
    return JSON.parse(next) as SerializedDoc;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.undoBytes.length = 0;
    this.redoBytes.length = 0;
  }

  private push(stack: string[], bytes: number[], text: string): void {
    stack.push(text);
    bytes.push(text.length * 2);
  }

  /** Drops the OLDEST undo steps past the count or the byte budget; the newest always stays. */
  private trim(): void {
    while (this.undoStack.length > this.limit) {
      this.undoStack.shift();
      this.undoBytes.shift();
    }
    while (this.undoStack.length > 1 && this.bytes > this.byteBudget) {
      this.undoStack.shift();
      this.undoBytes.shift();
    }
  }
}

/** A document as the text the history keeps. */
export function serialize(doc: RoadDoc): string {
  return JSON.stringify(doc.toJSON());
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/**
 * Loads data from OUTSIDE the running model - the autosave at boot, an
 * imported file: legacy repairs apply (coincident nodes merged, dead ends
 * left inside another road joined to it).
 */
export function restoreInto(target: RoadDoc, data: SerializedDoc, net: Network): void {
  target.replaceFromJSON(data);
  net.rebuild();
  repairNearConnections(target, net);
}

/**
 * Restores one of the model's own snapshots - undo, redo - exactly. Running
 * the legacy repair here made undo edit the map: a dead end the Move tool had
 * left inside a road was split into a junction the player never drew, and
 * undo and redo stopped being inverses.
 */
export function restoreSnapshot(target: RoadDoc, data: SerializedDoc, net: Network): void {
  target.replaceFromJSON(data, { repair: false });
  // `replaceWith` moves `revision` only when the roads differ: undoing a storey,
  // a pole or a brush dab leaves the network, and everything built on it, alone.
  if (net.revision !== target.revision) net.rebuild();
}
