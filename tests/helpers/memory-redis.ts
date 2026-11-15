import { EventEmitter } from 'node:events';
import type { IRedisDriver, IRedisPipeline } from '../../src/types.js';

interface MemoryRedisState {
  strings: Map<string, string>;
  hashes: Map<string, Record<string, string>>;
  sets: Map<string, Set<string>>;
  expires: Map<string, number>;
  clients: Set<MemoryRedis>;
}

/** Redis-shaped test fixture. Live integration tests separately verify the real wire/Lua behavior. */
export class MemoryRedis extends EventEmitter implements IRedisDriver {
  readonly state: MemoryRedisState;
  readonly commands: string[] = [];
  private readonly channels = new Set<string>();
  isOpen = true;

  constructor(state?: MemoryRedisState) {
    super();
    this.state = state ?? { strings: new Map(), hashes: new Map(), sets: new Map(), expires: new Map(), clients: new Set() };
    this.state.clients.add(this);
  }

  private purge(key: string): void {
    const expires = this.state.expires.get(key);
    if (expires !== undefined && expires <= Date.now()) {
      this.state.strings.delete(key);
      this.state.hashes.delete(key);
      this.state.sets.delete(key);
      this.state.expires.delete(key);
    }
  }

  private exists(key: string): boolean {
    this.purge(key);
    return this.state.strings.has(key) || this.state.hashes.has(key) || this.state.sets.has(key);
  }

  async get(key: string): Promise<string | null> {
    this.commands.push(`get ${key}`);
    this.purge(key);
    if (this.state.hashes.has(key) || this.state.sets.has(key)) throw new Error('WRONGTYPE');
    return this.state.strings.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: (string | number)[]): Promise<string | null> {
    this.commands.push(`set ${key}`);
    if (args.includes('NX') && this.exists(key)) return null;
    this.state.hashes.delete(key);
    this.state.sets.delete(key);
    this.state.strings.set(key, value);
    this.state.expires.delete(key);
    const ex = args.indexOf('EX');
    const px = args.indexOf('PX');
    if (ex >= 0) this.state.expires.set(key, Date.now() + Number(args[ex + 1]) * 1000);
    if (px >= 0) this.state.expires.set(key, Date.now() + Number(args[px + 1]));
    return 'OK';
  }

  async setex(key: string, seconds: number, value: string): Promise<string | null> {
    return this.set(key, value, 'EX', seconds);
  }

  async del(...keys: string[]): Promise<number> {
    this.commands.push(`del ${keys.join(' ')}`);
    let count = 0;
    for (const key of keys) {
      if (this.exists(key)) count++;
      this.state.strings.delete(key);
      this.state.hashes.delete(key);
      this.state.sets.delete(key);
      this.state.expires.delete(key);
    }
    return count;
  }

