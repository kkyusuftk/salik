// Generic JSON-shape utilities shared by every module that has to peek inside
// an untyped JSON value. Kept apart from any domain module so nothing has to
// depend on pricing/config code just to parse or probe a payload.

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A finite number or the fallback — never NaN/Infinity leaking in from wire data. */
export function numberOr(x: unknown, fallback: number): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : fallback;
}
