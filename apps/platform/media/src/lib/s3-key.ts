/**
 * Derives S3 object keys for media files and variants.
 */

export function derivePublicKey(uploadId: string, uuid: string, ext: string): string {
  return `${uploadId}/${uuid}.${ext}`;
}

export function derivePrivateKey(locationId: string, uploadId: string, uuid: string, ext: string): string {
  return `${locationId}/${uploadId}/${uuid}.${ext}`;
}

/**
 * Inserts '-{variantName}' before the extension and changes ext to 'webp'.
 * e.g. 'abc/def.png' → 'abc/def-medium.webp'
 */
export function deriveVariantKey(baseKey: string, variantName: string): string {
  const lastDot = baseKey.lastIndexOf('.');
  if (lastDot === -1) {
    return `${baseKey}-${variantName}.webp`;
  }
  return `${baseKey.substring(0, lastDot)}-${variantName}.webp`;
}
