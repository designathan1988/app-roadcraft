import { describe, expect, it } from 'vitest';

import { defaultPerson, normalizePerson, randomPerson } from '@people/spec';
import { RoadDoc } from '@world/doc';
import { isSerializedDoc } from '@editor/persistence';

describe('people saved with the city', () => {
  it('come back from a save exactly as they were', () => {
    const doc = new RoadDoc();
    const a = randomPerson(doc.nextPersonId(), 7);
    doc.savePerson({ ...a, name: 'Ana' });
    const b = randomPerson(doc.nextPersonId(), 8);
    doc.savePerson(b);
    expect(doc.people.length).toBe(2);
    const json = JSON.parse(JSON.stringify(doc.toJSON()));
    expect(isSerializedDoc(json)).toBe(true);
    const back = RoadDoc.fromJSON(json);
    expect(back.people).toEqual(doc.people);
    expect(back.people[0]!.name).toBe('Ana');
  });

  it('leave a city without people serialised as before', () => {
    expect('people' in new RoadDoc().toJSON()).toBe(false);
  });

  it('are brought into range when read from outside, and junk is dropped', () => {
    const p = normalizePerson({
      id: 3, name: 'x'.repeat(200), body: { gender: 7, age: -1, weight: 'heavy' },
      features: { 'nose-flaring-decr-incr': 5, bad: Number.NaN },
      look: { skin: -5, hairStyle: 'mohawk', top: 'tshirt', topColour: 0x123456 },
    })!;
    expect(p.name.length).toBe(40);
    expect(p.body.gender).toBe(1);
    expect(p.body.age).toBe(0);
    expect(p.body.weight).toBe(0.5);
    expect(p.features).toEqual({ 'nose-flaring-decr-incr': 1 });
    expect(p.look.skin).toBe(defaultPerson(0).look.skin);
    expect(p.look.hairStyle).toBe(defaultPerson(0).look.hairStyle);
    expect(p.look.topColour).toBe(0x123456);
    expect(normalizePerson({ id: 'one' })).toBeNull();
    expect(normalizePerson(null)).toBeNull();
    expect(isSerializedDoc({ version: 1, nodes: [], segments: [], people: 'nobody' })).toBe(false);
  });

  it('can be undone like any other edit', () => {
    const doc = new RoadDoc();
    const before = doc.clone();
    doc.savePerson(randomPerson(1, 1));
    expect(doc.peopleRevision).toBe(1);
    doc.replaceWith(before);
    expect(doc.people.length).toBe(0);
    expect(doc.peopleRevision).toBe(2);
  });

  it('draws strangers of every kind from seeds', () => {
    const people = Array.from({ length: 200 }, (_, i) => randomPerson(i, i * 7919 + 1));
    expect(people.some((p) => p.body.gender < 0.3)).toBe(true);
    expect(people.some((p) => p.body.gender > 0.7)).toBe(true);
    expect(new Set(people.map((p) => p.look.skin)).size).toBeGreaterThan(6);
    expect(people.some((p) => p.look.bottom === 'skirt')).toBe(true);
    expect(randomPerson(1, 42)).toEqual(randomPerson(1, 42));
  });
});