  async ping(): Promise<string> { return 'PONG'; }
  async expire(key: string, seconds: number): Promise<number> {
    this.commands.push(`expire ${key}`);
    if (!this.exists(key)) return 0;
    this.state.expires.set(key, Date.now() + seconds * 1000);
    return 1;
  }
  async pttl(key: string): Promise<number> {
    if (!this.exists(key)) return -2;
    const expiry = this.state.expires.get(key);
    return expiry === undefined ? -1 : Math.max(0, expiry - Date.now());
  }
  async incr(key: string): Promise<number> {
    this.commands.push(`incr ${key}`);
    this.purge(key);
    const value = Number(this.state.strings.get(key) ?? '0') + 1;
    this.state.strings.set(key, String(value));
    return value;
  }
  async hset(key: string, values: Record<string, string>): Promise<number> {
    if (this.state.strings.has(key)) throw new Error('WRONGTYPE');
    this.state.hashes.set(key, { ...this.state.hashes.get(key), ...values });
    return Object.keys(values).length;
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    this.purge(key);
    if (this.state.strings.has(key)) throw new Error('WRONGTYPE');
    return { ...this.state.hashes.get(key) };
  }
  async sadd(key: string, ...members: string[]): Promise<number> {
    this.purge(key);
    const set = this.state.sets.get(key) ?? new Set<string>();
    const before = set.size;
    for (const member of members) set.add(member);
    this.state.sets.set(key, set);
    return set.size - before;
  }
  async smembers(key: string): Promise<string[]> {
    this.purge(key);
    return [...this.state.sets.get(key) ?? []];
  }
  async scan(_cursor: string, ...args: (string | number)[]): Promise<[string, string[]]> {
    const pattern = String(args[args.indexOf('MATCH') + 1] ?? '*');
    const expression = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    const keys = new Set([...this.state.strings.keys(), ...this.state.hashes.keys(), ...this.state.sets.keys()]);
    return ['0', [...keys].filter(key => this.exists(key) && expression.test(key))];
  }
  async eval(script: string, _numkeys: number, ...args: (string | number)[]): Promise<unknown> {
    this.commands.push('eval');
    const key = String(args[0]);
    if (script.includes("redis.call('PEXPIRE'")) {
      this.purge(key);
      const hash = this.state.hashes.get(key);
      if (hash) {
        if (hash.t !== String(args[1])) return 0;
        hash.e = String(args[2]);
      } else if (!this.state.strings.has(key)) return 0;
      this.state.expires.set(key, Date.now() + Number(args[3]));
      return 1;
    }
    if (script.includes("redis.call('TYPE'")) {
      this.purge(key);
      if (this.state.hashes.has(key)) return ['hash', Object.entries(this.state.hashes.get(key)!).flat(), await this.pttl(key)];
      if (this.state.strings.has(key)) return ['string', this.state.strings.get(key), await this.pttl(key)];
      return ['none', false, -2];
    }
    if (script.includes('local floor =') || script.includes('math.max(current + 1')) {
      const current = Number(await this.get(key) ?? '0');
      const value = Math.max(current + (script.includes('current + 1') ? 1 : 0), Number(args[1]));
      await this.set(key, String(value));
      return value;
    }
    if (script.includes('HGET')) {
      const hash = await this.hgetall(key);
      return hash.t === String(args[1]) ? this.del(key) : 0;
    }
    if (script.includes('INCR')) {
      const value = await this.incr(key);
      if (value === 1 && args[1] !== undefined) await this.expire(key, Number(args[1]));
      return value;
    }
    if (script.includes('redis.call("get"') || script.includes("redis.call('GET'")) {
      return await this.get(key) === String(args[1]) ? this.del(key) : 0;
    }
    throw new Error('Unsupported fixture Lua script; verify it against live Redis');
  }
  multi(): IRedisPipeline & { pttl(key: string): IRedisPipeline } {
    const operations: Array<() => Promise<unknown>> = [];
    const pipe: IRedisPipeline & { pttl(key: string): IRedisPipeline } = {
      get: (key: string) => { operations.push(() => this.get(key)); return pipe; },
      set: (key: string, value: string, ...args: (string | number)[]) => { operations.push(() => this.set(key, value, ...args)); return pipe; },
      setex: (key: string, seconds: number, value: string) => { operations.push(() => this.setex(key, seconds, value)); return pipe; },
      del: (...keys: string[]) => { operations.push(() => this.del(...keys)); return pipe; },
      expire: (key: string, seconds: number) => { operations.push(() => this.expire(key, seconds)); return pipe; },
      incr: (key: string) => { operations.push(() => this.incr(key)); return pipe; },
      sadd: (key: string, ...members: string[]) => { operations.push(() => this.sadd(key, ...members)); return pipe; },
      smembers: (key: string) => { operations.push(() => this.smembers(key)); return pipe; },
      hset: (key: string, value: Record<string, string>) => { operations.push(() => this.hset(key, value)); return pipe; },
      hgetall: (key: string) => { operations.push(() => this.hgetall(key)); return pipe; },
      pttl: (key: string) => { operations.push(() => this.pttl(key)); return pipe; },
      eval: (script: string, numkeys: number, ...args: (string | number)[]) => { operations.push(() => this.eval(script, numkeys, ...args)); return pipe; },
      exec: () => Promise.all(operations.map(operation => operation().then(value => [null, value] as [null, unknown], error => [error as Error, null] as [Error, null]))),
    };
    return pipe;
  }
  pipeline(): IRedisPipeline { return this.multi(); }
  async publish(channel: string, message: string): Promise<number> {
    this.commands.push(`publish ${channel}`);
    let count = 0;
    for (const client of this.state.clients) {
      if (client.channels.has(channel)) { client.emit('message', channel, message); count++; }
    }
    return count;
  }
  async subscribe(...channels: string[]): Promise<void> { for (const channel of channels) this.channels.add(channel); }
  duplicate(): MemoryRedis { return new MemoryRedis(this.state); }
  disconnect(): void { this.isOpen = false; this.channels.clear(); this.state.clients.delete(this); }
}
