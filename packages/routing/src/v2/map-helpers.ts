/** Returns a new Map with the entry set (added or updated). Never mutates the original. */
export function mapWith<K, V>(map: Map<K, V>, key: K, value: V): Map<K, V> {
  const next = new Map(map)
  next.set(key, value)
  return next
}

/** Returns a new Map without the entry. Never mutates the original. */
export function mapWithout<K, V>(map: Map<K, V>, key: K): Map<K, V> {
  if (!map.has(key)) return map
  const next = new Map(map)
  next.delete(key)
  return next
}

/** Get a value from a nested Map<K1, Map<K2, V>>. */
export function nestedMapGet<K1, K2, V>(
  map: Map<K1, Map<K2, V>>,
  outerKey: K1,
  innerKey: K2
): V | undefined {
  return map.get(outerKey)?.get(innerKey)
}

/** Set a value in a nested Map<K1, Map<K2, V>>. Returns new Maps. */
export function nestedMapSet<K1, K2, V>(
  map: Map<K1, Map<K2, V>>,
  outerKey: K1,
  innerKey: K2,
  value: V
): Map<K1, Map<K2, V>> {
  const next = new Map(map)
  const innerCopy = new Map(map.get(outerKey) ?? new Map<K2, V>())
  innerCopy.set(innerKey, value)
  next.set(outerKey, innerCopy)
  return next
}

/** Delete a value from a nested Map. Removes outer key if inner Map becomes empty. */
export function nestedMapDelete<K1, K2, V>(
  map: Map<K1, Map<K2, V>>,
  outerKey: K1,
  innerKey: K2
): Map<K1, Map<K2, V>> {
  const inner = map.get(outerKey)
  if (inner === undefined) return map
  if (!inner.has(innerKey)) return map
  const next = new Map(map)
  const innerCopy = new Map(inner)
  innerCopy.delete(innerKey)
  if (innerCopy.size === 0) {
    next.delete(outerKey)
  } else {
    next.set(outerKey, innerCopy)
  }
  return next
}

/** Remove an entire outer key from a nested Map. */
export function nestedMapDeleteOuter<K1, K2, V>(
  map: Map<K1, Map<K2, V>>,
  outerKey: K1
): Map<K1, Map<K2, V>> {
  if (!map.has(outerKey)) return map
  const next = new Map(map)
  next.delete(outerKey)
  return next
}
