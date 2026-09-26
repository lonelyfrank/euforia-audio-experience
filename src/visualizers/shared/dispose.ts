import type { Material, Object3D } from 'three';

/** Disposes every geometry, material and texture reachable from `root`. */
export function disposeObject(root: Object3D): void {
  root.traverse((object) => {
    const mesh = object as Partial<{ geometry: { dispose(): void }; material: Material | Material[] }>;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value && typeof value === 'object' && 'isTexture' in value) (value as { dispose(): void }).dispose();
      }
      material.dispose();
    }
  });
}
