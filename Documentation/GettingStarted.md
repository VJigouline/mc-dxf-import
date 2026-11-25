# Getting started

## Install

```sh
npm install three github:VJigouline/mc-dxf-import
```

## Open a DXF file

`loadDxf` takes the file's bytes or text, ASCII or binary, and returns the drawing at once:

```ts
import * as THREE from 'three';
import { loadDxf } from 'mc-dxf-import';

const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
input.addEventListener('change', async () => {
  const result = loadDxf(await input.files![0]!.arrayBuffer());
  scene.add(result.group);
  for (const warning of result.warnings) console.warn(warning);
});
```

It throws `DxfError` for a file that isn't DXF. A file that is damaged part way through is read up to the damage, with a warning.

## What you get

- **`group`:** a `THREE.Group` named DXF. It holds a group for each layer, named after it. Layers that are off or frozen are hidden; pass `hiddenLayers: false` to leave them out.
- **Inside each layer:** one object for each colour and kind:

  | Kind | three.js object | Material |
  | --- | --- | --- |
  | Lines and curves | `LineSegments` | `LineBasicMaterial` |
  | Points | `Points` | `PointsMaterial` |
  | Filled areas (SOLID, TRACE and solid hatches) | `Mesh` | unlit `MeshBasicMaterial` |
  | Faces (3DFACE and meshes) | `Mesh` | lit `MeshStandardMaterial` |

  Blocks are expanded where they are inserted, so their geometry is part of these objects.
- **`userData.dxf`:** on each object, its `kind`, `layer` and `color`.
- **`texts`:** the drawing's TEXT, MTEXT and ATTRIB strings, with their positions, heights, rotations, layers and colours. They are not drawn; draw them with your own text rendering if you need them.
- **`layers`:** the layer table.
- **`version`:** the AutoCAD version, such as `AC1015`.
- **`unitScale`:** metres per drawing unit.
- **`stats`:** what was read and drawn.

## Orientation and units

DXF drawings are Z up. By default:

- **Flat drawings:** a drawing that lies in the XY plane stays in it, facing a three.js camera that looks down −Z, as a drawing on screen would.
- **3D drawings:** a drawing with any height is turned to three.js's Y up, like other CAD models.

Pass `orientation: 'z-up'` or `'xy'` to choose one or the other.

The drawing is scaled to metres by its `$INSUNITS` setting; drawings without units are not scaled. Pass `unitScale` to set metres per drawing unit yourself.

## Colours

Colours are AutoCAD's, as set on each entity or by its layer (ByLayer) or block (ByBlock). Colour 7 is black on a light background and white on a dark one; pass `background: 'dark'` for white.

## Options

```ts
loadDxf(bytes, {
  background: 'light',   // or 'dark': the colour of colour 7
  orientation: 'auto',   // 'auto', 'z-up' or 'xy'
  arcSegments: 72,       // segments for a full circle
  unitScale: 0.001,      // metres per drawing unit, overriding $INSUNITS
  hiddenLayers: true,    // add layers that are off or frozen, hidden
});
```

## Lower-level access

`parseDxf` reads a file into its header, layers, blocks and entities, with each entity's group codes in order. Use it for data the importer doesn't draw:

```ts
import { parseDxf } from 'mc-dxf-import';

const doc = parseDxf(bytes);
for (const entity of doc.entities) console.log(entity.type, entity.codes);
```

See the [API](API.md) for everything the package exports.
