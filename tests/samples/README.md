# DXF test files

Real DXF files that the tests load, written by AutoCAD, QCAD, GDAL and other programs, from R12 to AutoCAD 2018, in ASCII and binary.

They come unchanged from [autotest/ogr/data/dxf](https://github.com/OSGeo/gdal/tree/master/autotest/ogr/data/dxf) in the GDAL repository, as of commit `948f102a9e` (25 November 2026). GDAL is licensed under an [MIT-style licence](https://github.com/OSGeo/gdal/blob/master/LICENSE.TXT), copyright Frank Warmerdam, Even Rouault and the other GDAL authors.

The files with `clusterfuzz` in their names are deliberately broken, found by fuzzing: the tests check that they fail cleanly.

These files keep their own licence. They are test data only, and are not part of the npm package, which includes only `dist`, `Documentation`, `README.md` and `LICENSE`.
