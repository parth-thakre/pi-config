export function createDeferredResultDelivery<T extends { id: string }>() {
  const pending = new Map<string, T>();
  return {
    defer(result: T): void {
      pending.set(result.id, result);
    },
    consume(ids: Iterable<string>): void {
      for (const id of ids) pending.delete(id);
    },
    drain(): T[] {
      const results = [...pending.values()];
      pending.clear();
      return results;
    },
    clear(): void {
      pending.clear();
    },
    size(): number {
      return pending.size;
    },
  };
}
