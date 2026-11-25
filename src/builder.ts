// Turns DXF entities into three.js objects. Entities are converted to world coordinates, blocks
// are expanded at each insert, and everything is gathered into one object per layer, colour and
// kind (lines, points, filled areas and lit faces), grouped by layer.

import * as THREE from 'three';
import { aciToRgb } from './colors.js';
import { decodeDxfString, num, value, type DxfDocument, type DxfEntity, type GroupCode } from './dxf.js';

export interface DxfOptions {
  /** Colour 7 and the like are drawn for this background. Default light: colour 7 is black. */
  background?: 'light' | 'dark';
  /**
   * auto (the default): a flat drawing in the XY plane stays in that plane, facing the camera;
   * a 3D drawing is turned from Z up to three.js's Y up. z-up and xy force one or the other.
   */
  orientation?: 'auto' | 'z-up' | 'xy';
  /** Segments for a full circle; arcs get their share. Default 72. */
  arcSegments?: number;
  /** Metres per drawing unit, overriding $INSUNITS. Drawings without units are left unscaled. */
  unitScale?: number;
  /** Adds layers that are off or frozen, hidden. Default true; false leaves them out. */
  hiddenLayers?: boolean;
}

export interface DxfText {
  text: string;
  /** World position of the insertion point, in drawing units before scaling and turning. */
  position: [number, number, number];
  height: number;
  /** Rotation in radians around the text's normal. */
  rotation: number;
  layer: string;
  color: number;
}

export interface DxfStats {
  entities: number;
  segments: number;
  triangles: number;
  points: number;
  inserts: number;
  /** Entities that are not drawn, by type. */
  skipped: Record<string, number>;
}

/** userData.dxf on objects the importer makes. */
export interface DxfUserData {
  dxf: { kind: 'drawing' | 'layer' | 'lines' | 'points' | 'fill' | 'faces'; layer?: string; color?: number };
  [key: string]: unknown;
}

type V3 = [number, number, number];
type Kind = 'lines' | 'points' | 'fill' | 'faces';

interface Ctx {
  matrix: THREE.Matrix4;
  /** Layer that entities on layer 0 take, inside a block. */
  layer: string | null;
  /** Colour that ByBlock entities take. */
  color: number | null;
  stack: string[];
}

const UNITS: Record<number, number> = {
  1: 0.0254, 2: 0.3048, 3: 1609.344, 4: 0.001, 5: 0.01, 6: 1, 7: 1000, 8: 2.54e-8, 9: 2.54e-5, 10: 0.9144, 11: 1e-10,
  12: 1e-9, 13: 1e-6, 14: 0.1, 15: 10, 16: 100, 17: 1e9, 18: 1.495978707e11, 19: 9.4607304725808e15, 20: 3.0856775814913673e16,
};

const pt = (codes: GroupCode[], base: number, fallback: V3 = [0, 0, 0]): V3 => [num(codes, base, fallback[0]), num(codes, base + 10, fallback[1]), num(codes, base + 20, fallback[2])];

/** The arbitrary axis algorithm: the matrix from an entity's object coordinate system to world. */
export function ocsMatrix(normal: V3): THREE.Matrix4 {
  const n = new THREE.Vector3(...normal);
  if (n.lengthSq() === 0) n.set(0, 0, 1);
  n.normalize();
  if (Math.abs(n.x - 0) < 1e-12 && Math.abs(n.y) < 1e-12 && n.z > 0) return new THREE.Matrix4();
  const ax = Math.abs(n.x) < 1 / 64 && Math.abs(n.y) < 1 / 64 ? new THREE.Vector3(0, 1, 0).cross(n) : new THREE.Vector3(0, 0, 1).cross(n);
  ax.normalize();
  const ay = n.clone().cross(ax).normalize();
  return new THREE.Matrix4().makeBasis(ax, ay, n);
}

/** Points of an arc from a to b (radians, anticlockwise) around a centre, in its plane. */
function arcPoints(cx: number, cy: number, r: number, a: number, b: number, segmentsPerCircle: number, z = 0): V3[] {
  let sweep = b - a;
  while (sweep <= 0) sweep += Math.PI * 2;
  const n = Math.max(2, Math.ceil((sweep / (Math.PI * 2)) * segmentsPerCircle));
  const out: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = a + (sweep * i) / n;
    out.push([cx + r * Math.cos(t), cy + r * Math.sin(t), z]);
  }
  return out;
}

