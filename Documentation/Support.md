# Formats and support

## Files

- **ASCII DXF:** files from R12 to AutoCAD 2018 (AC1032) and later.
  - Encoding: UTF-8 (AutoCAD 2007 and later) is detected. Other files are read as Windows-1252, the usual code page of older files.
  - Text escapes: `\U+XXXX` escapes and the `%%c`, `%%d` and `%%p` codes are decoded.
- **Binary DXF:** files with 1-byte group codes (R12) and 2-byte group codes (R13 and later).
- **Sections:** HEADER, TABLES (the LAYER table), BLOCKS and ENTITIES are read, and other sections are skipped. A section whose `0 SECTION` line is missing is still read, and so is a file of entities without sections.
- **Damaged files:** a file damaged part way through is read up to the damage, with a warning. Input that doesn't start like DXF throws `DxfError`.
- **Model and paper space:** only model space is drawn. Entities marked as paper space (group code 67) are left out, and so are invisible entities (group code 60).

## Entities

| Entity | Drawn as | Notes |
| --- | --- | --- |
| LINE | lines | |
| CIRCLE, ARC | lines | In the entity's OCS. |
| ELLIPSE | lines | Full or partial, by its parameters. |
| LWPOLYLINE | lines | Bulges, closure and elevation, in its OCS. Widths are not drawn. |
| POLYLINE (2D) | lines | Bulges and closure, in its OCS. Spline-fit polylines are drawn through their fitted vertices. |
| POLYLINE (3D) | lines | |
| POLYLINE (polyface mesh) | faces | |
| POLYLINE (polygon mesh) | faces | M × N grids, closed in either direction. The control grid is drawn, without surface smoothing. |
| SPLINE | lines | NURBS by control points, knots and weights, or a smooth curve through the fit points. |
| LEADER | lines | Without the arrowhead. |
| POINT | points | |
| 3DFACE | faces | Triangles or quadrilaterals. |
| SOLID, TRACE | fills | Corners in their 1, 2, 4, 3 order, in their OCS. |
| HATCH | fills | Solid and gradient fills only, with holes. |
| MESH | faces | The control mesh, without subdivision. |
| INSERT | its block | Base point, scale, rotation, column and row arrays, and OCS; nested to any depth. A block that inserts itself is stopped. |
| DIMENSION | its block | The lines and arrowheads of the dimension's block; its text is returned. |
| TEXT, MTEXT, ATTRIB | not drawn | Returned in `texts`, with MTEXT formatting removed. |
| 3DSOLID, BODY, REGION, SURFACE | not drawn | They hold ACIS data. |
| Others (RAY, XLINE, IMAGE, WIPEOUT, MLINE, HELIX, MLEADER, …) | not drawn | Counted in `stats.skipped`, with a warning. |

**Thickness:** entities with a thickness (group code 39) are drawn without it, as lines.

### Hatches

These boundary paths are read:

- polyline paths, with bulges;
- edge paths of lines, arcs, elliptical arcs and splines.

For clockwise arc and elliptical arc edges, the stored angles are mirrored, so the edge runs through the negated angles. Elliptical arc edges give geometric angles from the major axis, which are converted to the ellipse's parameter; this differs from ELLIPSE entities, which give parameters.

Loops inside an odd number of other loops are holes. Pattern hatches are not drawn, with a warning.

## Coordinates

- **OCS:** 2D entities (CIRCLE, ARC, LWPOLYLINE, 2D POLYLINE, SOLID, TRACE, HATCH, INSERT and TEXT) are placed through their object coordinate system, by the arbitrary axis algorithm. Other entities give world coordinates.
- **Blocks:** each insert's transform is applied to the block's entities, after moving the block's base point to the origin.
- **Units:** `$INSUNITS` scales the drawing to metres, from inches and feet to kilometres and the other units it names. Drawings without units (0) are not scaled.
- **Orientation:** by default, a drawing whose geometry all lies in one XY plane stays in that plane. Any other drawing is turned from Z up to three.js's Y up.

## Layers and colours

- **Colours:** entity colours are read from true colour (group code 420) first, then from the ACI index (62):
  - 256 (ByLayer) takes the layer's colour;
  - 0 (ByBlock) takes the colour of the insert that draws it;
  - colour 7 is black or white for the background option.
- **Layers:** inside a block, entities on layer 0 take the insert's layer.
- **Hidden layers:** layers that are off (a negative colour) or frozen are added hidden, or left out with `hiddenLayers: false`.
- **Not read:** line types, line weights, transparency and plot styles. WebGL draws lines one pixel wide.
