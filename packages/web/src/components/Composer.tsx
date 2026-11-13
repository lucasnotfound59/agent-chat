import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { applyMention, filterMembers, mentionQuery } from '../mentions';
import type { MemberView } from '../types';

interface Props {
  /** Members that can be @-mentioned here (empty: no completion). */
  candidates: MemberView[];
  onSend(body: string): Promise<void>;
  placeholder?: string;
}

export function Composer({ candidates, onSend, placeholder = '发消息，@ 提到成员' }: Props) {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);

  const q = mentionQuery(text, caret);
  const options = q && q.start !== dismissed ? filterMembers(candidates, q.query) : [];

  useEffect(() => setSelected(0), [q?.query]);
  useLayoutEffect(() => {
    if (pendingCaret.current !== null && ref.current) {
      ref.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      ref.current.focus();
      pendingCaret.current = null;
    }
  });

  const pick = (m: MemberView) => {
    if (!q) return;
    const r = applyMention(text, q.start, caret, m.name);
    setText(r.text);
    setCaret(r.caret);
    pendingCaret.current = r.caret;
  };

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(body);
      setText('');
      setCaret(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Safari fires compositionend before the Enter keydown, so isComposing is already false; keyCode 229 still marks it.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (options.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setSelected((selected + step + options.length) % options.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(options[Math.min(selected, options.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        setDismissed(q?.start ?? null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="composer">
      {options.length > 0 && (
        <ul className="mention-list" role="listbox">
          {options.map((m, i) => {
            const off = m.availability && !m.availability.ok;
            return (
              <li
                key={m.id}
                role="option"
                aria-selected={i === selected}
                className={`${i === selected ? 'selected' : ''}${off ? ' off' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(m);
                }}
              >
                @{m.name}
                {off ? `（${m.availability?.reason ?? '不可用'}）` : ''}
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <div className="composer-error" role="alert">
          发送失败：{error}
        </div>
      )}
      <div className="composer-row">
        <textarea
          ref={ref}
          aria-label="消息"
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setDismissed(null);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={onKeyDown}
        />
        <button className="send" aria-label="发送" disabled={sending || !text.trim()} onClick={() => void send()}>
          ↑
        </button>
      </div>
      <div className="composer-hint">Enter 发送 · Shift+Enter 换行</div>
    </div>
  );
}
