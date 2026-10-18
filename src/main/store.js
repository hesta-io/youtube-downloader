'use strict';

// Tiny file-based JSON store with atomic, debounced writes.

const fs = require('fs');
const path = require('path');

class JsonFile {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.timer = null;
    this.data = this.#load();
  }

  #load() {
    for (const f of [this.file, this.file + '.bak']) {
      try {
        const raw = fs.readFileSync(f, 'utf8');
        const parsed = JSON.parse(raw);
        return structuredClone(this.#merge(parsed));
      } catch {
        // missing or corrupt: try backup, then defaults
      }
    }
    return structuredClone(this.defaults);
  }

  #merge(parsed) {
    const d = this.defaults;
    if (d && typeof d === 'object' && !Array.isArray(d) && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...d, ...parsed };
    }
    return parsed ?? d;
  }

  save(delay = 400) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const dir = path.dirname(this.file);
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const fd = fs.openSync(tmp, 'w');
      fs.writeSync(fd, JSON.stringify(this.data, null, 2));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('store: failed to write', this.file, err);
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
}

module.exports = { JsonFile };
