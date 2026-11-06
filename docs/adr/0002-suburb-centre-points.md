# 0002: Suburb centre points

- Status: Accepted
- Date: 2026-11-06

## Context

The compare tool lets a person pick a suburb and finds nearby hospitals in the browser. It needs one
point for each suburb. The only source is the pinned `abs-suburbs-localities-2021` file from
publicdata.au ([D2](0001-architecture-decision-register.md#d2-publicdataaus-stable-api-is-the-only-data-source)).
That file holds each suburb's shape as WKB polygons in a `geometry` column, in GDA2020, and no
precomputed centre.

## Decision

D29: each suburb's centre is the area centroid of its shape when that point lies inside the shape,
and otherwise the pole of inaccessibility of its largest part. The code is
`pipeline/src/surgerywaits/suburbs.py`.

- Each ring's centroid comes from the shoelace formula on planar longitude and latitude, taken about
  the ring's first vertex. A multipolygon's centroid is the mean of its rings' centroids weighted by
  area, and a hole counts as negative area.
- "Inside" is an even-odd test over every ring of every part, so holes and the gaps between parts
  are outside.
- When the centroid is outside, the centre is the pole of inaccessibility of the part with the
  largest area net of its holes: the point farthest from that part's edges. The polylabel cell
  search finds it to 1e-5 degrees with a fixed visiting order, so it is deterministic.
- The centre is rounded to 5 decimal places, about a metre.
- The parser reads 2D WKB `Polygon` and `MultiPolygon` in either byte order and fails on anything
  else, including a Z flag. It uses pyarrow and the standard library, with no geometry package.
- The suburb keeps the name the ABS publishes. The ABS already qualifies a name that several states
  share, such as "Abbotsford (NSW)" and "Abbotsford (Vic.)". A name shared twice within one state
  fails the build.
- Special-purpose codes are excluded: the codes ending 9494 ("No usual address"), the codes ending
  9797 ("Migratory - Offshore - Shipping") and `ZZZZZ` ("Outside Australia"). They have no shape. Any
  other row without a usable shape fails the build.
- Suburbs are sorted by code, so two builds give the same output.

Why: the site finds hospitals near a suburb by distance from its centre, so the centre must belong
to the suburb. The area centroid is the natural centre and needs no extra dependency. On the pinned
file it falls outside its own shape for 161 of 15,334 suburbs, which would put the centre in
another suburb or in water. For those 161 the pole replaces it. The other 15,173
keep the plain centroid. The real-data test asserts both counts and that every centre is inside
its shape.

## Alternatives considered

- **The plain area centroid for every suburb.** It leaves 161 centres outside their shapes.
- **The midpoint of the bounding box.** It is the previous site's method, and it can fall outside
  a concave shape.
- **A geometry package such as shapely.** It adds a compiled dependency, and the code here is short
  enough to test directly.

## Consequences

- A new version of the boundary file is a manifest change and a new pin. The test over the cached
  file checks the counts, so a changed file is noticed.
- The site shows the centre as an approximate position and never as a boundary.