/** Points along a polyline segment with a bulge (the tangent of a quarter of the arc's angle). */
export function bulgePoints(p1: V3, p2: V3, bulge: number, segmentsPerCircle: number): V3[] {
  if (Math.abs(bulge) < 1e-12) return [p1, p2];
  const theta = 4 * Math.atan(bulge);
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const d = Math.hypot(dx, dy);
  if (d === 0) return [p1, p2];
  const r = d / (2 * Math.sin(theta / 2));
  const a = Math.atan2(dy, dx) + Math.PI / 2 - theta / 2;
  const cx = p1[0] + r * Math.cos(a);
  const cy = p1[1] + r * Math.sin(a);
  const start = Math.atan2(p1[1] - cy, p1[0] - cx);
  const n = Math.max(2, Math.ceil((Math.abs(theta) / (Math.PI * 2)) * segmentsPerCircle));
  const radius = Math.abs(r);
  const out: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = start + (theta * i) / n;
    const z = p1[2] + ((p2[2] - p1[2]) * i) / n;
    out.push([cx + radius * Math.cos(t), cy + radius * Math.sin(t), z]);
  }
  out[0] = p1;
  out[out.length - 1] = p2;
  return out;
}

/** Points of a NURBS curve, by de Boor's algorithm. */
export function nurbsPoints(degree: number, knots: number[], control: V3[], weights: number[], samples: number): V3[] {
  const n = control.length;
  if (n === 0) return [];
  if (n <= degree || knots.length !== n + degree + 1) return control;
  const w = control.map((_, i) => weights[i] ?? 1);
  const lo = knots[degree]!;
  const hi = knots[n]!;
  const out: V3[] = [];
  for (let s = 0; s <= samples; s++) {
    const u = Math.min(lo + ((hi - lo) * s) / samples, hi - 1e-12 * Math.max(1, Math.abs(hi)));
    let k = degree;
    while (k < n - 1 && u >= knots[k + 1]!) k++;
    // Homogeneous control points for the span.
    const d = Array.from({ length: degree + 1 }, (_, j) => {
      const i = k - degree + j;
      const p = control[i]!;
      return [p[0] * w[i]!, p[1] * w[i]!, p[2] * w[i]!, w[i]!];
    });
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = k - degree + j;
        const denom = knots[i + degree - r + 1]! - knots[i]!;
        const alpha = denom === 0 ? 0 : (u - knots[i]!) / denom;
        for (let c = 0; c < 4; c++) d[j]![c] = (1 - alpha) * d[j - 1]![c]! + alpha * d[j]![c]!;
      }
    }
    const h = d[degree]!;
    out.push(h[3] ? [h[0]! / h[3], h[1]! / h[3], h[2]! / h[3]] : [h[0]!, h[1]!, h[2]!]);
  }
  return out;
}

