/**
 * An exact digest of a stream of numbers: every double is hashed by its bits,
 * so two streams digest alike only if they are the same numbers in the same
 * order (a collision aside, at about one in 2^53).
 *
 * It is what lets a rebuild keep what an edit did not touch: a cached piece of
 * geometry is keyed by the digest of everything it was built from, and is
 * reused only when that digest comes round again. Nothing is quantised, so a
 * reused piece is bit for bit the piece a fresh build would make.
 */

const bits = new Float64Array(1);
const words = new Uint32Array(bits.buffer);

export class Digest {
  private a = 0x811c9dc5;
  private b = 0x9e3779b9;

  /** Adds one number. */
  add(value: number): this {
    bits[0] = value;
    this.word(words[0] as number);
    this.word(words[1] as number);
    return this;
  }

  /** Adds every number of an array, in order, and its length. */
  addAll(values: ArrayLike<number>): this {
    for (let i = 0; i < values.length; i++) this.add(values[i] as number);
    return this.add(values.length);
  }

  /** Adds a string, character by character. */
  addText(text: string): this {
    for (let i = 0; i < text.length; i++) this.word(text.charCodeAt(i));
    return this.add(text.length);
  }

  /** The digest so far, as an integer below 2^53. */
  value(): number {
    // A final avalanche on each lane, so nearby streams spread apart.
    let a = this.a;
    a = Math.imul(a ^ (a >>> 16), 0x85ebca6b);
    a = Math.imul(a ^ (a >>> 13), 0xc2b2ae35);
    a = (a ^ (a >>> 16)) >>> 0;
    let b = this.b;
    b = Math.imul(b ^ (b >>> 15), 0x2c1b3c6d);
    b = Math.imul(b ^ (b >>> 12), 0x297a2d39);
    b = (b ^ (b >>> 15)) >>> 0;
    return (a & 0x1fffff) * 0x1_0000_0000 + b;
  }

  private word(word: number): void {
    this.a = Math.imul(this.a ^ word, 0x01000193);
    this.b = Math.imul(this.b ^ word, 0x5bd1e995);
    this.b ^= this.b >>> 15;
  }
}
