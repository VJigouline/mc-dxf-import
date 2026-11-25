// Reads DXF files, ASCII or binary, into header variables, layers, blocks and entities. Each
// entity keeps its group codes in order, as some (hatch boundaries, polyface faces) can only be
// read in sequence.

export type GroupCode = [code: number, value: string];

export class DxfError extends Error {
  override name = 'DxfError';
}

export interface DxfEntity {
  type: string;
  /** The entity's group codes in file order, without the leading 0 code. */
  codes: GroupCode[];
  /** For POLYLINE: its VERTEX entities. For INSERT: its ATTRIB entities. */
  children: DxfEntity[];
}

export interface DxfLayer {
  name: string;
  /** ACI colour; negative when the layer is off. */
  color: number;
  /** 24-bit RGB colour, if set. */
  trueColor: number | null;
  frozen: boolean;
  off: boolean;
}

export interface DxfBlock {
  name: string;
  flags: number;
  base: [number, number, number];
  entities: DxfEntity[];
}

export interface DxfDocument {
  /** $ACADVER, such as AC1015 for AutoCAD 2000; empty for files without it. */
  version: string;
  header: Map<string, GroupCode[]>;
  layers: Map<string, DxfLayer>;
  blocks: Map<string, DxfBlock>;
  entities: DxfEntity[];
  binary: boolean;
  /** Problems found while reading, such as data cut off by corruption. */
  warnings: string[];
}

const BINARY_SENTINEL = 'AutoCAD Binary DXF\r\n\x1a\0';

/** True if the bytes are a binary DXF file. */
export function isBinaryDxf(bytes: Uint8Array): boolean {
  if (bytes.length < 22) return false;
  for (let i = 0; i < 22; i++) if (bytes[i] !== BINARY_SENTINEL.charCodeAt(i)) return false;
  return true;
}

type ValueType = 'string' | 'double' | 'int16' | 'int32' | 'int64' | 'bool' | 'binary';

function valueType(code: number): ValueType {
  if ((code >= 10 && code <= 59) || (code >= 110 && code <= 149) || (code >= 210 && code <= 239) || (code >= 460 && code <= 469) || (code >= 1010 && code <= 1059)) return 'double';
  if ((code >= 60 && code <= 79) || (code >= 170 && code <= 179) || (code >= 270 && code <= 289) || (code >= 370 && code <= 389) || (code >= 400 && code <= 409) || (code >= 1060 && code <= 1070)) return 'int16';
  if ((code >= 90 && code <= 99) || (code >= 420 && code <= 429) || (code >= 440 && code <= 459) || code === 1071) return 'int32';
  if (code >= 160 && code <= 169) return 'int64';
  if (code >= 290 && code <= 299) return 'bool';
  if ((code >= 310 && code <= 319) || code === 1004) return 'binary';
  return 'string';
}

function readBinary(bytes: Uint8Array): GroupCode[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: GroupCode[] = [];
  // R12 writes 1-byte group codes (255 escaping a 2-byte code); later versions write 2-byte codes.
  let p = 22;
  const wide = bytes[p] === 0 && bytes[p + 1] === 0;
  const decoder = new TextDecoder('windows-1252');
  const utf8 = new TextDecoder();
  let unicode = false;
  const str = () => {
    let e = p;
    while (e < bytes.length && bytes[e] !== 0) e++;
    const s = (unicode ? utf8 : decoder).decode(bytes.subarray(p, e));
    p = e + 1;
    return s;
  };
  while (p < bytes.length) {
    let code: number;
    if (wide) {
      code = view.getUint16(p, true);
      p += 2;
    } else {
      code = bytes[p++]!;
      if (code === 255) {
        code = view.getUint16(p, true);
        p += 2;
      }
    }
    let value: string;
    switch (valueType(code)) {
      case 'double':
        value = String(view.getFloat64(p, true));
        p += 8;
        break;
      case 'int16':
        value = String(view.getInt16(p, true));
        p += 2;
        break;
      case 'int32':
        value = String(view.getInt32(p, true));
        p += 4;
        break;
      case 'int64':
        value = String(view.getBigInt64(p, true));
        p += 8;
        break;
      case 'bool':
        value = String(bytes[p++]);
        break;
      case 'binary': {
        const n = bytes[p++]!;
        value = Array.from(bytes.subarray(p, p + n), (b) => b.toString(16).padStart(2, '0')).join('');
        p += n;
        break;
      }
      default:
        value = str();
    }
    if (p > bytes.length) throw new DxfError('Unexpected end of binary DXF');
    out.push([code, value]);
    if (code === 1 && out[out.length - 2]?.[1] === '$ACADVER') unicode = value >= 'AC1021';
    if (code === 0 && value === 'EOF') break;
  }
  return out;
}

