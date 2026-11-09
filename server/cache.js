// Teller die omhoog gaat zodra de lijst met zenders, films of series verandert (na verversen).
// Tussenresultaten die alleen van die lijst afhangen, kunnen zo veilig bewaard worden.
let version = 0;

export const itemsVersion = () => version;
export const itemsChanged = () => { version += 1; };

/** Onthoudt de uitkomst per sleutel tot de lijst verandert. */
export function memo(fn) {
  const store = new Map();
  return (key) => {
    const hit = store.get(key);
    if (hit && hit.version === version) return hit.value;
    const value = fn(key);
    store.set(key, { version, value });
    return value;
  };
}
