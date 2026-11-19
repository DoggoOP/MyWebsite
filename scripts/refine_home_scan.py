"""Clean and fill the homepage scan.

Reads the full cleaned capture (three people), keeps only Ethan, and writes
3dImage-home-refined.lssnap plus matching surfel axes. Needs open3d:
    uv venv -p 3.12 .venv-scan && uv pip install -p .venv-scan open3d scipy
    .venv-scan/bin/python scripts/refine_home_scan.py

0. Selection: the floor plane is fitted and kept inside Ethan's quadrant; above
   the floor, whole connected clusters are kept if most of their points fall in
   that quadrant. A straight crop sliced through hair and a hand; this keeps
   every connected part of him and drops the neighbour that leaked in.
1. Floaters: points that fail a statistical outlier test or belong to a tiny
   detached cluster are removed, but only if they also sit off the surface
   rebuilt from the remaining points. Sparse but real skin (chin, lips) stays.
2. Gaps: a screened Poisson surface is sampled, and samples are kept only where
   the scan is thin and real points surround the sample on all sides. Open
   edges and the space between separate surfaces are not filled, except around
   the head and neck, where the cameras could not see under the chin and much
   larger gaps are closed so the head joins the shoulders.
3. Colour for each added point comes from nearby real points whose normals face
   the same way, so a fill on the face cannot borrow hair from behind the head.
This is geometric hole filling from a smooth surface fit, not a learned model.
"""
from pathlib import Path
import os
import struct

import numpy as np
import open3d as o3d
from scipy.interpolate import RBFInterpolator
from scipy.spatial import Delaunay, cKDTree

ASSETS = Path(__file__).resolve().parent.parent / 'public/assets'
SOURCE = ASSETS / '3dImage-clean.lssnap'
# DEBUG_DIR writes to another folder and paints each face-fill view a flat colour.
DEBUG_DIR = os.environ.get('DEBUG_DIR')
TARGET = Path(DEBUG_DIR or ASSETS) / '3dImage-home-refined.lssnap'
TARGET_AXES = Path(DEBUG_DIR or ASSETS) / '3dImage-home-refined-surfels.bin'
POINT = np.dtype([('x', '<i2'), ('y', '<i2'), ('z', '<i2'),
                  ('r', 'u1'), ('g', 'u1'), ('b', 'u1')])

raw = SOURCE.read_bytes()
if raw[:4] != b'LSS\x01':
    raise ValueError('Unexpected scan format')
count, annotation_length = struct.unpack_from('<ii', raw, 4)
points = np.frombuffer(raw, POINT, count, 16)
xyz = np.column_stack([points[k] for k in 'xyz']).astype(np.float64) / 1000
rgb = np.column_stack([points[k] for k in 'rgb']).astype(np.float64)

# 0. Selection.
grid = np.column_stack([points['x'], points['y']]).astype(np.int64)
quadrant = ((grid[:, 0] * 2 >= grid[:, 0].min() + grid[:, 0].max())
            & (grid[:, 1] * 2 >= grid[:, 1].min() + grid[:, 1].max()))
x_cut, y_cut = xyz[quadrant, 0].min(), xyz[quadrant, 1].min()
whole = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(xyz))
(a, b, c, d), _ = whole.segment_plane(0.02, 3, 2000)
floor = np.abs(xyz @ [a, b, c] + d) / np.linalg.norm([a, b, c]) < 0.025
nearby = np.flatnonzero((xyz[:, 0] >= x_cut - 0.15) & (xyz[:, 1] >= y_cut - 0.15) & ~floor)
labels = np.asarray(o3d.geometry.PointCloud(o3d.utility.Vector3dVector(xyz[nearby]))
                    .cluster_dbscan(eps=0.012, min_points=3))
selected = quadrant & floor
for label in np.unique(labels[labels >= 0]):
    ids = nearby[labels == label]
    if len(ids) > 20 and quadrant[ids].mean() > 0.5:
        selected[ids] = True
print(f'selected {selected.sum():,} of {count:,} points')
xyz, rgb = xyz[selected], rgb[selected]
count = len(xyz)


def cloud(positions):
    pc = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(positions))
    pc.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=0.02, max_nn=30))
    pc.orient_normals_consistent_tangent_plane(20)
    return pc


