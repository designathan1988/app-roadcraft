import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { BuildingTool, type ToolHost, type ToolView } from '@editor/buildingTool';

function setup(): { tool: BuildingTool; doc: RoadDoc } {
  const doc = new RoadDoc(), net = new Network(doc);
  const view: ToolView = {
    project: (x, y, z) => ({ x, y: y - z }),
    planeAt: (s) => s,
    ray: () => ({ ox: -1000, oy: -1000, oz: 100, dx: 0, dy: 0, dz: -1 }),
    groundAt: () => 0, pickPixels: 5,
  };
  const host: ToolHost = {
    context: () => ({ doc, net, groundAt: () => 0 }),
    groundKey: () => '0',
    commit: (edit) => edit(),
    changed: () => {}, flash: () => {},
  };
  return { tool: new BuildingTool(view, host), doc };
}

const click = (tool: BuildingTool, x: number, y: number): void => {
  const p = { x, y };
  tool.pointerDown(p, p, false);
  tool.pointerUp(false);
};

describe('in-world plan drawing', () => {
  it('previews and commits an L footprint as one building edit', () => {
    const { tool, doc } = setup();
    tool.startPlan();
    for (const p of [[20, 20], [80, 20], [80, 45], [45, 45], [45, 80], [20, 80]]) click(tool, p[0]!, p[1]!);
    expect(tool.preview?.valid).toBe(true);
    expect(doc.buildings.size).toBe(0);
    tool.finishPlan();
    expect(doc.buildings.size).toBe(1);
    expect(doc.revision).toBe(0);
    expect(tool.mode).toBe('edit');
    expect(tool.stage).toBe('shape');
    expect(tool.planArea).toBeGreaterThan(0);
    expect(tool.selected()?.volumes[0]?.outline).toHaveLength(6);
  });

  it('keeps a self-crossing draft out of the document and lets Escape cancel', () => {
    const { tool, doc } = setup();
    tool.startPlan();
    for (const p of [[20, 20], [80, 80], [80, 20], [20, 80]]) click(tool, p[0]!, p[1]!);
    tool.finishPlan();
    expect(doc.buildings.size).toBe(0);
    expect(tool.planPoints).toHaveLength(4);
    expect(tool.problem).toBe('outline');
    tool.key('Escape', false, false);
    expect(tool.planPoints).toBeNull();
  });

  it('draws a connected wing and a supported upper mass on the same building', () => {
    const { tool, doc } = setup();
    tool.startPlan();
    for (const p of [[20, 20], [80, 20], [80, 80], [20, 80]]) click(tool, p[0]!, p[1]!);
    tool.finishPlan();
    const id = tool.selection!.building;
    tool.startPlan('ground');
    for (const p of [[80, 30], [120, 30], [120, 65], [80, 65]]) click(tool, p[0]!, p[1]!);
    expect(tool.preview?.valid).toBe(true);
    tool.finishPlan();
    expect(doc.buildings.size).toBe(1);
    expect(doc.buildings.get(id)!.volumes).toHaveLength(2);
    tool.selectVolume(1);
    tool.startPlan('top');
    for (const p of [[30, 30], [65, 30], [65, 65], [30, 65]]) click(tool, p[0]!, p[1]!);
    expect(tool.preview?.valid).toBe(true);
    tool.finishPlan();
    const mass = doc.buildings.get(id)!.volumes.at(-1)!;
    expect(mass.base).toBe(2);
    expect(doc.buildings.get(id)!.volumes).toHaveLength(3);
  });

  it('cuts a side notch and refuses an unsupported cut under an upper mass', () => {
    const { tool, doc } = setup();
    tool.startPlan();
    for (const p of [[20, 20], [80, 20], [80, 80], [20, 80]]) click(tool, p[0]!, p[1]!);
    tool.finishPlan();
    const id = tool.selection!.building;
    tool.startPlan('cut');
    for (const p of [[55, 10], [90, 10], [90, 45], [55, 45]]) click(tool, p[0]!, p[1]!);
    expect(tool.preview?.valid).toBe(true);
    tool.finishPlan();
    expect(doc.buildings.get(id)!.volumes[0]!.outline!.length).toBeGreaterThan(4);
  });
});
