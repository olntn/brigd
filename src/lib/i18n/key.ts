/**
 * Marks Russian text kept in a constant; translate it with t() where it is rendered.
 * Dependency-free, so modules shared with the server can mark their labels too.
 */
export function tk<T extends string>(text: T): T {
  return text;
}