def poisson(pc):
    # Single-threaded: the multithreaded iso-surface pass aborts on this scan.
    mesh, density = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
        pc, depth=9, scale=1.05, n_threads=1)
    density = np.asarray(density)
    mesh.remove_vertices_by_mask(density < np.quantile(density, 0.06))
    mesh.compute_vertex_normals()
    return mesh


# 1. Floaters.
full = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(xyz))
_, inliers = full.remove_statistical_outlier(nb_neighbors=30, std_ratio=2.2)
suspect = np.ones(count, bool)
suspect[inliers] = False
labels = np.asarray(full.cluster_dbscan(eps=0.011, min_points=4))
sizes = np.bincount(labels[labels >= 0])
suspect |= (labels < 0) | (sizes[np.maximum(labels, 0)] < 60)

surface = poisson(cloud(xyz[~suspect]))
scene = o3d.t.geometry.RaycastingScene()
scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(surface))
off_surface = scene.compute_distance(
    o3d.core.Tensor(xyz[suspect].astype(np.float32))).numpy() > 0.006
remove = np.zeros(count, bool)
remove[np.flatnonzero(suspect)[off_surface]] = True
kept_xyz, kept_rgb = xyz[~remove], rgb[~remove]

# 2. Gaps.
pc = cloud(kept_xyz)
normals = np.asarray(pc.normals)
mesh = poisson(pc)
samples = mesh.sample_points_uniformly(number_of_points=300_000, use_triangle_normal=True)
sample_xyz, sample_normals = np.asarray(samples.points), np.asarray(samples.normals)
tree = cKDTree(kept_xyz)
spacing = np.median(tree.query(kept_xyz, k=2)[0][:, 1])
gap_distance, _ = tree.query(sample_xyz)

# Head and neck: the highest body points are the crown; the neck sits below it.
crown = kept_xyz[kept_xyz[:, 2] > np.percentile(kept_xyz[:, 2], 97)].mean(0)
def in_head(points):
    return np.linalg.norm((points - (crown - [0, 0, 0.12])) * [1, 1, 0.8], axis=1) < 0.2

# Body: small holes only. Head: only the wide gap under the chin. Small-gap
# surface fill around the head wrapped a dark hull of hair over the face.
head = in_head(sample_xyz)
thin = np.where(head, (gap_distance > 0.02) & (gap_distance < 0.07),
                (gap_distance > spacing * 1.4) & (gap_distance < 0.022))
candidates, candidate_normals = sample_xyz[thin], sample_normals[thin]
in_neck = head[thin]
enclosed = np.zeros(len(candidates), bool)
for radius in (0.012, 0.02, 0.03, 0.05, 0.08):
    for i, ids in enumerate(tree.query_ball_point(candidates, radius)):
        if enclosed[i] or len(ids) < 12 or (radius > 0.03 and not in_neck[i]):
            continue
        limit = 0.4 if in_neck[i] else 0.22
        enclosed[i] = np.linalg.norm(kept_xyz[ids].mean(0) - candidates[i]) < limit * radius
added, added_normals, added_neck = candidates[enclosed], candidate_normals[enclosed], in_neck[enclosed]

# 3. Colour from same-side neighbours.
dist, idx = tree.query(added, k=48)
facing = np.einsum('nkj,nj->nk', normals[idx], added_normals) > 0.4
weights = np.where(facing, 1.0, 1e-3) / (dist + 2e-3) ** 2
added_rgb = (kept_rgb[idx] * weights[..., None]).sum(1) / weights.sum(1, keepdims=True)
# Under the chin, keep only skin- or fabric-coloured fill; a hair-coloured wide
# fill is a bridge between the jaw and the hair beside the jaw.
bridge = added_neck & (added_rgb.mean(1) < 60)
added, added_rgb = added[~bridge], added_rgb[~bridge]

