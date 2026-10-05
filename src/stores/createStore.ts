export interface Store<T> {
  get(): T;
  set(patch: Partial<T> | ((state: T) => Partial<T>)): void;
  subscribe(listener: (state: T, previous: T) => void): () => void;
}

/** Minimal observable store with shallow-merge updates. */
export function createStore<T extends object>(initial: T, onChange?: (state: T) => void): Store<T> {
  let state = initial;
  const listeners = new Set<(state: T, previous: T) => void>();
  return {
    get: () => state,
    set(patch) {
      const changes = typeof patch === 'function' ? patch(state) : patch;
      if (!(Object.keys(changes) as (keyof T)[]).some((key) => !Object.is(state[key], changes[key]))) return;
      const previous = state;
      state = { ...state, ...changes };
      onChange?.(state);
      for (const listener of listeners) listener(state, previous);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
