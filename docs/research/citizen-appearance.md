# Citizen appearance

Stage 2 primary sources, consulted 2026-10-01:

- [three.js color management](https://threejs.org/manual/pages/color-management.html):
  color textures are sRGB; tint calculations use linear RGB.
- [MakeHuman system assets](https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html):
  the existing skin assets have per-item names and CC0 licensing.
- [Khronos PBR](https://www.khronos.org/gltf/pbr): base color textures and
  roughness describe different material properties; skin is non-metallic.

Use the already imported textures, preserve UV seams, and apply skin detail
only to skin. Keep distant vertex-colored LODs. Appearance distributions are
art direction, not biological classifiers; allow variation within each mix.

The other session's clothes directory currently contains generators and two
garment recipes, but no SKILL.md. Do not edit those files. Reuse finished,
licensed garment outputs once their catalog and audience metadata are ready.