function decodeText(bytes: Uint8Array): string {
  // AutoCAD 2007 (AC1021) and later write UTF-8; earlier versions write the drawing's code page,
  // usually Windows-1252. Files that are valid UTF-8 are read as such.
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  try {
    return utf8.decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function readAscii(text: string, warnings: string[]): GroupCode[] {
  const lines = text.split(/\r\n|\n|\r/);
  const out: GroupCode[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const codeText = lines[i]!.trim();
    if (codeText === '' && i + 1 >= lines.length - 1) break;
    const code = Number(codeText);
    if (!Number.isInteger(code)) {
      // Keep what was read before the damage.
      if (!out.length) throw new DxfError(`Not a DXF file: bad group code ${JSON.stringify(codeText.slice(0, 20))} at line ${i + 1}`);
      warnings.push(`The file is damaged at line ${i + 1} (bad group code ${JSON.stringify(codeText.slice(0, 20))}); what comes before it was read`);
      break;
    }
    const value = lines[i + 1]!;
    out.push([code, valueType(code) === 'string' ? value.replace(/\s+$/, '') : value.trim()]);
    if (code === 0 && value.trim() === 'EOF') break;
  }
  return out;
}

/** Decodes \U+XXXX escapes and the %%c, %%d and %%p control codes in DXF text. */
export function decodeDxfString(s: string): string {
  return s
    .replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/%%[cC]/g, '⌀')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±');
}

/** Splits a run of group codes into entities at each 0 code, gathering POLYLINE vertices and INSERT attributes. */
function entitiesOf(codes: GroupCode[], start: number, end: number): DxfEntity[] {
  const flat: DxfEntity[] = [];
  let current: DxfEntity | null = null;
  for (let i = start; i < end; i++) {
    const [code, value] = codes[i]!;
    if (code === 0) {
      current = { type: value.trim().toUpperCase(), codes: [], children: [] };
      flat.push(current);
    } else if (current) {
      current.codes.push([code, value]);
    }
  }
  const out: DxfEntity[] = [];
  for (let i = 0; i < flat.length; i++) {
    const e = flat[i]!;
    if (e.type === 'POLYLINE' || (e.type === 'INSERT' && e.codes.some(([c, v]) => c === 66 && Number(v) === 1))) {
      const childType = e.type === 'POLYLINE' ? 'VERTEX' : 'ATTRIB';
      while (i + 1 < flat.length && flat[i + 1]!.type === childType) e.children.push(flat[++i]!);
      if (i + 1 < flat.length && flat[i + 1]!.type === 'SEQEND') i++;
    }
    if (e.type !== 'SEQEND') out.push(e);
  }
  return out;
}

export function value(codes: GroupCode[], code: number): string | undefined {
  for (const [c, v] of codes) if (c === code) return v;
  return undefined;
}

export function num(codes: GroupCode[], code: number, fallback: number): number {
  const v = value(codes, code);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const SECTIONS = new Set(['HEADER', 'CLASSES', 'TABLES', 'BLOCKS', 'ENTITIES', 'OBJECTS', 'THUMBNAILIMAGE', 'ACDSDATA']);

/** Parses a DXF file from its text or bytes. */
export function parseDxf(input: string | ArrayBuffer | Uint8Array): DxfDocument {
  let codes: GroupCode[];
  let binary = false;
  const warnings: string[] = [];
  if (typeof input === 'string') {
    codes = readAscii(input.replace(/^﻿/, ''), warnings);
  } else {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    binary = isBinaryDxf(bytes);
    if (binary) {
      try {
        codes = readBinary(bytes);
      } catch (error) {
        throw new DxfError(`The binary DXF file is damaged: ${(error as Error).message}`);
      }
    } else codes = readAscii(decodeText(bytes), warnings);
  }
  const doc: DxfDocument = { version: '', header: new Map(), layers: new Map(), blocks: new Map(), entities: [], binary, warnings };

  // Sections.
  let i = 0;
  let sections = 0;
  while (i < codes.length) {
    const [code, v] = codes[i]!;
    // A section starts with 0 SECTION and 2 name; some writers leave out the 0 SECTION.
    const bare = code === 2 && SECTIONS.has(v.trim().toUpperCase());
    if ((code === 0 && v.trim() === 'SECTION') || bare) {
      sections++;
      if (bare) i--;
      const name = codes[i + 1]?.[1].trim().toUpperCase() ?? '';
      let end = i + 2;
      while (end < codes.length && !(codes[end]![0] === 0 && codes[end]![1].trim() === 'ENDSEC')) end++;
      if (name === 'HEADER') readHeader(doc, codes, i + 2, end);
      else if (name === 'TABLES') readTables(doc, codes, i + 2, end);
      else if (name === 'BLOCKS') readBlocks(doc, codes, i + 2, end);
      else if (name === 'ENTITIES') doc.entities.push(...entitiesOf(codes, i + 2, end));
      i = end + 1;
    } else {
      i++;
    }
  }
  // Some writers leave out the section markers and write entities only.
  if (sections === 0) doc.entities = entitiesOf(codes, 0, codes.length).filter((e) => e.type !== 'EOF');
  doc.version = value(doc.header.get('$ACADVER') ?? [], 1) ?? '';
  return doc;
}

function readHeader(doc: DxfDocument, codes: GroupCode[], start: number, end: number): void {
  let name = '';
  for (let i = start; i < end; i++) {
    const [code, v] = codes[i]!;
    if (code === 9) {
      name = v.trim();
      doc.header.set(name, []);
    } else if (name) {
      doc.header.get(name)!.push([code, v]);
    }
  }
}

function readTables(doc: DxfDocument, codes: GroupCode[], start: number, end: number): void {
  for (const entry of entitiesOf(codes, start, end)) {
    if (entry.type !== 'LAYER') continue;
    const name = value(entry.codes, 2) ?? '';
    const color = num(entry.codes, 62, 7);
    const flags = num(entry.codes, 70, 0);
    const trueColor = value(entry.codes, 420);
    doc.layers.set(name.toUpperCase(), { name, color, trueColor: trueColor !== undefined ? Number(trueColor) & 0xffffff : null, frozen: (flags & 1) !== 0, off: color < 0 });
  }
}

function readBlocks(doc: DxfDocument, codes: GroupCode[], start: number, end: number): void {
  let i = start;
  while (i < end) {
    const [code, v] = codes[i]!;
    if (code === 0 && v.trim() === 'BLOCK') {
      let j = i + 1;
      while (j < end && codes[j]![0] !== 0) j++;
      const head = codes.slice(i + 1, j);
      let k = j;
      while (k < end && !(codes[k]![0] === 0 && codes[k]![1].trim() === 'ENDBLK')) k++;
      const name = value(head, 2) ?? value(head, 3) ?? '';
      doc.blocks.set(name.toUpperCase(), {
        name,
        flags: num(head, 70, 0),
        base: [num(head, 10, 0), num(head, 20, 0), num(head, 30, 0)],
        entities: entitiesOf(codes, j, k),
      });
      i = k + 1;
    } else {
      i++;
    }
  }
}
