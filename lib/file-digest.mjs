import fs from 'node:fs';
import crypto from 'node:crypto';

const digests = new Map();

// Cache content digests, never image buffers. Replacement and in-place edits
// both invalidate the entry, including writes which preserve file length.
export function fileDigest(file) {
  const {dev, ino, size, mtimeNs, ctimeNs} = fs.statSync(file, {bigint: true});
  const stamp = `${dev}:${ino}:${size}:${mtimeNs}:${ctimeNs}`;
  const old = digests.get(file);
  if (old?.stamp === stamp) return old.digest;
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  digests.set(file, {stamp, digest});
  if (digests.size > 4096) digests.delete(digests.keys().next().value);
  return digest;
}
