"""Keep the connected scan surface, removing detached flying-pixel islands.

The source .lssnap is left intact so the edit is reversible. The 15 mm voxel
connectivity was chosen after inspecting the scan's component sizes and bounds.
"""
from pathlib import Path
import struct

import numpy as np
from scipy.ndimage import label

source = Path('public/assets/3dImage.lssnap')
target = Path('public/assets/3dImage-clean.lssnap')
raw = source.read_bytes()
if raw[:4] != b'LSS\x01':
    raise ValueError('Unexpected scan format')
count, annotation_length = struct.unpack_from('<ii', raw, 4)
point_type = np.dtype([
    ('x', '<i2'), ('y', '<i2'), ('z', '<i2'),
    ('r', 'u1'), ('g', 'u1'), ('b', 'u1'),
])
points = np.frombuffer(raw, dtype=point_type, count=count, offset=16)
xyz = np.column_stack([points[k] for k in 'xyz']).astype(np.float32) / 1000

# The head, face, body, and surrounding captured surface belong to one large
# component. The floating clusters in the supplied screenshot are separate.
cell_size = 0.015
voxels = np.floor((xyz - xyz.min(axis=0)) / cell_size).astype(np.int32)
occupied = np.zeros(tuple(voxels.max(axis=0) + 2), dtype=bool)
occupied[voxels[:, 0], voxels[:, 1], voxels[:, 2]] = True
components, _ = label(occupied, structure=np.ones((3, 3, 3), dtype=bool))
point_components = components[voxels[:, 0], voxels[:, 1], voxels[:, 2]]
component_sizes = np.bincount(point_components)
main_component = np.argmax(component_sizes[1:]) + 1
keep = point_components == main_component

# Eight bright specks above and to the left of the face remain attached to the
# large component through coarse voxels. This small 3D region was identified
# from the default-view projection; it is outside the visible head surface.
head_flyers = (
    (xyz[:, 0] >= 0) & (xyz[:, 0] <= 0.055)
    & (xyz[:, 1] >= 0.25) & (xyz[:, 1] <= 0.38)
    & (xyz[:, 2] >= 0.9) & (xyz[:, 2] <= 1.08)
)
keep &= ~head_flyers

annotations_start = 16 + count * point_type.itemsize
annotations = raw[annotations_start:annotations_start + annotation_length]
header = bytearray(raw[:16])
struct.pack_into('<i', header, 4, int(keep.sum()))
target.write_bytes(header + points[keep].tobytes() + annotations)
print(f'{count:,} → {keep.sum():,} points; removed {count - keep.sum():,} detached points')
print(target)
