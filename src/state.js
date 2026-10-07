export class TTLCache {
  constructor(limit = 1000, ttl = 3600000) { this.limit = limit; this.ttl = ttl; this.items = new Map(); }
  get(key) {
    const item = this.items.get(key);
    if (!item) return undefined;
    if (item.expires <= Date.now()) { this.items.delete(key); return undefined; }
    this.items.delete(key); this.items.set(key, item);
    return item.value;
  }
  set(key, value) {
    this.items.delete(key);
    this.items.set(key, { value, expires: Date.now() + this.ttl });
    while (this.items.size > this.limit) this.items.delete(this.items.keys().next().value);
  }
  delete(key) { this.items.delete(key); }
}

export class JobQueue {
  constructor(concurrency, capacity) {
    this.concurrency = concurrency; this.capacity = capacity; this.pending = []; this.active = new Set(); this.closed = false;
  }
  submit(owner, task) {
    if (this.closed || this.pending.length + this.active.size >= this.capacity) throw new Error('Очередь заполнена. Попробуйте чуть позже.');
    const controller = new AbortController();
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const job = { owner, task, controller, resolve, reject, promise };
    this.pending.push(job); this.pump();
    return promise;
  }
  pump() {
    while (this.active.size < this.concurrency && this.pending.length) {
      const job = this.pending.shift(); this.active.add(job);
      Promise.resolve().then(() => job.task(job.controller.signal)).then(job.resolve, job.reject).finally(() => { this.active.delete(job); this.pump(); });
    }
  }
  cancel(owner) {
    let count = 0;
    for (const job of [...this.pending]) if (job.owner === owner) {
      this.pending.splice(this.pending.indexOf(job), 1); job.controller.abort(); job.reject(new DOMException('Отменено', 'AbortError')); count++;
    }
    for (const job of this.active) if (job.owner === owner) { job.controller.abort(); count++; }
    return count;
  }
  async close() {
    this.closed = true;
    const jobs = [...this.pending, ...this.active];
    for (const owner of new Set(jobs.map(j => j.owner))) this.cancel(owner);
    await Promise.allSettled(jobs.map(j => j.promise));
  }
  get size() { return this.pending.length + this.active.size; }
}
