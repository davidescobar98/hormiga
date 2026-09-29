/** Exact origin match ("app://hormiga/…"), so look-alikes such as "app://hormiga.evil/" are rejected. */
export function isUrlFromOrigin(url: string, origin: string): boolean {
  return url.startsWith(`${origin}/`);
}
