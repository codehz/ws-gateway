export default class MultiMap<Key, Value> {
  private data: Map<Key, Set<Value>> = new Map();

  has(key: Key, value?: Value) {
    if (value != undefined) {
      return this.data.get(key)?.has(value) ?? false;
    } else {
      return this.data.has(key);
    }
  }

  count(key: Key): number {
    return this.data.get(key)?.size ?? 0;
  }

  add(key: Key, value: Value) {
    let temp = this.data.get(key);
    if (temp == null) {
      temp = new Set();
      this.data.set(key, temp);
    } else if (temp.has(value)) {
      return false;
    }
    temp.add(value);
    return true;
  }

  delete(key: Key, value?: Value): boolean {
    if (value != undefined) {
      const temp = this.data.get(key);
      if (!temp) return false;
      const ret = temp.delete(value);
      if (temp.size === 0) this.data.delete(key);
      return ret;
    } else {
      return this.data.delete(key);
    }
  }

  keys() {
    return this.data.keys();
  }

  values() {
    return this.data.values();
  }

  entries() {
    return this.data.entries();
  }

  clear() {
    this.data.clear();
  }

  get(key: Key) {
    return this.data.get(key);
  }

  *[Symbol.iterator](): Iterator<[Key, Value], void> {
    for (const [key, set] of this.data) {
      for (const value of set) {
        yield [key, value];
      }
    }
  }
}