# 4. The face was captured as thin scan lines, so hair behind the head showed
# through the gaps. Around the head, add midpoints between neighbouring scan
# points; a midpoint always lies between two measured points on one surface.
head_ids = np.flatnonzero(in_head(kept_xyz))
pair_dist, pair_idx = tree.query(kept_xyz[head_ids], k=7)
a = np.repeat(head_ids, 6)
b = pair_idx[:, 1:].ravel()
d = pair_dist[:, 1:].ravel()
same_side = np.einsum('ij,ij->i', normals[a], normals[b]) > 0.5
# Skin next to hair would give a half-dark midpoint, which shows as a dark
# speckle on the face; only pair points of similar brightness.
similar = np.abs(kept_rgb[a].mean(1) - kept_rgb[b].mean(1)) < 35
keep_pair = (a < b) & (d > spacing * 0.9) & (d < spacing * 2.6) & same_side & similar
mid = (kept_xyz[a[keep_pair]] + kept_xyz[b[keep_pair]]) / 2
mid_rgb = (kept_rgb[a[keep_pair]] + kept_rgb[b[keep_pair]]) / 2
# Drop midpoints that land on an existing point or on each other.
_, unique = np.unique(np.rint(mid * 1000 / 2).astype(np.int64), axis=0, return_index=True)
mid, mid_rgb = mid[unique], mid_rgb[unique]
clear = tree.query(mid)[0] > spacing * 0.35
added = np.vstack([added, mid[clear]])
added_rgb = np.vstack([added_rgb, mid_rgb[clear]])
out_xyz = np.vstack([kept_xyz, added])
out_rgb = np.vstack([kept_rgb, added_rgb])


