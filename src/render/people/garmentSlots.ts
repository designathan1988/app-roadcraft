import type { PersonLook } from '@people/spec';
import { communityItem } from '@people/wardrobe';

/** Most garments drawn with their own texture on one person (each is one sampler in the crowd shader). */
export const MAX_TEXTURED = 5;

/** Items whose own texture is drawn: dyed items (hair, brows, beards) take the look's colour instead. */
const UNTEXTURED = new Set(['hair', 'eyebrows', 'eyelashes', 'beard']);

/**
 * The garments a person wears that are drawn with their own texture, in slot
 * order: the outfit first (slot 1, the one the outfit dye applies to), then
 * shoes, hat and the extras. `personRig.ts` writes each garment vertex's slot
 * and `skinAppearance.ts` binds one texture per slot, from this one list.
 */
export function texturedGarments(look: PersonLook): (string | undefined)[] {
  const extras = (look.extras ?? []).filter((name) => !UNTEXTURED.has(communityItem(name)?.kind ?? ''));
  return [look.outfit, look.footwear, look.hat === 'none' ? undefined : look.hat, ...extras].slice(0, MAX_TEXTURED);
}

/** A garment's slot (1-based) in `texturedGarments`, or 0 for an item drawn in its vertex colours. */
export function garmentSlotOf(look: PersonLook, name: string, kind: string): number {
  if (UNTEXTURED.has(kind)) return 0;
  return texturedGarments(look).indexOf(name) + 1;
}
