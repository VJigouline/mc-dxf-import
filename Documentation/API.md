# API

## `loadDxf(input, options?)`

Reads a DXF file and returns a `DxfLoadResult` at once. `input` is the file's text, or its bytes as an `ArrayBuffer` or `Uint8Array`; binary DXF must be given as bytes.

It throws `DxfError` if the input isn't DXF.

### `DxfOptions`

| Option | Default | Meaning |
| --- | --- | --- |
| `background` | `'light'` | `'light'` draws colour 7 black, `'dark'` white. |
| `orientation` | `'auto'` | `'auto'` keeps a flat drawing in the XY plane and turns a 3D one to Y up. `'z-up'` always turns; `'xy'` never does. |
| `arcSegments` | `72` | Segments for a full circle; arcs and ellipses get their share. At least 8. |
| `unitScale` | from `$INSUNITS` | Metres per drawing unit. |
| `hiddenLayers` | `true` | Adds layers that are off or frozen, hidden. `false` leaves them out. |

### `DxfLoadResult`

| Field | Type | Meaning |
| --- | --- | --- |
| `group` | `THREE.Group` | The drawing, in metres: a group per layer, holding an object per colour and kind. |
| `version` | `string` | `$ACADVER`, such as `AC1009` (R12), `AC1015` (2000), `AC1032` (2018); empty if not given. |
| `layers` | `DxfLayer[]` | The layer table: `name`, `color`, `trueColor`, `off` and `frozen`. |
| `texts` | `DxfText[]` | Text that is not drawn. Each has `text`, `position`, `height`, `rotation` (radians), `layer` and `color`. |
| `unitScale` | `number` | Metres per drawing unit. |
| `warnings` | `string[]` | Problems that didn't stop the import, and what was left out. |
| `stats` | `DxfStats` | `entities`, `segments`, `triangles`, `points`, `inserts` and `skipped`, a count of entities not drawn by type. |

Text positions are in drawing coordinates, before the group's scaling and turning. To place a text in the scene, apply the group's matrix:

```ts
result.group.updateMatrixWorld(true);
const position = new THREE.Vector3(...text.position).applyMatrix4(result.group.matrixWorld);
```

### `DxfUserData`

Each object the importer makes has `userData.dxf` with these fields:

| Field | Meaning |
| --- | --- |
| `kind` | `drawing`, `layer`, `lines`, `points`, `fill` or `faces`. |
| `layer` | The layer's name. |
| `color` | The colour as 24-bit RGB. |

## Parsing

### `parseDxf(input)` → `DxfDocument`

| Field | Meaning |
| --- | --- |
| `version` | `$ACADVER`. |
| `header` | Header variables by name, such as `$INSUNITS`, each a list of group codes. |
| `layers` | `Map` of `DxfLayer` by upper-case name. |
| `blocks` | `Map` of `DxfBlock` by upper-case name: `name`, `flags`, `base` and `entities`. |
| `entities` | The ENTITIES section's `DxfEntity` objects. |
| `binary` | Whether the file was binary. |
| `warnings` | Problems found while reading. |

A `DxfEntity` has these fields:

- `type`: such as `LINE` or `LWPOLYLINE`.
- `codes`: its group codes in order, as `[code, value]` pairs with the value as text.
- `children`: for a POLYLINE, its VERTEX entities; for an INSERT, its ATTRIB entities.

`isBinaryDxf(bytes)` tells whether bytes are a binary DXF file. `decodeDxfString(s)` decodes `\U+XXXX` escapes and the `%%c`, `%%d` and `%%p` codes.

## Building

`DxfBuilder` turns a `DxfDocument` into three.js objects; `loadDxf` is a thin layer over it.

These helpers are exported too:

| Export | Meaning |
| --- | --- |
| `ocsMatrix(normal)` | The matrix from an object coordinate system to world coordinates, by the arbitrary axis algorithm. |
| `bulgePoints(p1, p2, bulge, segments)` | The points of a polyline segment with a bulge. |
| `nurbsPoints(degree, knots, control, weights, samples)` | Points on a NURBS curve. |
| `plainMText(s)` | MTEXT without its formatting codes. |
| `ACI`, `aciToRgb(index, background?)` | The AutoCAD Color Index as RGB. |
