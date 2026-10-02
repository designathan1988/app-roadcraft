import type { MacroParams } from './body/macro';

const unit = (v: number): number => Math.max(0, Math.min(1, v));
const mix = (a: number, b: number, t: number): number => {
  let colour = 0;
  for (const shift of [16, 8, 0]) {
    const x = (a >> shift) & 255, y = (b >> shift) & 255;
    colour |= Math.round(x + (y - x) * unit(t)) << shift;
  }
  return colour;
};

/** Continuous authored skin palette, stored as sRGB for the material colour. */
export function skinColour(melanin: number, undertone: number): number {
  return mix(mix(0xe6c6ae, 0xd8b59c, undertone), mix(0x604638, 0x755342, undertone), melanin);
}

/** Art-directed continuous appearance, with variation inside every ancestry mix. */
export function phenotype(body: MacroParams, random: () => number) {
  const sum = body.african + body.asian + body.caucasian || 1;
  const african = body.african / sum, asian = body.asian / sum;
  const melanin = unit(0.12 + african * 0.62 + asian * 0.24 + (random() + random() - 1) * 0.22);
  const undertone = random();
  const skin = skinColour(melanin, undertone);
  const paleHair = random() < (1 - melanin) ** 3 * 0.25;
  const redHair = !paleHair && random() < (1 - melanin) * 0.025;
  const pigment = paleHair ? mix(0x8b704e, 0xc7b27d, random())
    : redHair ? mix(0x63351f, 0x965637, random()) : mix(0x201b18, 0x684b35, random());
  const grey = unit((body.age - 0.65) / 0.35 + (random() - 0.5) * 0.2);
  const hair = mix(pigment, 0xc9c6c0, grey);
  const clearEyes = random() < (1 - melanin) ** 2 * 0.28;
  const eyes = clearEyes ? mix(0x526a72, 0x687251, random()) : mix(0x302218, 0x715234, random());
  return { skin, hair, eyes, melanin, undertone };
}