# 5. Face. No camera saw one side of the lower jaw, so the hair at the back of
# the head showed through the face. Seen along the face direction, the lit skin
# outlines the face; a smooth thin-plate surface through the skin predicts where
# the face should be. Any spot inside that outline that is empty or more than
# 2 cm behind the prediction gets points on the predicted surface, coloured
# from the nearest lit skin. The same applies to small gaps between scan lines,
# so the face is one continuous skin layer and the hair behind never shows through. Shadowed points already on the lower face are
# relit toward the surrounding skin tone, keeping some of their shading.
def fill_face(xyz, rgb):
    r, g, b = rgb.T
    lum = rgb.mean(1)
    top = xyz[xyz[:, 2] > np.percentile(xyz[:, 2], 97)].mean(0)
    head = np.linalg.norm((xyz - (top - [0, 0, 0.12])) * [1, 1, 0.8], axis=1) < 0.2
    skin = head & (r > g) & (g > b) & (r - b > 30) & (lum > 100)
    centre = xyz[skin].mean(0)
    for _ in range(3):
        skin &= np.linalg.norm(xyz - centre, axis=1) < 0.16
        centre = xyz[skin].mean(0)
    middle = (top + centre) / 2
    head_centre = xyz[head & (np.linalg.norm(xyz - middle, axis=1) < 0.12)].mean(0)
    up = (top - centre) / np.linalg.norm(top - centre)
    rng = np.random.default_rng(0)
    xyz_measured = xyz.copy()
    measured = cKDTree(xyz_measured)
    cell = 0.002
    forward = (centre - head_centre) / np.linalg.norm(centre - head_centre)
    side = np.cross(up, forward)
    side /= np.linalg.norm(side)
    views = [forward, np.array([0, -0.643, -0.766]),
             forward * 0.6 + side * 0.8, forward * 0.6 - side * 0.8,
             forward * 0.6 - up * 0.8]
    for view_index, view in enumerate(views):
        view = view / np.linalg.norm(view)
        e1 = np.cross(view, [0, 0, 1.0])
        e1 /= np.linalg.norm(e1)
        e2 = np.cross(view, e1)
        rel = xyz - head_centre
        uv = np.column_stack([rel @ e1, rel @ e2])
        depth = rel @ view
        face = skin & (depth > 0)
        skin_uv, skin_depth, skin_rgb = uv[face], depth[face], rgb[face]
        outline = Delaunay(skin_uv)
        sample = rng.choice(len(skin_uv), min(3000, len(skin_uv)), replace=False)
        surface = RBFInterpolator(skin_uv[sample], skin_depth[sample],
                                  kernel='thin_plate_spline', smoothing=0.001, neighbors=60)
        skin_tree = cKDTree(skin_uv)

        cells = np.floor(uv[head] / cell).astype(int)
        lo = cells.min(0)
        size = cells.max(0) - lo + 1
        front = np.full(size, -np.inf)
        np.maximum.at(front, (cells[:, 0] - lo[0], cells[:, 1] - lo[1]), depth[head])
        gx, gy = np.mgrid[0:size[0], 0:size[1]]
        centres = (np.column_stack([gx.ravel(), gy.ravel()]) + lo + 0.5) * cell
        inside = outline.find_simplex(centres) >= 0
        centres, seen = centres[inside], front.ravel()[inside]
        expected = surface(centres)
        to_skin, _ = skin_tree.query(centres)
        # Every face cell gets a skin point unless real skin is already there or
        # something real (hair over the forehead) sits in front of the face.
        # Straight on, the real face is dense; fill only true gaps there so the
        # eyes and mouth keep their detail. Oblique views fill every gap.
        min_gap = 0.0035 if view_index == 0 else cell * 0.8
        missing = (~np.isfinite(seen) | (seen < expected + 0.004)) & (to_skin > min_gap) & (to_skin < 0.03)
        holes, hole_depth = centres[missing], expected[missing]
        dist, idx = skin_tree.query(holes, k=16)
        w = 1 / (dist + 0.004) ** 2
        hole_rgb = (skin_rgb[idx] * w[..., None]).sum(1) / w.sum(1, keepdims=True)
        new = head_centre + np.outer(holes[:, 0], e1) + np.outer(holes[:, 1], e2) + np.outer(hole_depth, view)
        # Keep fill on the face: near the face centre and below the hairline.
        on_face = (np.linalg.norm(new - centre, axis=1) < 0.12) & ((new - centre) @ up < 0.05)
        new, hole_rgb = new[on_face], hole_rgb[on_face]
        # Closeness in the projection says nothing about depth, so the oblique
        # views check in 3D: real points must surround each fill point, or the
        # point would hang off the edge of the face. The two front views rebuild
        # the unseen jaw, which lies at the edge of the scan, so they skip this.
        enclosed = np.full(len(new), view_index < 2)
        for i, ids in enumerate(measured.query_ball_point(new, 0.03)):
            if view_index >= 2 and len(ids) >= 10:
                enclosed[i] = np.linalg.norm(xyz_measured[ids].mean(0) - new[i]) < 0.012
        new, hole_rgb = new[enclosed], hole_rgb[enclosed]
        if DEBUG_DIR:
            hole_rgb[:] = [[0, 255, 0], [255, 0, 255], [0, 128, 255], [255, 255, 0], [255, 0, 0]][view_index]

        if view_index == 0:
            shadowed = np.flatnonzero(head & ~skin & (lum < 110) & (depth > 0) & ((xyz - centre) @ up < 0.01))
            shadowed = shadowed[outline.find_simplex(uv[shadowed]) >= 0]
            shadowed = shadowed[np.abs(depth[shadowed] - surface(uv[shadowed])) < 0.02]
            dist, idx = skin_tree.query(uv[shadowed], k=16)
            w = 1 / (dist + 0.004) ** 2
            target = (skin_rgb[idx] * w[..., None]).sum(1) / w.sum(1, keepdims=True)
            shade = np.clip(lum[shadowed] / target.mean(1), 0, 1)[:, None]
            rgb = rgb.copy()
            rgb[shadowed] = target * (0.82 + 0.18 * shade)
            print(f'face: relit {len(shadowed):,} shadowed points')
        print(f'face: filled {len(new):,} points (view {view_index})')
        xyz = np.vstack([xyz, new])
        rgb = np.vstack([rgb, hole_rgb])
        skin = np.r_[skin, np.ones(len(new), bool)]
        head = np.r_[head, np.ones(len(new), bool)]
        lum = rgb.mean(1)
    return xyz, rgb


out_xyz, out_rgb = fill_face(out_xyz, out_rgb)


