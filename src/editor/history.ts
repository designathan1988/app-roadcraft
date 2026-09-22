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
  private readonly undoStack: SerializedDoc[] = [];
  private readonly redoStack: SerializedDoc[] = [];

  constructor(private readonly limit = 60) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Records the document as it was BEFORE a mutation. */
  record(doc: RoadDoc): void {
    this.undoStack.push(doc.toJSON());
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo(current: RoadDoc): SerializedDoc | null {
    const previous = this.undoStack.pop();
    if (!previous) return null;
    this.redoStack.push(current.toJSON());
    return previous;
  }

  redo(current: RoadDoc): SerializedDoc | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(current.toJSON());
    return next;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}

/** Replaces a document's contents in place from a snapshot. */
export function restoreInto(target: RoadDoc, data: SerializedDoc, net: Network): void {
  target.replaceFromJSON(data);
  net.rebuild();
  repairNearConnections(target, net);
}
