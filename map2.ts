export default class Map2<Key1, Key2, Value> {
  private data: Map<Key1, Map<Key2, Value>> = new Map();

  has(key1: Key1, key2?: Key2, value?: Value) {
    if (key2 == null) {
      return this.data.has(key1);
    } else if (value == null) {
      const temp = this.data.get(key1);
      return temp?.has(key2) ?? false;
    } else {
      const temp = this.data.get(key1);
      return temp?.get(key2) == value ?? false;
    }
  }

  count(key1?: Key1) {
    if (key1 == null) {
      return this.data.size;
    } else {
      return this.data.get(key1)?.size ?? 0;
    }
  }

  set(key1: Key1, key2: Key2, value: Value): boolean {
    let temp = this.data.get(key1);
    if (temp == null) {
      temp = new Map();
      this.data.set(key1, temp);
    }
    if (temp.has(key2)) {
      return false;
    }
    temp.set(key2, value);
    return true;
  }

  delete(key1: Key1, key2?: Key2): boolean {
    if (key2 == null) {
      return this.data.delete(key1);
    }
    const temp = this.data.get(key1);
    if (temp == null) {
      return false;
    }
    const ret = temp.delete(key2);
    if (temp.size === 0) {
      this.data.delete(key1);
    }
    return ret;
  }

  keys(): Iterator<[Key1, Iterator<Key2>]>;
  keys(key: Key1): Iterator<Key2>;
  *keys(key?: Key1): any {
    if (key == null) {
      for (const [k1, m2] of this.data) {
        yield [k1, m2.keys()];
      }
    } else {
      const m2 = this.data.get(key);
      if (m2) yield* m2.keys();
    }
  }

  values() {
    return this.data.values();
  }

  entries() {
    return this.data.entries();
  }

  clear(key?: Key1) {
    if (key == null) {
      this.data.clear();
    } else {
      this.data.get(key)?.clear();
    }
  }

  get(key1: Key1): Map<Key2, Value> | undefined;
  get(key1: Key1, key2: Key2): Value | undefined;
  get(key1: Key1, key2?: Key2): any {
    if (key2 == null) return this.data.get(key1);
    return this.data.get(key1)?.get(key2);
  }

  *[Symbol.iterator](): Iterator<[Key1, Key2, Value], void> {
    for (const [key1, m2] of this.data) {
      for (const [key2, value] of m2) {
        yield [key1, key2, value];
      }
    }
  }
}
