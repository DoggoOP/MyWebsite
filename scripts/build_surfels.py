"""Estimate anisotropic tangent splats for the cleaned LSSNAP scan.

This is local surface PCA, not learned 3D Gaussian reconstruction.  Each point
keeps its measured position/color and receives two tangent covariance axes.
"""
from pathlib import Path
import struct

import numpy as np
from scipy.spatial import cKDTree

source = Path('public/assets/3dImage-clean.lssnap')
target = Path('public/assets/3dImage-surfels.bin')
raw = source.read_bytes()
if raw[:4] != b'LSS\x01':
    raise ValueError('Unexpected scan format')
count = struct.unpack_from('<i', raw, 4)[0]
point_type = np.dtype([
    ('x', '<i2'), ('y', '<i2'), ('z', '<i2'),
    ('r', 'u1'), ('g', 'u1'), ('b', 'u1'),
])
points = np.frombuffer(raw, dtype=point_type, count=count, offset=16)
xyz = np.column_stack([points[k] for k in 'xyz']).astype(np.float32) / 1000

distances, indices = cKDTree(xyz).query(xyz, k=16, workers=-1)
offsets = xyz[indices[:, 1:]] - xyz[:, None, :]
offsets -= offsets.mean(axis=1, keepdims=True)
covariance = np.einsum('nki,nkj->nij', offsets, offsets) / offsets.shape[1]
eigenvalues, eigenvectors = np.linalg.eigh(covariance)
spacing = np.median(distances[:, 1:5], axis=1)

# PCA's smallest eigenvector is the local surface normal. The two larger
# eigenvectors lie in its tangent plane and give an ellipse that follows the
# scanned surface. Clamp noisy neighborhoods so sparse edges do not balloon.
major = np.clip(2.15 * np.sqrt(np.maximum(eigenvalues[:, 2], 0)),
                spacing * 0.9, spacing * 3.1)
minor = np.clip(2.15 * np.sqrt(np.maximum(eigenvalues[:, 1], 0)),
                spacing * 0.75, spacing * 3.1)
axis_major = eigenvectors[:, :, 2] * major[:, None]
axis_minor = eigenvectors[:, :, 1] * minor[:, None]
axes = np.concatenate([axis_major, axis_minor], axis=1)
packed = np.rint(axes * 10000).clip(-32768, 32767).astype('<i2')
target.write_bytes(struct.pack('<I', count) + packed.tobytes())
print(f'Wrote {count:,} anisotropic surfels to {target} ({target.stat().st_size / 1e6:.2f} MB)')
print('Median semiaxes (mm):', np.median(major) * 1000, np.median(minor) * 1000)
