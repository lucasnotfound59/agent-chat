import { execFile } from 'node:child_process';

/** The address that hands the browser its token; the fragment never reaches the server or its logs. */
export function webUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/#token=${encodeURIComponent(token)}`;
}

type Run = (cmd: string, args: string[]) => void;

const defaultRun: Run = (cmd, args) => {
  execFile(cmd, args, (err) => {
    if (err) console.error(`[web] 无法自动打开浏览器：${err.message}`);
  });
};

/** Opens `url` in the default browser unless AGENTCHAT_NO_OPEN=1. Returns whether it tried. */
export function openBrowser(url: string, env: NodeJS.ProcessEnv, run: Run = defaultRun): boolean {
  if (env.AGENTCHAT_NO_OPEN === '1') return false;
  run('open', [url]);
  return true;
}
