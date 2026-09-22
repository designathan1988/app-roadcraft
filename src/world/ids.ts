/**
 * Branded id types.
 *
 * These are plain numbers at runtime but distinct types at compile time, so a
 * `SegmentId` can never be silently passed where a `NodeId` is expected. The V6
 * monolith used bare numbers and string keys interchangeably across ~120
 * functions.
 */
declare const NodeIdBrand: unique symbol;
declare const SegmentIdBrand: unique symbol;

export type NodeId = number & { readonly [NodeIdBrand]: true };
export type SegmentId = number & { readonly [SegmentIdBrand]: true };

export const asNodeId = (n: number): NodeId => n as NodeId;
export const asSegmentId = (n: number): SegmentId => n as SegmentId;

export class IdAllocator {
  private next: number;

  constructor(start = 1) {
    this.next = start;
  }

  take(): number {
    return this.next++;
  }

  /** Ensures future ids stay above `n`, after restoring a saved document. */
  reserve(n: number): void {
    if (n >= this.next) this.next = n + 1;
  }

  get peek(): number {
    return this.next;
  }
}
