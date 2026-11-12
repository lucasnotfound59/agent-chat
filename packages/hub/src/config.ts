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

  constructor(public readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'config.json');
    if (existsSync(this.file)) {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      const legacy = 'token' in raw;
      if (typeof raw.token === 'string' && raw.token !== '') this.legacyToken = raw.token;
      this.config = { triageAgent: typeof raw.triageAgent === 'string' ? raw.triageAgent : null, dsh: raw.dsh ?? null };
      if (legacy) this.save();
    } else {
      this.config = { triageAgent: null, dsh: null };
      this.save();
    }
  }

  /** Hands over a token found in an old config file, once. */
  takeLegacyToken(): string | null {
    const t = this.legacyToken;
    this.legacyToken = null;
    return t;
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
    writeFileSync(this.file, JSON.stringify(this.config, null, 2), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }
}
