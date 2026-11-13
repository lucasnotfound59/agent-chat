const COLORS = ['#af52de', '#34c759', '#32ade6', '#ff9500', '#5856d6', '#ff2d55', '#a2845e'];

export function colorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return COLORS[h % COLORS.length];
}

export function Avatar({ name, dot }: { name: string; dot?: 'on' | 'off' }) {
  return (
    <span className="avatar" style={{ background: colorFor(name) }} aria-hidden="true">
      {[...name][0] ?? '?'}
      {dot && <i className={`dot dot-${dot}`} />}
    </span>
  );
}
