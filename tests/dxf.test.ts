import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ACI, aciToRgb, bulgePoints, DxfError, loadDxf, nurbsPoints, ocsMatrix, parseDxf, plainMText } from '../src/index.js';

/** A DXF file from group code pairs: [code, value, code, value, ...] per entity. */
function dxf(options: { header?: (string | number)[]; layers?: (string | number)[][]; blocks?: (string | number)[][]; entities: (string | number)[][] }): string {
  const lines: (string | number)[] = [];
  const pairs = (list: (string | number)[]) => lines.push(...list);
  if (options.header) pairs([0, 'SECTION', 2, 'HEADER', ...options.header, 0, 'ENDSEC']);
  if (options.layers) {
    pairs([0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER']);
    for (const l of options.layers) pairs([0, 'LAYER', ...l]);
    pairs([0, 'ENDTAB', 0, 'ENDSEC']);
  }
  if (options.blocks) {
    pairs([0, 'SECTION', 2, 'BLOCKS']);
    for (const b of options.blocks) pairs(b);
    pairs([0, 'ENDSEC']);
  }
  pairs([0, 'SECTION', 2, 'ENTITIES']);
  for (const e of options.entities) pairs(e);
  pairs([0, 'ENDSEC', 0, 'EOF']);
  return lines.join('\n') + '\n';
}

function objects(group: THREE.Object3D, kind?: string): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  group.traverse((o) => {
    if ((o as THREE.Mesh).geometry && (!kind || o.userData.dxf?.kind === kind)) out.push(o as THREE.Mesh);
  });
  return out;
}

const positions = (o: THREE.Object3D) => Array.from(((o as THREE.Mesh).geometry.getAttribute('position').array as Float32Array)).map((x) => Math.round(x * 1000) / 1000 + 0);

describe('colours', () => {
  it('has the standard ACI colours', () => {
    expect(ACI).toHaveLength(256);
    expect([1, 2, 3, 4, 5, 6, 8, 9].map((i) => ACI[i]!.toString(16).padStart(6, '0'))).toEqual(['ff0000', 'ffff00', '00ff00', '00ffff', '0000ff', 'ff00ff', '808080', 'c0c0c0']);
    expect([10, 11, 12, 13, 18, 20, 21, 250, 255].map((i) => ACI[i]!.toString(16).padStart(6, '0'))).toEqual(['ff0000', 'ff7f7f', 'cc0000', 'cc6666', '4c0000', 'ff3f00', 'ff9f7f', '333333', 'ffffff']);
    expect(aciToRgb(7)).toBe(0x000000);
    expect(aciToRgb(7, 'dark')).toBe(0xffffff);
  });
});

describe('geometry helpers', () => {
  it('draws a bulge of 1 as a half circle on the right of the direction of travel... below for left to right', () => {
    const pts = bulgePoints([0, 0, 0], [2, 0, 0], 1, 72);
    expect(pts[0]).toEqual([0, 0, 0]);
    expect(pts[pts.length - 1]).toEqual([2, 0, 0]);
    const mid = pts[Math.floor(pts.length / 2)]!;
    expect(mid[0]).toBeCloseTo(1);
    expect(mid[1]).toBeCloseTo(-1);
    // A negative bulge bends the other way.
    expect(bulgePoints([0, 0, 0], [2, 0, 0], -1, 72)[18]![1]).toBeGreaterThan(0);
  });

  it('follows the arbitrary axis algorithm', () => {
    // The OCS of normal (0, 0, -1) mirrors X.
    const p = new THREE.Vector3(1, 2, 3).applyMatrix4(ocsMatrix([0, 0, -1]));
    expect(p.toArray().map((x) => Math.round(x * 1e6) / 1e6 + 0)).toEqual([-1, 2, -3]);
    // Normal along X: OCS X is world Y.
    const q = new THREE.Vector3(1, 0, 0).applyMatrix4(ocsMatrix([1, 0, 0]));
    expect(q.toArray().map((x) => Math.round(x * 1e6) / 1e6 + 0)).toEqual([0, 1, 0]);
  });

  it('evaluates NURBS curves, rational ones included', () => {
    // A quarter circle as a rational quadratic.
    const w = Math.SQRT1_2;
    const pts = nurbsPoints(2, [0, 0, 0, 1, 1, 1], [[1, 0, 0], [1, 1, 0], [0, 1, 0]], [1, w, 1], 16);
    for (const p of pts) expect(Math.hypot(p[0], p[1])).toBeCloseTo(1, 6);
    expect(pts[0]).toEqual([1, 0, 0]);
    expect(pts[16]![0]).toBeCloseTo(0);
  });

  it('strips MTEXT formatting', () => {
    expect(plainMText('{\\fArial|b1;Bold} line\\Pnext \\H2.5x;big %%d')).toBe('Bold line\nnext big °');
  });
});

describe('entities', () => {
  it('draws lines, circles and arcs by layer colour', () => {
    const r = loadDxf(dxf({
      layers: [[2, 'Walls', 62, 1, 70, 0]],
      entities: [
        [0, 'LINE', 8, 'Walls', 10, 0, 20, 0, 30, 0, 11, 10, 21, 0, 31, 0],
        [0, 'CIRCLE', 8, 'Walls', 62, 3, 10, 5, 20, 5, 30, 0, 40, 2],
        [0, 'ARC', 8, 'Walls', 10, 0, 20, 0, 30, 0, 40, 1, 50, 0, 51, 90],
      ],
    }), { arcSegments: 36 });
    const lines = objects(r.group, 'lines');
    const red = lines.find((o) => o.userData.dxf.color === 0xff0000)!;
    const green = lines.find((o) => o.userData.dxf.color === 0x00ff00)!;
    expect(positions(red).slice(0, 6)).toEqual([0, 0, 0, 10, 0, 0]);
    // The quarter arc: 9 segments of 10 degrees.
    expect(red.geometry.getAttribute('position').count).toBe(2 + 9 * 2);
    expect(green.geometry.getAttribute('position').count).toBe(36 * 2);
    expect(r.group.children.map((c) => c.name)).toEqual(['Walls']);
    expect(r.group.rotation.x).toBe(0);
  });

  it('reads LWPOLYLINE bulges, closure and elevation in its OCS', () => {
    const r = loadDxf(dxf({
      entities: [[0, 'LWPOLYLINE', 90, 2, 70, 1, 38, 5, 10, 0, 20, 0, 42, 1, 10, 2, 20, 0, 210, 0, 220, 0, 230, -1]],
    }));
    const p = positions(objects(r.group, 'lines')[0]!);
    // Mirrored by the OCS: X and Z change sign.
    expect(p.slice(0, 3)).toEqual([-0, 0, -5].map((x) => x + 0));
    expect(Math.min(...p.filter((_, i) => i % 3 === 0))).toBeCloseTo(-2);
    expect(p.filter((_, i) => i % 3 === 2).every((z) => z === -5)).toBe(true);
  });

  it('fills SOLIDs in corner order 1, 2, 4, 3, and lights 3DFACEs', () => {
    const r = loadDxf(dxf({
      entities: [
        [0, 'SOLID', 10, 0, 20, 0, 30, 0, 11, 1, 21, 0, 31, 0, 12, 0, 22, 1, 32, 0, 13, 1, 23, 1, 33, 0],
        [0, '3DFACE', 10, 0, 20, 0, 30, 1, 11, 1, 21, 0, 31, 1, 12, 1, 22, 1, 32, 2, 13, 1, 23, 1, 33, 2],
      ],
    }));
    const fill = objects(r.group, 'fill')[0]!;
    expect(fill.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(fill.geometry.getAttribute('position').count).toBe(6);
    const faces = objects(r.group, 'faces')[0]!;
    expect(faces.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    // The 3DFACE's fourth corner repeats the third: one triangle.
    expect(faces.geometry.getAttribute('position').count).toBe(3);
    // Not flat: turned from Z up to Y up.
    expect(r.group.rotation.x).toBeCloseTo(-Math.PI / 2);
  });

  it('fills solid hatches with holes and skips pattern hatches', () => {
    const square = (s: number) => [92, 2, 72, 0, 73, 1, 93, 4, 10, -s, 20, -s, 10, s, 20, -s, 10, s, 20, s, 10, -s, 20, s];
    const r = loadDxf(dxf({
      entities: [
        [0, 'HATCH', 10, 0, 20, 0, 30, 0, 2, 'SOLID', 70, 1, 71, 0, 91, 2, ...square(2), 97, 0, ...square(1), 97, 0, 75, 0, 76, 1, 98, 0],
        [0, 'HATCH', 10, 0, 20, 0, 30, 0, 2, 'ANSI31', 70, 0, 71, 0, 91, 1, ...square(1), 97, 0, 75, 0, 76, 1, 98, 0],
      ],
    }));
    const fill = objects(r.group, 'fill')[0]!;
    const p = fill.geometry.getAttribute('position');
    let area = 0;
    for (let i = 0; i < p.count; i += 3) {
      area += new THREE.Triangle(new THREE.Vector3().fromBufferAttribute(p, i), new THREE.Vector3().fromBufferAttribute(p, i + 1), new THREE.Vector3().fromBufferAttribute(p, i + 2)).getArea();
    }
    expect(area).toBeCloseTo(16 - 4);
    expect(r.stats.skipped['HATCH pattern']).toBe(1);
  });

  it('expands inserts with base points, scale, rotation and arrays', () => {
    const r = loadDxf(dxf({
      blocks: [[0, 'BLOCK', 2, 'Tick', 70, 0, 10, 1, 20, 0, 30, 0, 0, 'LINE', 8, '0', 10, 1, 20, 0, 30, 0, 11, 2, 21, 0, 31, 0, 0, 'ENDBLK']],
      entities: [[0, 'INSERT', 8, '0', 2, 'Tick', 10, 10, 20, 0, 30, 0, 41, 2, 42, 2, 43, 2, 50, 90, 70, 2, 71, 1, 44, 5]],
    }));
    const p = positions(objects(r.group, 'lines')[0]!);
    // Base point to the insertion point, scaled 2, turned 90 degrees; the second column 5 along
    // the block's rotated X.
    expect(p).toEqual([10, 0, 0, 10, 2, 0, 10, 5, 0, 10, 7, 0]);
    expect(r.stats.inserts).toBe(2);
  });

  it('gives block entities on layer 0 the insert’s layer, and ByBlock entities its colour', () => {
    const r = loadDxf(dxf({
      layers: [[2, 'Doors', 62, 5, 70, 0], [2, '0', 62, 7, 70, 0]],
      blocks: [[0, 'BLOCK', 2, 'B', 70, 0, 10, 0, 20, 0, 30, 0,
        0, 'LINE', 8, '0', 62, 0, 10, 0, 20, 0, 30, 0, 11, 1, 21, 0, 31, 0,
        0, 'LINE', 8, '0', 62, 256, 10, 0, 20, 1, 30, 0, 11, 1, 21, 1, 31, 0,
        0, 'ENDBLK']],
      entities: [[0, 'INSERT', 8, 'Doors', 62, 1, 2, 'B', 10, 0, 20, 0, 30, 0]],
    }));
    const lines = objects(r.group, 'lines');
    expect(lines.map((o) => [o.userData.dxf.layer, o.userData.dxf.color]).sort()).toEqual([
      ['Doors', 0xff0000],
      ['Doors', 0x0000ff],
    ]);
  });

  it('hides layers that are off or frozen, or leaves them out', () => {
    const text = dxf({
      layers: [[2, 'Off', 62, -1, 70, 0], [2, 'Frozen', 62, 2, 70, 1]],
      entities: [
        [0, 'LINE', 8, 'Off', 10, 0, 20, 0, 30, 0, 11, 1, 21, 0, 31, 0],
        [0, 'LINE', 8, 'Frozen', 10, 0, 20, 0, 30, 0, 11, 1, 21, 0, 31, 0],
      ],
    });
    const r = loadDxf(text);
    expect(r.group.children.map((c) => [c.name, c.visible])).toEqual([['Frozen', false], ['Off', false]]);
    expect(loadDxf(text, { hiddenLayers: false }).group.children).toHaveLength(0);
  });

  it('scales by $INSUNITS and leaves out paper space', () => {
    const r = loadDxf(dxf({
      header: [9, '$ACADVER', 1, 'AC1015', 9, '$INSUNITS', 70, 4],
      entities: [
        [0, 'LINE', 10, 0, 20, 0, 30, 0, 11, 1000, 21, 0, 31, 0],
        [0, 'LINE', 67, 1, 10, 0, 20, 0, 30, 0, 11, 5, 21, 0, 31, 0],
      ],
    }));
    expect(r.version).toBe('AC1015');
    expect(r.unitScale).toBe(0.001);
    expect(new THREE.Box3().setFromObject(r.group).getSize(new THREE.Vector3()).x).toBeCloseTo(1);
    expect(r.stats.segments).toBe(1);
  });

  it('reads polyface meshes and polygon meshes', () => {
    const r = loadDxf(dxf({
      entities: [
        [0, 'POLYLINE', 66, 1, 70, 64, 71, 4, 72, 1,
          0, 'VERTEX', 70, 192, 10, 0, 20, 0, 30, 0,
          0, 'VERTEX', 70, 192, 10, 1, 20, 0, 30, 0,
          0, 'VERTEX', 70, 192, 10, 1, 20, 1, 30, 1,
          0, 'VERTEX', 70, 192, 10, 0, 20, 1, 30, 1,
          0, 'VERTEX', 70, 128, 10, 0, 20, 0, 30, 0, 71, 1, 72, 2, 73, -3, 74, 4,
          0, 'SEQEND'],
        [0, 'POLYLINE', 66, 1, 70, 16, 71, 2, 72, 3,
          0, 'VERTEX', 70, 64, 10, 0, 20, 0, 30, 0, 0, 'VERTEX', 70, 64, 10, 0, 20, 1, 30, 0, 0, 'VERTEX', 70, 64, 10, 0, 20, 2, 30, 0,
          0, 'VERTEX', 70, 64, 10, 1, 20, 0, 30, 1, 0, 'VERTEX', 70, 64, 10, 1, 20, 1, 30, 1, 0, 'VERTEX', 70, 64, 10, 1, 20, 2, 30, 1,
          0, 'SEQEND'],
      ],
    }));
    expect(r.stats.triangles).toBe(2 + 4);
  });

  it('returns text, which is not drawn', () => {
    const r = loadDxf(dxf({ entities: [[0, 'TEXT', 8, 'Notes', 10, 3, 20, 4, 30, 0, 40, 2.5, 50, 30, 1, 'Room %%d 12']] }));
    expect(r.texts).toEqual([{ text: 'Room ° 12', position: [3, 4, 0], height: 2.5, rotation: Math.PI / 6, layer: 'Notes', color: 0 }]);
  });
});

describe('parsing', () => {
  it('refuses files that are not DXF, and keeps what comes before damage', () => {
    expect(() => parseDxf('hello\nworld\n')).toThrow(DxfError);
    const damaged = dxf({ entities: [[0, 'LINE', 10, 0, 20, 0, 30, 0, 11, 1, 21, 0, 31, 0]] }).replace('0\nEOF', 'xx\nbroken\n0\nEOF');
    const r = loadDxf(damaged);
    expect(r.stats.segments).toBe(1);
    expect(r.warnings[0]).toMatch(/damaged/);
  });

  it('reads binary DXF', () => {
    // 2-byte group codes, as AutoCAD writes from R13 on.
    const parts: number[] = [...new TextEncoder().encode('AutoCAD Binary DXF\r\n\x1a\0')];
    const code = (c: number) => parts.push(c & 255, c >> 8);
    const str = (s: string) => parts.push(...new TextEncoder().encode(s), 0);
    const dbl = (x: number) => {
      const b = new DataView(new ArrayBuffer(8));
      b.setFloat64(0, x, true);
      parts.push(...new Uint8Array(b.buffer));
    };
    code(0); str('SECTION'); code(2); str('ENTITIES');
    code(0); str('LINE'); code(8); str('L1');
    code(10); dbl(1); code(20); dbl(2); code(30); dbl(0); code(11); dbl(4); code(21); dbl(6); code(31); dbl(0);
    code(0); str('ENDSEC'); code(0); str('EOF');
    const r = loadDxf(Uint8Array.from(parts));
    expect(positions(objects(r.group, 'lines')[0]!)).toEqual([1, 2, 0, 4, 6, 0]);
  });
});