/** Removes MTEXT formatting codes, keeping the text. */
export function plainMText(s: string): string {
  return decodeDxfString(s)
    .replace(/\\P/g, '\n')
    .replace(/\\[ACcFfHhQTtWw][^;]*;/g, '')
    .replace(/\\S([^;]*?)[#^/]([^;]*);/g, '$1/$2')
    .replace(/\\[LlOoKk]/g, '')
    .replace(/\\~/g, ' ')
    .replace(/\\\\/g, '\\')
    .replace(/[{}]/g, '');
}

/**
 * Points of a hatch boundary arc or elliptical arc, in path order. Angles are in degrees, measured
 * from the major axis (unlike ELLIPSE entities, whose angles are parameters); for a clockwise edge
 * they are stored mirrored, so the curve runs through the negated angles. A circle of radius r has
 * major axis (r, 0) and ratio 1.
 */
function edgeArc(cx: number, cy: number, mx: number, my: number, ratio: number, startDeg: number, endDeg: number, ccw: boolean, segmentsPerCircle: number): V3[] {
  let ga = (startDeg * Math.PI) / 180;
  let gb = (endDeg * Math.PI) / 180;
  while (gb <= ga) gb += Math.PI * 2;
  if (gb - ga > Math.PI * 2 + 1e-9) gb = ga + Math.PI * 2;
  // The angles are geometric angles from the major axis; the curve is drawn by its parameter.
  const param = (g: number) => Math.atan2(Math.sin(g) / ratio, Math.cos(g));
  const a = param(ga);
  let b = param(gb);
  b += Math.PI * 2 * Math.round((gb - ga - (b - a)) / (Math.PI * 2));
  const n = Math.max(2, Math.ceil(((b - a) / (Math.PI * 2)) * segmentsPerCircle));
  const out: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const s = a + ((b - a) * i) / n;
    const t = ccw ? s : -s;
    const c = Math.cos(t);
    const sn = Math.sin(t);
    out.push([cx + mx * c - my * ratio * sn, cy + my * c + mx * ratio * sn, 0]);
  }
  return out;
}

class Bucket {
  readonly positions: number[] = [];
}

export class DxfBuilder {
  readonly warnings: string[] = [];
  readonly texts: DxfText[] = [];
  readonly stats: DxfStats = { entities: 0, segments: 0, triangles: 0, points: 0, inserts: 0, skipped: {} };
  private readonly buckets = new Map<string, Bucket>();
  private readonly warned = new Set<string>();
  private readonly options: Required<Omit<DxfOptions, 'unitScale'>> & { unitScale?: number };
  private readonly v = new THREE.Vector3();

  constructor(
    readonly doc: DxfDocument,
    options: DxfOptions = {},
  ) {
    this.options = {
      background: options.background ?? 'light',
      orientation: options.orientation ?? 'auto',
      arcSegments: Math.max(8, options.arcSegments ?? 72),
      hiddenLayers: options.hiddenLayers ?? true,
      ...(options.unitScale !== undefined ? { unitScale: options.unitScale } : {}),
    };
    this.warnings.push(...doc.warnings);
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warnings.push(message);
  }

  private skip(type: string, reason?: string): void {
    this.stats.skipped[type] = (this.stats.skipped[type] ?? 0) + 1;
    if (reason) this.warnOnce(`skip:${type}`, reason);
  }

  // Colours and layers.

  private layerColor(layer: string): number {
    const l = this.doc.layers.get(layer.toUpperCase());
    if (!l) return aciToRgb(7, this.options.background);
    return l.trueColor ?? aciToRgb(l.color, this.options.background);
  }

  private entityLayer(e: DxfEntity, ctx: Ctx): string {
    const layer = value(e.codes, 8) ?? '0';
    return layer === '0' && ctx.layer ? ctx.layer : layer;
  }

  private entityColor(e: DxfEntity, layer: string, ctx: Ctx): number {
    const tc = value(e.codes, 420);
    if (tc !== undefined) return Number(tc) & 0xffffff;
    const aci = num(e.codes, 62, 256);
    if (aci === 256) return this.layerColor(layer);
    if (aci === 0) return ctx.color ?? aciToRgb(7, this.options.background);
    return aciToRgb(aci, this.options.background);
  }

  // Output.

  private bucket(layer: string, color: number, kind: Kind): Bucket {
    const key = `${layer}\u0000${color}\u0000${kind}`;
    let b = this.buckets.get(key);
    if (!b) this.buckets.set(key, (b = new Bucket()));
    return b;
  }

  private push(b: Bucket, m: THREE.Matrix4, p: V3): void {
    this.v.set(p[0], p[1], p[2]).applyMatrix4(m);
    b.positions.push(this.v.x, this.v.y, this.v.z);
  }

  private polyline(e: DxfEntity, ctx: Ctx, points: V3[], local: THREE.Matrix4 | null, closed = false): void {
    if (points.length < 2) return;
    const layer = this.entityLayer(e, ctx);
    const b = this.bucket(layer, this.entityColor(e, layer, ctx), 'lines');
    const m = local ? ctx.matrix.clone().multiply(local) : ctx.matrix;
    const pts = closed ? [...points, points[0]!] : points;
    for (let i = 0; i + 1 < pts.length; i++) {
      this.push(b, m, pts[i]!);
      this.push(b, m, pts[i + 1]!);
    }
    this.stats.segments += pts.length - 1;
  }

  /** Adds triangles: filled areas (unlit) or 3D faces (lit). */
  private triangles(e: DxfEntity, ctx: Ctx, tris: V3[], local: THREE.Matrix4 | null, kind: 'fill' | 'faces'): void {
    if (tris.length < 3) return;
    const layer = this.entityLayer(e, ctx);
    const b = this.bucket(layer, this.entityColor(e, layer, ctx), kind);
    const m = local ? ctx.matrix.clone().multiply(local) : ctx.matrix;
    for (const p of tris) this.push(b, m, p);
    this.stats.triangles += tris.length / 3;
  }

  // Entities.

  build(): THREE.Group {
    const root: Ctx = { matrix: new THREE.Matrix4(), layer: null, color: null, stack: [] };
    for (const e of this.doc.entities) {
      // Paper space is left out.
      if (num(e.codes, 67, 0) === 1) continue;
      this.entity(e, root);
    }
    return this.output();
  }

  private entity(e: DxfEntity, ctx: Ctx): void {
    if (num(e.codes, 60, 0) === 1) return; // invisible
    this.stats.entities++;
    const c = e.codes;
    const normal = pt(c, 210, [0, 0, 1]);
    const ocs = () => ocsMatrix(normal);
    const seg = this.options.arcSegments;
    if (num(c, 39, 0) !== 0 && ['LINE', 'CIRCLE', 'ARC', 'LWPOLYLINE', 'POLYLINE'].includes(e.type)) {
      this.warnOnce('thickness', 'Entity thickness (extrusion) is not drawn; entities are drawn as lines');
    }
    switch (e.type) {
      case 'LINE':
        this.polyline(e, ctx, [pt(c, 10), pt(c, 11)], null);
        break;
      case 'POINT': {
        const layer = this.entityLayer(e, ctx);
        this.push(this.bucket(layer, this.entityColor(e, layer, ctx), 'points'), ctx.matrix, pt(c, 10));
        this.stats.points++;
        break;
      }
      case 'CIRCLE': {
        const [x, y, z] = pt(c, 10);
        this.polyline(e, ctx, arcPoints(x, y, num(c, 40, 0), 0, Math.PI * 2, seg, z), ocs());
        break;
      }
      case 'ARC': {
        const [x, y, z] = pt(c, 10);
        const a = (num(c, 50, 0) * Math.PI) / 180;
        const b = (num(c, 51, 360) * Math.PI) / 180;
        this.polyline(e, ctx, arcPoints(x, y, num(c, 40, 0), a, b, seg, z), ocs());
        break;
      }
      case 'ELLIPSE':
        this.polyline(e, ctx, this.ellipse(c, normal), null);
        break;
      case 'LWPOLYLINE':
        this.lwpolyline(e, ctx, ocs());
        break;
      case 'POLYLINE':
        this.polylineEntity(e, ctx, ocs());
        break;
      case 'SPLINE':
        this.spline(e, ctx);
        break;
      case '3DFACE': {
        const p = [pt(c, 10), pt(c, 11), pt(c, 12), pt(c, 13, pt(c, 12))];
        const same = (a: V3, b: V3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
        this.triangles(e, ctx, same(p[2]!, p[3]!) ? [p[0]!, p[1]!, p[2]!] : [p[0]!, p[1]!, p[2]!, p[0]!, p[2]!, p[3]!], null, 'faces');
        break;
      }
      case 'SOLID':
      case 'TRACE': {
        // Corners in the order 1, 2, 4, 3 around the outline.
        const p = [pt(c, 10), pt(c, 11), pt(c, 12), pt(c, 13, pt(c, 12))];
        this.triangles(e, ctx, [p[0]!, p[1]!, p[2]!, p[1]!, p[3]!, p[2]!], ocs(), 'fill');
        break;
      }
      case 'MESH':
        this.mesh(e, ctx);
        break;
      case 'HATCH':
        this.hatch(e, ctx, ocs());
        break;
      case 'INSERT':
        this.insert(e, ctx, ocs());
        break;
      case 'DIMENSION': {
        const name = value(c, 2);
        if (name) this.block(name, e, ctx, ctx.matrix);
        break;
      }
      case 'LEADER': {
        const verts: V3[] = [];
        for (let i = 0; i < c.length; i++) if (c[i]![0] === 10) verts.push([Number(c[i]![1]), Number(c[i + 1]?.[0] === 20 ? c[i + 1]![1] : 0), Number(c[i + 2]?.[0] === 30 ? c[i + 2]![1] : 0)]);
        this.polyline(e, ctx, verts, null);
        break;
      }
      case 'TEXT':
      case 'MTEXT':
      case 'ATTRIB':
        this.text(e, ctx, ocs());
        break;
      case 'ATTDEF':
      case 'VIEWPORT':
      case 'SEQEND':
        break;
      case '3DSOLID':
      case 'BODY':
      case 'REGION':
      case 'SURFACE':
        this.skip(e.type, `${e.type} entities hold ACIS solid data, which is not read`);
        break;
      default:
        if (!/^[A-Z][A-Z0-9_]*$/.test(e.type)) this.skip('unreadable', 'Unreadable entities were left out');
        else this.skip(e.type, `${e.type} entities are not drawn`);
    }
  }

  private ellipse(c: GroupCode[], normal: V3): V3[] {
    const center = new THREE.Vector3(...pt(c, 10));
    const major = new THREE.Vector3(...pt(c, 11));
    const ratio = num(c, 40, 1);
    const n = new THREE.Vector3(...normal).normalize();
    const minor = n.clone().cross(major).multiplyScalar(ratio);
    let a = num(c, 41, 0);
    let b = num(c, 42, Math.PI * 2);
    while (b <= a) b += Math.PI * 2;
    const count = Math.max(4, Math.ceil(((b - a) / (Math.PI * 2)) * this.options.arcSegments));
    const out: V3[] = [];
    for (let i = 0; i <= count; i++) {
      const t = a + ((b - a) * i) / count;
      const p = center.clone().addScaledVector(major, Math.cos(t)).addScaledVector(minor, Math.sin(t));
      out.push([p.x, p.y, p.z]);
    }
    return out;
  }

  private lwpolyline(e: DxfEntity, ctx: Ctx, ocs: THREE.Matrix4): void {
    const c = e.codes;
    const elevation = num(c, 38, 0);
    const verts: { p: V3; bulge: number }[] = [];
    for (const [code, v] of c) {
      if (code === 10) verts.push({ p: [Number(v), 0, elevation], bulge: 0 });
      else if (code === 20 && verts.length) verts[verts.length - 1]!.p[1] = Number(v);
      else if (code === 42 && verts.length) verts[verts.length - 1]!.bulge = Number(v);
      else if ((code === 40 || code === 41 || code === 43) && Number(v) !== 0) this.warnOnce('width', 'Polyline widths are not drawn; polylines are drawn as centre lines');
    }
    const closed = (num(c, 70, 0) & 1) !== 0;
    this.polyline(e, ctx, this.withBulges(verts, closed), ocs);
  }

  private withBulges(verts: { p: V3; bulge: number }[], closed: boolean): V3[] {
    const out: V3[] = [];
    const n = verts.length;
    for (let i = 0; i < n; i++) {
      const a = verts[i]!;
      const b = verts[(i + 1) % n]!;
      if (i === n - 1 && !closed) {
        out.push(a.p);
        break;
      }
      const seg = bulgePoints(a.p, b.p, a.bulge, this.options.arcSegments);
      out.push(...(out.length ? seg.slice(1) : seg));
      if (i === n - 1) out.pop();
    }
    if (closed && out.length > 2) out.push(out[0]!);
    return out;
  }

  private polylineEntity(e: DxfEntity, ctx: Ctx, ocs: THREE.Matrix4): void {
    const c = e.codes;
    const flags = num(c, 70, 0);
    const vertex = (v: DxfEntity): V3 => pt(v.codes, 10);
    if (flags & 64) {
      // Polyface mesh: position vertices, then face records of 1-based indices.
      const positions: V3[] = [];
      const tris: V3[] = [];
      for (const v of e.children) {
        const vf = num(v.codes, 70, 0);
        if (vf & 64) positions.push(vertex(v));
        else if (vf & 128) {
          const idx = [71, 72, 73, 74].map((k) => Math.abs(num(v.codes, k, 0))).filter((i) => i > 0);
          const p = idx.map((i) => positions[i - 1]).filter((x): x is V3 => !!x);
          for (let i = 1; i + 1 < p.length; i++) tris.push(p[0]!, p[i]!, p[i + 1]!);
        }
      }
      this.triangles(e, ctx, tris, null, 'faces');
      return;
    }
    if (flags & 16) {
      // Polygon mesh: an M x N grid of vertices.
      const m = num(c, 71, 0);
      const n = num(c, 72, 0);
      const grid = e.children.filter((v) => !(num(v.codes, 70, 0) & 16)).map(vertex);
      if (m * n !== grid.length || m < 2 || n < 2) {
        this.warnOnce('pmesh', 'A polygon mesh with an unexpected vertex count was left out');
        return;
      }
      const closedM = (flags & 1) !== 0;
      const closedN = (flags & 32) !== 0;
      const tris: V3[] = [];
      for (let i = 0; i < (closedM ? m : m - 1); i++) {
        for (let j = 0; j < (closedN ? n : n - 1); j++) {
          const a = grid[i * n + j]!;
          const b = grid[((i + 1) % m) * n + j]!;
          const d = grid[i * n + ((j + 1) % n)]!;
          const q = grid[((i + 1) % m) * n + ((j + 1) % n)]!;
          tris.push(a, b, q, a, q, d);
        }
      }
      this.triangles(e, ctx, tris, null, 'faces');
      return;
    }
    // 2D or 3D polyline. Spline-fit polylines keep their fitted vertices (flag 8), not the frame (16).
    let verts = e.children;
    if (verts.some((v) => num(v.codes, 70, 0) & 8)) verts = verts.filter((v) => num(v.codes, 70, 0) & 8);
    else verts = verts.filter((v) => !(num(v.codes, 70, 0) & 16));
    const closed = (flags & 1) !== 0;
    if (flags & 8) {
      this.polyline(e, ctx, verts.map(vertex), null, closed);
    } else {
      const elevation = num(c, 30, 0);
      const list = verts.map((v) => ({ p: [num(v.codes, 10, 0), num(v.codes, 20, 0), elevation] as V3, bulge: num(v.codes, 42, 0) }));
      this.polyline(e, ctx, this.withBulges(list, closed), ocs);
    }
  }

  private spline(e: DxfEntity, ctx: Ctx): void {
    const c = e.codes;
    const degree = num(c, 71, 3);
    const knots: number[] = [];
    const weights: number[] = [];
    const control: V3[] = [];
    const fit: V3[] = [];
    for (let i = 0; i < c.length; i++) {
      const [code, v] = c[i]!;
      if (code === 40) knots.push(Number(v));
      else if (code === 41) weights.push(Number(v));
      else if (code === 10) control.push([Number(v), 0, 0]);
      else if (code === 20 && control.length) control[control.length - 1]![1] = Number(v);
      else if (code === 30 && control.length) control[control.length - 1]![2] = Number(v);
      else if (code === 11) fit.push([Number(v), 0, 0]);
      else if (code === 21 && fit.length) fit[fit.length - 1]![1] = Number(v);
      else if (code === 31 && fit.length) fit[fit.length - 1]![2] = Number(v);
    }
    const samples = Math.max(16, control.length * 8, fit.length * 8);
    let points: V3[];
    if (control.length) points = nurbsPoints(degree, knots, control, weights, samples);
    else if (fit.length > 1) {
      // Without control points, a smooth curve through the fit points.
      const curve = new THREE.CatmullRomCurve3(fit.map((p) => new THREE.Vector3(...p)), (num(c, 70, 0) & 1) !== 0, 'centripetal');
      points = curve.getPoints(samples).map((p) => [p.x, p.y, p.z]);
    } else points = [];
    this.polyline(e, ctx, points, null);
  }

  private mesh(e: DxfEntity, ctx: Ctx): void {
    const c = e.codes;
    let i = c.findIndex(([code]) => code === 92);
    if (i < 0) return;
    const count = Number(c[i]![1]);
    const verts: V3[] = [];
    for (i++; i < c.length && verts.length < count; i++) {
      if (c[i]![0] === 10) verts.push([Number(c[i]![1]), Number(c[i + 1]?.[1] ?? 0), Number(c[i + 2]?.[1] ?? 0)]);
    }
    const f = c.findIndex(([code], k) => code === 93 && k >= i - 1);
    if (f < 0) return;
    const list: number[] = [];
    const size = Number(c[f]![1]);
    for (let k = f + 1; k < c.length && list.length < size && c[k]![0] === 90; k++) list.push(Number(c[k]![1]));
    const tris: V3[] = [];
    for (let k = 0; k < list.length; ) {
      const n = list[k]!;
      const idx = list.slice(k + 1, k + 1 + n);
      for (let j = 1; j + 1 < idx.length; j++) {
        const a = verts[idx[0]!];
        const b = verts[idx[j]!];
        const d = verts[idx[j + 1]!];
        if (a && b && d) tris.push(a, b, d);
      }
      k += n + 1;
    }
    if (num(c, 91, 0) > 0) this.warnOnce('subd', 'Subdivision levels of MESH entities are not applied; the control mesh is drawn');
    this.triangles(e, ctx, tris, null, 'faces');
  }

  private hatch(e: DxfEntity, ctx: Ctx, ocs: THREE.Matrix4): void {
    const c = e.codes;
    const solid = num(c, 70, 0) === 1 || (value(c, 2) ?? '').trim().toUpperCase() === 'SOLID' || num(c, 450, 0) === 1;
    if (!solid) {
      this.skip('HATCH pattern', 'Pattern hatches are not drawn; solid and gradient fills are');
      return;
    }
    const elevation = num(c, 30, 0);
    const loops = this.hatchLoops(c);
    if (!loops.length) return;
    // Loops inside an odd number of others are holes.
    const shapes = loops.map((l) => ({ l, area: Math.abs(THREE.ShapeUtils.area(l)) })).sort((a, b) => b.area - a.area);
    const inside = (p: THREE.Vector2, poly: THREE.Vector2[]) => {
      let r = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i]!;
        const b = poly[j]!;
        if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) r = !r;
      }
      return r;
    };
    const outers: { contour: THREE.Vector2[]; holes: THREE.Vector2[][] }[] = [];
    shapes.forEach((s, i) => {
      const parents = shapes.slice(0, i).filter((o) => inside(s.l[0]!, o.l));
      if (parents.length % 2 === 0) outers.push({ contour: s.l, holes: [] });
      else {
        const host = [...outers].reverse().find((o) => inside(s.l[0]!, o.contour));
        host?.holes.push(s.l);
      }
    });
    const tris: V3[] = [];
    for (const o of outers) {
      const contour = THREE.ShapeUtils.isClockWise(o.contour) ? [...o.contour].reverse() : o.contour;
      const holes = o.holes.map((h) => (THREE.ShapeUtils.isClockWise(h) ? h : [...h].reverse()));
      const all = [...contour, ...holes.flat()];
      for (const [a, b, d] of THREE.ShapeUtils.triangulateShape(contour, holes)) {
        tris.push([all[a!]!.x, all[a!]!.y, elevation], [all[b!]!.x, all[b!]!.y, elevation], [all[d!]!.x, all[d!]!.y, elevation]);
      }
    }
    this.triangles(e, ctx, tris, ocs, 'fill');
  }

  /** Reads hatch boundary paths into closed 2D loops. */
  private hatchLoops(c: GroupCode[]): THREE.Vector2[][] {
    const loops: THREE.Vector2[][] = [];
    let i = c.findIndex(([code]) => code === 91);
    if (i < 0) return loops;
    const paths = Number(c[i]![1]);
    i++;
    const seg = this.options.arcSegments;
    const read = (code: number) => {
      while (i < c.length && c[i]![0] !== code) i++;
      return i < c.length ? Number(c[i++]![1]) : 0;
    };
    for (let p = 0; p < paths && i < c.length; p++) {
      const flags = read(92);
      const points: THREE.Vector2[] = [];
      const add = (list: V3[]) => {
        for (const q of list) {
          const last = points[points.length - 1];
          if (!last || Math.hypot(last.x - q[0], last.y - q[1]) > 1e-12) points.push(new THREE.Vector2(q[0], q[1]));
        }
      };
      if (flags & 2) {
        // Polyline path.
        const hasBulge = read(72) !== 0;
        read(73);
        const n = read(93);
        const verts: { p: V3; bulge: number }[] = [];
        for (let k = 0; k < n; k++) {
          const x = read(10);
          const y = read(20);
          const bulge = hasBulge && c[i]?.[0] === 42 ? Number(c[i++]![1]) : 0;
          verts.push({ p: [x, y, 0], bulge });
        }
        add(this.withBulges(verts, true));
      } else {
        const edges = read(93);
        for (let k = 0; k < edges; k++) {
          const type = read(72);
          if (type === 1) {
            add([[read(10), read(20), 0], [read(11), read(21), 0]]);
          } else if (type === 2) {
            const cx = read(10);
            const cy = read(20);
            const r = read(40);
            const a = read(50);
            const b = read(51);
            add(edgeArc(cx, cy, r, 0, 1, a, b, read(73) !== 0, seg));
          } else if (type === 3) {
            const cx = read(10);
            const cy = read(20);
            const mx = read(11);
            const my = read(21);
            const ratio = read(40);
            const a = read(50);
            const b = read(51);
            add(edgeArc(cx, cy, mx, my, ratio, a, b, read(73) !== 0, seg));
          } else if (type === 4) {
            const degree = read(94);
            read(73);
            read(74);
            const nk = read(95);
            const nc = read(96);
            const knots: number[] = [];
            for (let s = 0; s < nk; s++) knots.push(read(40));
            const ctrl: V3[] = [];
            const weights: number[] = [];
            for (let s = 0; s < nc; s++) {
              ctrl.push([read(10), read(20), 0]);
              if (c[i]?.[0] === 42) weights.push(Number(c[i++]![1]));
            }
            add(nurbsPoints(degree, knots, ctrl, weights, Math.max(16, nc * 8)));
          }
        }
      }
      if (points.length > 2) {
        const first = points[0]!;
        const last = points[points.length - 1]!;
        if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-9) points.pop();
        loops.push(points);
      }
    }
    return loops;
  }

  private insert(e: DxfEntity, ctx: Ctx, ocs: THREE.Matrix4): void {
    const c = e.codes;
    const name = value(c, 2) ?? '';
    const ins = pt(c, 10);
    const sx = num(c, 41, 1);
    const sy = num(c, 42, 1);
    const sz = num(c, 43, 1);
    const rot = (num(c, 50, 0) * Math.PI) / 180;
    const cols = Math.max(1, num(c, 70, 1));
    const rows = Math.max(1, num(c, 71, 1));
    const cs = num(c, 44, 0);
    const rs = num(c, 45, 0);
    const block = this.doc.blocks.get(name.toUpperCase());
    if (!block) {
      this.warnOnce(`block:${name}`, `Block ${name} is not defined`);
      return;
    }
    const base = new THREE.Matrix4().makeTranslation(-block.base[0], -block.base[1], -block.base[2]);
    for (let r = 0; r < rows; r++) {
      for (let k = 0; k < cols; k++) {
        const m = ctx.matrix
          .clone()
          .multiply(ocs)
          .multiply(new THREE.Matrix4().makeTranslation(ins[0], ins[1], ins[2]))
          .multiply(new THREE.Matrix4().makeRotationZ(rot))
          .multiply(new THREE.Matrix4().makeTranslation(k * cs, r * rs, 0))
          .multiply(new THREE.Matrix4().makeScale(sx, sy, sz))
          .multiply(base);
        this.block(name, e, ctx, m);
      }
    }
    for (const a of e.children) this.entity(a, ctx);
  }

  /** Draws a block's entities with a transform, taking layer and colour from the referring entity. */
  private block(name: string, ref: DxfEntity, ctx: Ctx, matrix: THREE.Matrix4): void {
    const block = this.doc.blocks.get(name.toUpperCase());
    if (!block) return;
    if (ctx.stack.includes(name.toUpperCase()) || ctx.stack.length > 32) {
      this.warnOnce(`recursive:${name}`, `Block ${name} contains itself; the repeat was left out`);
      return;
    }
    this.stats.inserts++;
    const layer = this.entityLayer(ref, ctx);
    const inner: Ctx = { matrix, layer, color: this.entityColor(ref, layer, ctx), stack: [...ctx.stack, name.toUpperCase()] };
    for (const e of block.entities) this.entity(e, inner);
  }

  private text(e: DxfEntity, ctx: Ctx, ocs: THREE.Matrix4): void {
    const c = e.codes;
    const parts = c.filter(([code]) => code === 3).map(([, v]) => v);
    const raw = [...parts, value(c, 1) ?? ''].join('');
    const text = e.type === 'MTEXT' ? plainMText(raw) : decodeDxfString(raw);
    if (!text.trim()) return;
    const layer = this.entityLayer(e, ctx);
    // MTEXT positions are in world coordinates; TEXT and ATTRIB positions in the entity's OCS.
    const m = e.type === 'MTEXT' ? ctx.matrix : ctx.matrix.clone().multiply(ocs);
    this.v.set(...pt(c, 10)).applyMatrix4(m);
    this.texts.push({
      text,
      position: [this.v.x, this.v.y, this.v.z],
      height: num(c, 40, 1),
      rotation: (num(c, 50, 0) * Math.PI) / 180,
      layer,
      color: this.entityColor(e, layer, ctx),
    });
    this.warnOnce('text', 'Text is not drawn; it is returned in the result\'s texts');
  }

  // three.js objects.

  private output(): THREE.Group {
    const drawing = new THREE.Group();
    drawing.name = 'DXF';
    (drawing.userData as DxfUserData).dxf = { kind: 'drawing' };
    const layers = new Map<string, THREE.Group>();
    const lineMaterials = new Map<number, THREE.LineBasicMaterial>();
    const pointMaterials = new Map<number, THREE.PointsMaterial>();
    const fillMaterials = new Map<number, THREE.MeshBasicMaterial>();
    const faceMaterials = new Map<number, THREE.MeshStandardMaterial>();
    const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
    let zMin = Infinity;
    let zMax = -Infinity;
    for (const [key, b] of this.buckets) {
      if (!b.positions.length) continue;
      const [layerName, colorText, kind] = key.split('\u0000') as [string, string, Kind];
      const color = Number(colorText);
      const info = this.doc.layers.get(layerName.toUpperCase());
      const hidden = !!info && (info.off || info.frozen);
      if (hidden && !this.options.hiddenLayers) continue;
      let layer = layers.get(layerName);
      if (!layer) {
        layer = new THREE.Group();
        layer.name = layerName;
        layer.visible = !hidden;
        (layer.userData as DxfUserData).dxf = { kind: 'layer', layer: layerName };
        layers.set(layerName, layer);
      }
      for (let i = 2; i < b.positions.length; i += 3) {
        zMin = Math.min(zMin, b.positions[i]!);
        zMax = Math.max(zMax, b.positions[i]!);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
      let object: THREE.Object3D;
      if (kind === 'lines') {
        let m = lineMaterials.get(color);
        if (!m) lineMaterials.set(color, (m = new THREE.LineBasicMaterial({ color: hex(color), name: hex(color) })));
        object = new THREE.LineSegments(geometry, m);
      } else if (kind === 'points') {
        let m = pointMaterials.get(color);
        if (!m) pointMaterials.set(color, (m = new THREE.PointsMaterial({ color: hex(color), size: 3, sizeAttenuation: false, name: hex(color) })));
        object = new THREE.Points(geometry, m);
      } else if (kind === 'fill') {
        let m = fillMaterials.get(color);
        if (!m) fillMaterials.set(color, (m = new THREE.MeshBasicMaterial({ color: hex(color), side: THREE.DoubleSide, name: hex(color) })));
        object = new THREE.Mesh(geometry, m);
      } else {
        let m = faceMaterials.get(color);
        if (!m) faceMaterials.set(color, (m = new THREE.MeshStandardMaterial({ color: hex(color), side: THREE.DoubleSide, roughness: 0.7, metalness: 0, name: hex(color) })));
        geometry.computeVertexNormals();
        object = new THREE.Mesh(geometry, m);
      }
      object.name = `${layerName} ${kind} ${hex(color)}`;
      (object.userData as DxfUserData).dxf = { kind, layer: layerName, color };
      layer.add(object);
    }
    for (const layer of [...layers.values()].sort((a, b) => a.name.localeCompare(b.name))) drawing.add(layer);

    // Units and orientation.
    const insunits = num(this.doc.header.get('$INSUNITS') ?? [], 70, 0);
    const scale = this.options.unitScale ?? UNITS[insunits] ?? 1;
    if (scale !== 1) drawing.scale.setScalar(scale);
    const flat = zMax - zMin <= 1e-9 * Math.max(1, Math.abs(zMax));
    const turn = this.options.orientation === 'z-up' || (this.options.orientation === 'auto' && !flat);
    if (turn) drawing.rotation.x = -Math.PI / 2;
    drawing.userData.dxfUnits = { insunits, scale, turned: turn };
    return drawing;
  }
}
