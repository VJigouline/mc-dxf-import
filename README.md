# mc-dxf-import

A DXF importer for [three.js](https://threejs.org/), written in TypeScript with no other dependencies. It reads AutoCAD DXF drawings, ASCII or binary, from R12 to the latest versions, and builds a three.js group with the drawing's lines, curves, fills and faces, grouped by layer and coloured as in AutoCAD. It was made for [SceneEditor](https://github.com/VJigouline/SceneEditor), and works in any three.js application.

```ts
import { loadDxf } from 'mc-dxf-import';

const result = loadDxf(await file.arrayBuffer());
scene.add(result.group);            // THREE.Group, in metres
console.log(result.version);        // "AC1015" for AutoCAD 2000
console.log(result.warnings);       // anything that couldn't be read
```

## What it reads

- **Files:** ASCII and binary DXF, from R12 to AutoCAD 2018 (AC1032) and later. The text encoding (UTF-8, or the Windows code page of older files) is detected.
- **Curves**, drawn as lines:
  - lines, circles, arcs and ellipses;
  - LWPOLYLINE and 2D and 3D POLYLINE, with bulges (arc segments);
  - splines, by their control points or fit points;
  - leaders.
- **Areas and faces:**
  - SOLID and TRACE fills, and solid and gradient HATCH fills with holes, whose boundaries may hold lines, arcs, elliptical arcs and splines;
  - 3DFACE, polyface and polygon meshes, and MESH entities, as lit faces.
- **Points.**
- **Blocks:** inserts, nested to any depth, with base points, scale, rotation and column and row arrays. Dimensions are drawn from their blocks.
- **Coordinates:** each 2D entity's object coordinate system (OCS), and the drawing units ($INSUNITS), converted to metres.
- **Layers and colours:**
  - ACI and true colours, ByLayer and ByBlock;
  - entities on layer 0 inside blocks taking the insert's layer;
  - layers that are off or frozen, hidden.

Text is not drawn, but it is returned with its position, height and colour. Pattern hatches, ACIS solids (3DSOLID, BODY, REGION), images, line types and line widths are not drawn either; the result's warnings say what was left out. See [Formats and support](Documentation/Support.md) for the details.

## Install

The package is not on the npm registry. Install it from GitHub:

```sh
npm install github:VJigouline/mc-dxf-import
```

`three` (r160 or later) is a peer dependency. The package builds itself on install.

## Documentation

- [Getting started](Documentation/GettingStarted.md)
- [API](Documentation/API.md)
- [Formats and support](Documentation/Support.md)

## Development

```sh
npm install
npm test           # unit tests, with Vitest
npm run typecheck
npm run build      # dist/
```

The tests also load real DXF files from GDAL's test data, kept in [`tests/samples`](tests/samples/README.md) with their licence. It needs Node.js 22 or later.

## Licence

[MIT](LICENSE)
