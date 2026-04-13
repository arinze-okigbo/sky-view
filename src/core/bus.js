const listeners = new Map();

export function on(eventName, handler) {
  if (!listeners.has(eventName)) {
    listeners.set(eventName, new Set());
  }

  listeners.get(eventName).add(handler);

  return () => {
    listeners.get(eventName)?.delete(handler);
  };
}

export function emit(eventName, detail = {}) {
  const handlers = listeners.get(eventName);
  if (!handlers?.size) return;

  for (const handler of handlers) {
    try {
      handler(detail);
    } catch (error) {
      console.error(`[SkyView:bus] handler failed for "${eventName}"`, error);
    }
  }
}
