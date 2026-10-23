// Short random ids. Mirrored truss-B copies reuse the truss-A id with MIRROR_SUFFIX appended.
export const MIRROR_SUFFIX = '~B';

export function uid(prefix = 'id') {
  return prefix + Math.random().toString(36).slice(2, 9);
}
