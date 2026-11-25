// Loads real DXF files from GDAL's test data (see samples/README.md).

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DxfError, loadDxf } from '../src/index.js';

const dir = fileURLToPath(new URL('./samples/', import.meta.url));
const load = (name: string) => loadDxf(new Uint8Array(readFileSync(`${dir}${name}.dxf`)));

describe('GDAL sample files', () => {
  it('reads every file without bad coordinates, apart from one that is not DXF', () => {
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.dxf')).map((n) => n.replace('.dxf', ''))) {
      if (name.includes('shape_fuzzer')) {
        expect(() => load(name)).toThrow(DxfError);
        continue;
      }
      const r = load(name);
      r.group.traverse((o) => {
        const g = (o as THREE.Mesh).geometry;
        if (g) expect(Array.from(g.getAttribute('position').array as Float32Array).every(Number.isFinite), name).toBe(true);
      });
    }
  });

  it('reads an assortment of entities from AutoCAD 2000, in millimetres', () => {
    const r = load('assorted');
    expect(r.version).toBe('AC1015');
    expect(r.unitScale).toBe(0.001);
    expect(r.stats).toMatchObject({ entities: 17, points: 1, inserts: 1 });
    expect(r.texts.map((t) => t.text)).toEqual(['Test', 'Text Sample1¿λ\n"abc"', 'Second']);
  });

  it('reads binary DXF from R12 and R2000', () => {
    const r12 = load('bin_dxf_r12');
    expect(r12.version).toBe('AC1009');
    expect(r12.stats.segments).toBe(3);
    const r2000 = load('bin_dxf_r2000');
    expect(r2000.version).toBe('AC1015');
    expect(r2000.texts).toHaveLength(1);
  });

  it('reads hatches with arc and elliptical arc edges', () => {
    const area = (name: string) => {
      let sum = 0;
      load(name).group.traverse((o) => {
        if (!(o as THREE.Mesh).isMesh) return;
        const p = (o as THREE.Mesh).geometry.getAttribute('position');
        for (let i = 0; i < p.count; i += 3) {
          sum += new THREE.Triangle(new THREE.Vector3().fromBufferAttribute(p, i), new THREE.Vector3().fromBufferAttribute(p, i + 1), new THREE.Vector3().fromBufferAttribute(p, i + 2)).getArea();
        }
      });
      return sum;
    };
    // Two ellipses of semi-axes 60 and 5, each with a small notch cut by its line edges.
    const ellipses = area('elliptical-arc-hatch-min');
    expect(ellipses).toBeLessThan(2 * Math.PI * 60 * 5);
    expect(ellipses).toBeGreaterThan(2 * Math.PI * 60 * 5 * 0.98);
    expect(area('hatch')).toBeGreaterThan(0);
  });

  it('draws the OCS sample symmetrically', () => {
    const box = new THREE.Box3().setFromObject(load('ocs2wcs1').group);
    // The drawing is laid out about the origin, one copy in each quadrant.
    expect(box.min.x).toBeCloseTo(-box.max.x, 1);
    expect(box.min.y).toBeCloseTo(-box.max.y, 1);
  });

  it('colours ByBlock and ByLayer entities through blocks', () => {
    const r = load('byblock-bylayer');
    const colors = new Set<number>();
    r.group.traverse((o) => {
      if (o.userData.dxf?.color !== undefined) colors.add(o.userData.dxf.color);
    });
    expect(colors.size).toBeGreaterThan(3);
  });

  it('hides layers that are off or frozen', () => {
    const r = load('frozen-off');
    expect(r.group.children.map((l) => [l.name, l.visible])).toEqual([
      ['OFFFREEZE', false],
      ['OFFTHAW', false],
      ['ONFREEZE', false],
      ['ONTHAW', true],
    ]);
  });

  it('reads UTF-8 layer names', () => {
    expect(load('utf-8').group.children[0]!.name).toBe('éven');
  });

  it('stops at a block that inserts itself', () => {
    const r = load('insert-recursive-pair');
    expect(r.warnings.some((w) => w.includes('contains itself'))).toBe(true);
  });

  it('reads a file with a missing SECTION line', () => {
    const r = load('text');
    expect(r.texts).toHaveLength(1);
  });

  it('keeps what comes before damage in a fuzzed file', () => {
    const r = load('clusterfuzz-testcase-minimized-dxf_fuzzer-5400376672124928');
    expect(r.warnings[0]).toMatch(/damaged/);
  });

  it('turns 3D drawings Y up and leaves flat ones facing the camera', () => {
    expect(load('3d').group.rotation.x).toBeCloseTo(-Math.PI / 2);
    expect(load('hatch').group.rotation.x).toBe(0);
  });
});
