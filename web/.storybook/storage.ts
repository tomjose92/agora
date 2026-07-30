class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
}

// A co-hosted Storybook shares an origin with Agora. Keep story resets and
// persisted UI stores inside the preview iframe instead of clearing real app
// credentials and preferences.
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: new MemoryStorage(),
});
