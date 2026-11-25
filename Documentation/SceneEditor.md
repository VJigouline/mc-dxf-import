# Using it in SceneEditor

[SceneEditor](https://github.com/VJigouline/SceneEditor) opens DXF drawings with mc-dxf-import. Drop a `.dxf` file on the view, or choose one with **Open files** on the Scene tab. ASCII and binary DXF files are both read.

`ThreeSceneService.addDxfFile` reads the file as bytes and calls `loadDxf`. It adds the resulting group to the scene, named after the file, then refits the view.

## Errors and warnings

- **Failure messages:** a file that isn't DXF, or one with nothing to draw, gives a **Failure** message, and the scene is unaffected.
- **Console warnings:** these go to the browser console, with the AutoCAD version of the file. They include text and pattern hatches, which are not drawn, and other entities that were left out.

## The drawing in the editor

- **Orientation:** a flat drawing stays in the XY plane, so it faces SceneEditor's default front view. A 3D drawing is turned Y up, like the other formats.
- **Units:** the drawing is scaled to metres by its units setting.
- **Structure:** the drawing has a group for each layer. Layers that are off or frozen are hidden.
- **Lines and fills:** these keep the drawing's colours, and are not lit.
- **3D faces and meshes:** these are lit MeshStandardMaterials, which can be edited on the Materials tab like any other.

## Tested drawings

These drawings from GDAL's DXF test data open and display correctly in SceneEditor:

- **`ocs2wcs1`:** entities in object coordinate systems, with solid fills and 3D faces.
- **`hatch`:** solid hatches with arc boundaries.