# 5b. Hair. The back of the head was captured sparsely, so seen from behind the
# face showed through the curls. Same method as the face, from behind and above:
# a smooth surface through the hair points, with gaps filled in hair colour.
def fill_hair(xyz, rgb):
    r, g, b = rgb.T
    lum = rgb.mean(1)
    top = xyz[xyz[:, 2] > np.percentile(xyz[:, 2], 97)].mean(0)
    head = np.linalg.norm((xyz - (top - [0, 0, 0.12])) * [1, 1, 0.8], axis=1) < 0.2
    skin = head & (r > g) & (g > b) & (r - b > 30) & (lum > 100)
    face_centre = xyz[skin].mean(0)
    head_centre = xyz[head & (np.linalg.norm(xyz - (top + face_centre) / 2, axis=1) < 0.12)].mean(0)
    hair = head & (lum < 75) & (np.linalg.norm(xyz - head_centre, axis=1) < 0.15)
    forward = (face_centre - head_centre) / np.linalg.norm(face_centre - head_centre)
    up = (top - head_centre) / np.linalg.norm(top - head_centre)
    side = np.cross(up, forward)
    side /= np.linalg.norm(side)
    measured = cKDTree(xyz)
    rng = np.random.default_rng(1)
    cell = 0.0025
    views = [-forward, up, -forward * 0.7 + up * 0.7, -forward * 0.6 + side * 0.8,
             -forward * 0.6 - side * 0.8, side, -side]
    all_new, all_rgb = [], []
    for view in views:
        view = view / np.linalg.norm(view)
        helper = [0, 0, 1.0] if abs(view[2]) < 0.9 else [0, 1.0, 0]
        e1 = np.cross(view, helper)
        e1 /= np.linalg.norm(e1)
        e2 = np.cross(view, e1)
        rel = xyz - head_centre
        uv = np.column_stack([rel @ e1, rel @ e2])
        depth = rel @ view
        shell = hair & (depth > 0)
        if shell.sum() < 200:
            continue
        hair_uv, hair_depth, hair_rgb = uv[shell], depth[shell], rgb[shell]
        outline = Delaunay(hair_uv)
        sample = rng.choice(len(hair_uv), min(3000, len(hair_uv)), replace=False)
        surface = RBFInterpolator(hair_uv[sample], hair_depth[sample],
                                  kernel='thin_plate_spline', smoothing=0.002, neighbors=60)
        hair_tree = cKDTree(hair_uv)
        cells = np.floor(uv[head] / cell).astype(int)
        lo = cells.min(0)
        size = cells.max(0) - lo + 1
        front = np.full(size, -np.inf)
        np.maximum.at(front, (cells[:, 0] - lo[0], cells[:, 1] - lo[1]), depth[head])
        gx, gy = np.mgrid[0:size[0], 0:size[1]]
        centres = (np.column_stack([gx.ravel(), gy.ravel()]) + lo + 0.5) * cell
        inside = outline.find_simplex(centres) >= 0
        centres, seen = centres[inside], front.ravel()[inside]
        expected = surface(centres)
        to_hair, _ = hair_tree.query(centres)
        missing = (~np.isfinite(seen) | (seen < expected + 0.004)) & (to_hair > cell * 0.8) & (to_hair < 0.02)
        holes, hole_depth = centres[missing], expected[missing]
        new = head_centre + np.outer(holes[:, 0], e1) + np.outer(holes[:, 1], e2) + np.outer(hole_depth, view)
        dist, idx = hair_tree.query(holes, k=12)
        w = 1 / (dist + 0.004) ** 2
        new_rgb = (hair_rgb[idx] * w[..., None]).sum(1) / w.sum(1, keepdims=True)
        # Real hair must surround every fill point in 3D.
        keep = np.zeros(len(new), bool)
        for i, ids in enumerate(measured.query_ball_point(new, 0.03)):
            if len(ids) >= 10:
                keep[i] = np.linalg.norm(xyz[ids].mean(0) - new[i]) < 0.012
        all_new.append(new[keep])
        all_rgb.append(new_rgb[keep])
    added = np.vstack(all_new)
    print(f'hair: filled {len(added):,} points')
    return np.vstack([xyz, added]), np.vstack([rgb, np.vstack(all_rgb)])


out_xyz, out_rgb = fill_hair(out_xyz, out_rgb)


