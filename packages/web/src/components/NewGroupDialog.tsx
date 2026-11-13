import { useState, type FormEvent } from 'react';
import type { MemberView } from '../types';

interface Props {
  agents: MemberView[];
  onCreate(title: string, memberIds: string[]): Promise<void>;
  onClose(): void;
}

export function NewGroupDialog({ agents, onCreate, onClose }: Props) {
  const [title, setTitle] = useState('');
  const [ids, setIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) => setIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return setError('请填写群名');
    if (ids.length === 0) return setError('至少选一个 agent');
    setBusy(true);
    setError(null);
    try {
      await onCreate(title.trim(), ids);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog" role="dialog" aria-label="新建群聊" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>新建群聊</h3>
        <label className="field">
          群名
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </label>
        <fieldset className="field">
          <legend>成员</legend>
          {agents.map((a) => (
            <label key={a.id} className="check">
              <input type="checkbox" checked={ids.includes(a.id)} onChange={() => toggle(a.id)} />
              {a.name}
              {a.availability && !a.availability.ok ? `（${a.availability.reason ?? '不可用'}）` : ''}
            </label>
          ))}
        </fieldset>
        {error && (
          <div role="alert" className="dialog-error">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary" disabled={busy}>
            创建
          </button>
        </div>
      </form>
    </div>
  );
}
