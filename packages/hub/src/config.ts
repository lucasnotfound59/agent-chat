import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AppConfig {
  /** Adapter name, 'off', or null for automatic. */
  triageAgent: string | null;
  dsh: { provider: string; model: string } | null;
}

export class ConfigStore {
  private readonly file: string;
  private config: AppConfig;

  private legacyToken: string | null = null;
  /** Old keys (token, triage) kept on disk until commitLegacyMigration(). */
  private legacyKeys: Record<string, unknown> | null = null;

  constructor(public readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'config.json');
    if (existsSync(this.file)) {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      const keys: Record<string, unknown> = {};
      for (const k of ['token', 'triage']) if (k in raw) keys[k] = raw[k];
      if (Object.keys(keys).length > 0) this.legacyKeys = keys;
      if (typeof raw.token === 'string' && raw.token !== '') this.legacyToken = raw.token;
      this.config = { triageAgent: typeof raw.triageAgent === 'string' ? raw.triageAgent : null, dsh: raw.dsh ?? null };
    } else {
      this.config = { triageAgent: null, dsh: null };
      this.save();
    }
  }

  /** Hands over a token found in an old config file, once. Does not touch the file. */
  takeLegacyToken(): string | null {
    const t = this.legacyToken;
    this.legacyToken = null;
    return t;
  }

  /** Rewrites the file without the legacy keys; call only after the token is safely stored. */
  commitLegacyMigration(): void {
    if (!this.legacyKeys) return;
    this.legacyKeys = null;
    this.save();
  }

  get(): AppConfig {
    return this.config;
  }

  update(patch: Partial<AppConfig>): AppConfig {
    this.config = { ...this.config, ...patch };
    this.save();
    return this.config;
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify({ ...this.config, ...this.legacyKeys }, null, 2), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }
}
