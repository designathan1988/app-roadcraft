# Altino Arantes architectural benchmark

This is the reference and acceptance target for the building creator. The
existing building in the test map was an exploratory sketch. It must not be
used as proof that the creator can reproduce the actual building.

## Evidence

| Source | What it establishes |
|---|---|
| [Farol Santander, official history](https://www.farolsantander.com.br/sp/sobre-o-farol) | 35 floors, 161.22 m overall height, 1947 completion. |
| [São Paulo municipality](https://todospelocentro.prefeitura.sp.gov.br/noticias/conheca-a-historia-do-farol-santander-um-dos-maiores-predios-de-sao-paulo-inspirado-em-um-marco-arquitetonico-americano) | White porcelain tile facades, brown polished granite at street level, decorative iron doors/grilles, sash windows, 16 m entrance hall. |
| [Arquivo Arq historical collection](https://arquivo.arq.br/projetos/edificio-sede-do-banco-do-estado-de-sao-paulo-sa) | 1,000 m² site, 17,951 m² built area, 35 floors, concrete structure; 1947 frontal and oblique photographs show the original massing. |
| [Acrópole issue 116, pp. 195–206](https://www.acropole.fau.usp.br/edicao/116/5) | Contemporary photographs and a project description, including the distinct central shaft, stepped upper body and monumental ground floor. |
| [Aerial view of the crown](https://rolle.com.br/venue/Edif%C3%ADcio%20Altino%20Arantes%20-%20Farol%20Santander%20ChIJyRDBBlVYzpQR7pqQkvo7KkY) | Roof terraces, nested rectangular crown, tall framed cylindrical observation lantern, white roof cap and flagpole. |
| [Rear facade photograph](https://www.descubrasampa.com.br/2020/07/vista-posterior-do-edificio-altino-arantes.html) | The back repeats the stepped silhouette but has its own opening pattern and rooftop edges. |
| [Wikimedia frontal photograph](https://commons.wikimedia.org/wiki/File:Altino_Arantes_Building_(cropped).jpg) | Present-day facade rhythm and tier transitions. |

The photograph descriptions below are visual observations and inferences. No
complete dimensioned construction drawings were found in these sources, so
unknown floor plate widths and facade bay dimensions must be calibrated from
multiple angles, then recorded as assumptions. Reference photographs are not
bundled into the product.

## Architectural reading

* **Base:** irregular site-filling lower block and a grand entrance; the brown
  granite, doors and grilles are visually distinct from the upper white tile.
  The 16 m hall cannot be represented by a normal 3–4 m storey.
* **Body:** a long, relatively narrow rectangular shaft, with repeated sash
  windows organized by continuous vertical piers. It is not a square office
  box with uniformly spaced dark rectangles on all four faces. The front,
  flanks and rear have different bay counts and wall-to-window ratios.
* **Shoulders:** aligned central bands and flanking masses terminate at
  different levels. Strong horizontal loggia/cornice lines interrupt the long
  vertical body. Their plan offsets are not a single uniform inset applied to
  every side.
* **Crown:** several nested, sometimes chamfered rectangular setbacks and
  tall unbroken white flutes; terraces are visible around them in an aerial
  view. The crown is a designed continuous silhouette, not a pile of generic
  independent boxes.
* **Lantern:** a tall cylindrical frame with glass between white mullions, a
  white roof cap and a flagpole. Typical photographs show the São Paulo state
  flag (black and white stripes with a red canton); the city flag in a 2009
  photograph was a special occasion.
* **Material:** the prevailing surface is white ceramic/porcelain tile, with
  slightly warmer stone/ceramic trim. The lowest levels are brown polished
  granite and decorative ironwork. Lighting should preserve the building's
  white appearance and emphasize the vertical relief.

## Tool capabilities required by this benchmark

| Capability | Current gap | General solution |
|---|---|---|
| Continuous floor profile | One fixed storey height and manual stacked masses | Split a selected building tier at any floor without changing total height; drag each tier's outline in place; list levels as one profile. |
| Monumental lobby | Ground height capped at 9 m | Independent ground height up to at least 20 m and optional per-level heights. |
| Asymmetrical setbacks | The automatic inset moves every edge equally | Edit each tier face independently, with optional mirror symmetry and numeric dimensions. |
| Art Deco corners | Manual many-point polygons | Chamfer or round any selected corner with measured distance/radius. |
| Facade rhythm | Bay count follows one building-wide module | Per-face bay count and adjustable window width, sill and head; preserve overrides when counts change. |
| Signature window | Generic window/shutter | Sash window with actual horizontal meeting rail and consistent glazing. |
| Projecting piers | Hard-coded ribs in one pattern | Per-face pilaster count, width, depth, start/end floors and material, editable on the building. |
| Horizontal gallery | A single floor-wide pattern or mass seam | Band/loggia tool at a chosen floor, with projection, thickness, bay selection and finish. |
| Entrance/materials | One regular door and white plaster base | Portal assembly spanning multiple bays; ground granite and facade porcelain as selectable materials. |
| Lantern | A generic faceted cylinder with dark panels | Measured circular/elliptical ring, frame count, glass ratio, roof cap, height and flag type. |
| Comparison | Only an isometric gameplay view | In-world front/side elevation views and a reference overlay for matching each facade without leaving the terrain editor. |

## Acceptance

The user must be able to author the landmark from the normal creator tools on
the live terrain. Compare front, rear, both sides and aerial/roof against the
sources above. Check 35 floors and a measured overall height close to
161.22 m; verify the actual base, shaft, shoulder and crown silhouettes,
front/side-specific window rhythms, brown granite lobby, white porcelain
facade, deep Art Deco ribs, upper gallery, framed lantern and state flag. The
result must survive save/load and remain editable at every tier and face.
Only after that comparison should its reusable blueprint be treated as a
finished architectural reproduction.
