import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export interface TriageConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AppConfig {
  token: string;
  triage: TriageConfig | null;
  dsh: { provider: string; model: string } | null;
}

export class ConfigStore {
  private readonly file: string;
  private config: AppConfig;

  constructor(public readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'config.json');
    if (existsSync(this.file)) {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      const valid = typeof raw.token === 'string' && raw.token !== '';
      this.config = {
        token: valid ? raw.token : randomBytes(24).toString('hex'),
        triage: raw.triage ?? null,
        dsh: raw.dsh ?? null,
      };
      if (!valid) this.save();
    } else {
      this.config = { token: randomBytes(24).toString('hex'), triage: null, dsh: null };
      this.save();
    }
  }

  get(): AppConfig {
    return this.config;
  }

  update(patch: Partial<Omit<AppConfig, 'token'>>): AppConfig {
    this.config = { ...this.config, ...patch };
    this.save();
    return this.config;
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.config, null, 2), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }
}
