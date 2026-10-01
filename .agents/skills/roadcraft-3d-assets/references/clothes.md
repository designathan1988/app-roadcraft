# Clothes and shoes (MakeHuman proxies bound to the skin)

1. **Model ON the body.** In a Blender script, load base.obj's `body` group (positions from
   `scripts/mh.py: load_base()`), and build the garment around it in the base frame (decimetres, +Y up,
   +Z forward). A reliable way: take the body faces of the region the garment covers (by height and
   limb), offset them outward along the vertex normals by 0.05-0.15 dm (outer layers further out), cut
   the openings (neck, sleeves, hem) as clean edge loops, then shape: flare a skirt with a lathe-like
   falloff, add a collar or cuffs as extruded loops, bevel the hems. Retopologise to an even quad grid;
   no triangle soup.
2. **Budget:** torso or leg garment 1500-4000 triangles; shoes 500-2000.
3. **UVs and texture:** unwrap without overlaps, 4 px margins, 1024 px PNG. Base colour light and
   neutral (the game tints the outfit by luminance); seams, pockets and weave drawn procedurally.
4. **Hide the skin underneath:** write the base `body` vertex indices fully covered by the garment to
   `delete.txt` (whitespace separated). Never hide hands, neck or face.
5. **Bind:** `python scripts/bind_mhclo.py --obj <dir>/<name>.obj --kind clothes --delete-verts <dir>/delete.txt`
   (`--kind shoes` uses the foot's scale vertices). It must print refit < 0.001 and no torn edges.
6. **Look:** `blender -b --factory-startup -P scripts/render_previews.py -- --dir <dir>` renders it on the
   body as the crowd will draw it (the texture is read per vertex: fine print details disappear; keep
   colour regions large).

z_depth: underwear 20, shirt and trousers 50, jacket 60 (`bind_mhclo.py` writes 50 for clothes; edit the
.mhclo line for other layers).