# 6. Despeckle the head. Single dark points on skin (scanner noise) read as
# holes. A point much darker than the median of its 7 mm neighbourhood takes
# that median colour; eyes, brows and hair are dark as a group and stay.
def despeckle(xyz, rgb):
    top = xyz[xyz[:, 2] > np.percentile(xyz[:, 2], 97)].mean(0)
    head = np.flatnonzero(np.linalg.norm((xyz - (top - [0, 0, 0.12])) * [1, 1, 0.8], axis=1) < 0.2)
    tree = cKDTree(xyz[head])
    lum = rgb[head].mean(1)
    rgb = rgb.copy()
    for _ in range(2):
        neighbours = tree.query_ball_point(xyz[head], 0.007)
        changed = 0
        for i, ids in enumerate(neighbours):
            if len(ids) < 6:
                continue
            local = np.median(lum[ids])
            if lum[i] < 0.6 * local and local > 90:
                rgb[head[i]] = np.median(rgb[head][ids], axis=0)
                changed += 1
        lum = rgb[head].mean(1)
        print(f'despeckle: recoloured {changed:,} points')
    return rgb


out_rgb = despeckle(out_xyz, out_rgb)
out = np.empty(len(out_xyz), POINT)
for i, k in enumerate('xyz'):
    out[k] = np.rint(out_xyz[:, i] * 1000).astype('<i2')
for i, k in enumerate('rgb'):
    out[k] = np.clip(np.rint(out_rgb[:, i]), 0, 255).astype('u1')
header = bytearray(raw[:16])
struct.pack_into('<i', header, 4, len(out))
source_count = struct.unpack_from('<i', raw, 4)[0]
annotations = raw[16 + source_count * 9:16 + source_count * 9 + annotation_length]
TARGET.write_bytes(header + out.tobytes() + annotations)

# Surfel axes, same local-PCA method as build_surfels.py, on the quantised points.
q = np.column_stack([out[k] for k in 'xyz']).astype(np.float32) / 1000
distances, indices = cKDTree(q).query(q, k=16, workers=-1)
offsets = q[indices[:, 1:]] - q[:, None, :]
offsets -= offsets.mean(axis=1, keepdims=True)
covariance = np.einsum('nki,nkj->nij', offsets, offsets) / offsets.shape[1]
eigenvalues, eigenvectors = np.linalg.eigh(covariance)
# Splat size never drops below the capture's own point spacing; the head was
# densified, and smaller splats there let the background show through the face.
local = np.maximum(np.median(distances[:, 1:5], axis=1), spacing)
# Facial skin gets larger splats so the hair behind the head cannot show
# through the gaps between scan lines.
top = q[q[:, 2] > np.percentile(q[:, 2], 97)].mean(0)
out_rgb_f = np.column_stack([out[k] for k in 'rgb']).astype(float)
facial = ((np.linalg.norm((q - (top - [0, 0, 0.12])) * [1, 1, 0.8], axis=1) < 0.2)
          & (out_rgb_f[:, 0] > out_rgb_f[:, 1]) & (out_rgb_f[:, 1] > out_rgb_f[:, 2])
          & (out_rgb_f[:, 0] - out_rgb_f[:, 2] > 25) & (out_rgb_f.mean(1) > 90))
local[facial] = np.maximum(local[facial], spacing * 2.0)
# Hair gets the same treatment, so the face does not show through the curls
# when the head is seen from behind (splats are visible from both sides).
head_dark = ((np.linalg.norm((q - (top - [0, 0, 0.12])) * [1, 1, 0.8], axis=1) < 0.2)
             & (out_rgb_f.mean(1) < 70))
local[head_dark] = np.maximum(local[head_dark], spacing * 2.1)
major = np.clip(2.15 * np.sqrt(np.maximum(eigenvalues[:, 2], 0)), local * 0.9, local * 3.1)
minor = np.clip(2.15 * np.sqrt(np.maximum(eigenvalues[:, 1], 0)), local * 0.75, local * 3.1)
axes = np.concatenate([eigenvectors[:, :, 2] * major[:, None],
                       eigenvectors[:, :, 1] * minor[:, None]], axis=1)
packed = np.rint(axes * 10000).clip(-32768, 32767).astype('<i2')
TARGET_AXES.write_bytes(struct.pack('<I', len(out)) + packed.tobytes())

print(f'{count:,} points: removed {remove.sum():,} floaters '
      f'({suspect.sum():,} flagged), added {len(added):,} → {len(out):,}')
