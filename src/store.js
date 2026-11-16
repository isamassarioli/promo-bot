// Persistência simples em JSON: promoções já vistas (dedupe), estado e estatísticas.
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { seen: {}, paused: false, stats: { captured: 0, sent: 0, duplicates: 0, filtered: 0 } };
    if (file && fs.existsSync(file)) {
      try {
        Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch {
        /* arquivo corrompido: começa do zero */
      }
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  hasSeen(key) {
    return key in this.data.seen;
  }

  markSeen(key) {
    this.data.seen[key] = Date.now();
    this.save();
  }

  prune(maxAgeHours) {
    const limit = Date.now() - maxAgeHours * 3600_000;
    for (const [k, ts] of Object.entries(this.data.seen)) if (ts < limit) delete this.data.seen[k];
    this.save();
  }

  bump(stat) {
    this.data.stats[stat] = (this.data.stats[stat] || 0) + 1;
    this.save();
  }

  get paused() {
    return this.data.paused;
  }
  set paused(v) {
    this.data.paused = v;
    this.save();
  }
}
