import type * as THREE from 'three';
import { DxfBuilder, type DxfOptions, type DxfStats, type DxfText } from './builder.js';
import { parseDxf, type DxfLayer } from './dxf.js';

export { parseDxf, isBinaryDxf, decodeDxfString, DxfError } from './dxf.js';
export type { DxfDocument, DxfEntity, DxfLayer, DxfBlock, GroupCode } from './dxf.js';
export { DxfBuilder, ocsMatrix, bulgePoints, nurbsPoints, plainMText } from './builder.js';
export type { DxfOptions, DxfText, DxfStats, DxfUserData } from './builder.js';
export { ACI, aciToRgb } from './colors.js';

export interface DxfLoadResult {
  /** The drawing for three.js, in metres. A 3D drawing is turned Y up; a flat one stays in the XY plane. */
  group: THREE.Group;
  /** $ACADVER, such as AC1015 (AutoCAD 2000); empty if the file doesn't say. */
  version: string;
  layers: DxfLayer[];
  /** Text entities, which are not drawn: their strings, positions, heights and colours. */
  texts: DxfText[];
  /** Metres per drawing unit. */
  unitScale: number;
  /** Problems that didn't stop the import. */
  warnings: string[];
  stats: DxfStats;
}

/** Reads a DXF file, ASCII or binary, into a three.js group. */
export function loadDxf(input: string | ArrayBuffer | Uint8Array, options: DxfOptions = {}): DxfLoadResult {
  const doc = parseDxf(input);
  const builder = new DxfBuilder(doc, options);
  const group = builder.build();
  return {
    group,
    version: doc.version,
    layers: [...doc.layers.values()],
    texts: builder.texts,
    unitScale: (group.userData.dxfUnits as { scale: number }).scale,
    warnings: builder.warnings,
    stats: builder.stats,
  };
}
