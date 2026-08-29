/**
 * Narrowing a value a test knows is there.
 */

/**
 * `value`, with `null` and `undefined` taken off its type.
 *
 * A test reaching into a `Map`, a `find` or an optional field holds a value the
 * fixture it just built guarantees. `value!` states that to the type checker and
 * says nothing at runtime: the miss surfaces as `Cannot read properties of
 * undefined` on whatever line reads through it, naming neither the lookup nor
 * the fixture. This throws on the lookup itself, naming `what`.
 *
 * @param what The thing looked up, as the failure should name it.
 */
export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${what} is ${String(value)}`);
  }
  return value;
}
