import { useEffect, useMemo, useRef, useState } from 'react';
import { api, toApiError } from '../api';
import { useNavigate, type NavParams, type PageId } from '../App';
import type { AssistantAnswer } from '../../../shared/types';
import { HELP_ARTICLES } from '../../../shared/help';
import { Icon } from './ui';

/** Opens the assistant (optionally asking a question) from anywhere in the app. */
export function openAssistant(question?: string): void {
  window.dispatchEvent(new CustomEvent('hormiga:ask', { detail: question ?? null }));
}

interface Message {
  from: 'me' | 'bot';
  text: string;
  answer?: AssistantAnswer;
}

const WELCOME: AssistantAnswer = {
  text: 'Hola. Pregúntame por tus gastos, ingresos, ahorro, saldo o próximos pagos, o cómo hacer algo en Hormiga. Respondo con tus datos sin enviarlos a ningún sitio.',
  facts: [],
  actions: [],
  suggestions: ['¿Cuánto gasté este mes?', '¿Cómo acabaré el mes?', '¿Qué pagos tengo esta semana?', '¿Cómo puedo ahorrar más?'],
};

/** «Pregunta a Hormiga»: floating button and chat panel. Answers are computed locally from your data. */
export function Assistant() {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<Message[]>([{ from: 'bot', text: WELCOME.text, answer: WELCOME }]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const end = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    setText('');
    setLog((l) => [...l, { from: 'me', text: q }]);
    setBusy(true);
    try {
      const answer = await api('assistant.ask', { question: q });
      setLog((l) => [...l, { from: 'bot', text: answer.text, answer }]);
    } catch (err) {
      setLog((l) => [...l, { from: 'bot', text: toApiError(err).message }]);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onAsk = (e: Event) => {
      setOpen(true);
      const q = (e as CustomEvent<string | null>).detail;
      if (q) void ask(q);
      setTimeout(() => input.current?.focus(), 50);
    };
    window.addEventListener('hormiga:ask', onAsk);
    return () => window.removeEventListener('hormiga:ask', onAsk);
  });
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [log, open]);

  if (!open) {
    return (
      <button className="ask-fab" onClick={() => { setOpen(true); setTimeout(() => input.current?.focus(), 50); }} aria-label="Pregunta a Hormiga">
        <Icon name="sparkle" size={16} /> Pregunta a Hormiga
      </button>
    );
  }
  return (
    <aside className="ask-panel" aria-label="Pregunta a Hormiga">
      <div className="ask-head">
        <strong>Pregunta a Hormiga</strong>
        <button className="btn sm ghost" aria-label="Cerrar" onClick={() => setOpen(false)}><Icon name="x" size={16} /></button>
      </div>
      <div className="ask-log" aria-live="polite">
        {log.map((m, i) => (
          <div key={i} className={`ask-msg ${m.from}`}>
            {m.text}
            {m.answer && m.answer.facts.length > 0 && (
              <div className="ask-facts">
                {m.answer.facts.map((f) => <div key={f.label}><span>{f.label}</span><span className="num">{f.value}</span></div>)}
              </div>
            )}
            {m.answer && (m.answer.actions.length > 0 || m.answer.suggestions.length > 0) && (
              <div className="ask-chips">
                {m.answer.actions.map((a) => (
                  <button key={a.label} className="chip" onClick={() => navigate(a.page as PageId, (a.params ?? {}) as NavParams)}>{a.label} →</button>
                ))}
                {m.answer.suggestions.map((s) => {
                  const article = HELP_ARTICLES.find((x) => x.title === s);
                  return (
                    <button key={s} className="chip" onClick={() => (article ? navigate('help', { section: article.id }) : void ask(s))}>{s}</button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="ask-msg bot muted">Calculando…</div>}
        <div ref={end} />
      </div>
      <form className="ask-form" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
        <input ref={input} id="ask-input" className="input" style={{ flex: 1 }} aria-label="Tu pregunta" placeholder="¿Cuánto gasté en restaurantes en mayo?" maxLength={300} value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn primary" disabled={busy || !text.trim()}>Preguntar</button>
      </form>
    </aside>
  );
}

/** Ctrl+K: jump to any page or ask the assistant. */
export function CommandPalette({ pages }: { pages: { id: PageId; label: string; icon: string }[] }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
        setQ('');
        setSel(0);
      } else if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const items = useMemo(() => {
    const n = q.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const match = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(n);
    const out: { key: string; label: string; icon: string; run: () => void }[] = [];
    for (const p of pages) if (!n || match(p.label)) out.push({ key: `p:${p.id}`, label: p.label, icon: p.icon, run: () => navigate(p.id) });
    if (n) for (const a of HELP_ARTICLES) if (match(a.title) || a.keywords.some(match)) out.push({ key: `h:${a.id}`, label: `Ayuda: ${a.title}`, icon: 'info', run: () => navigate('help', { section: a.id }) });
    if (q.trim().length >= 3) out.push({ key: 'ask', label: `Preguntar: «${q.trim()}»`, icon: 'sparkle', run: () => openAssistant(q.trim()) });
    return out.slice(0, 12);
  }, [q, pages, navigate]);
  if (!open) return null;
  const run = (i: number) => {
    const it = items[i];
    if (!it) return;
    setOpen(false);
    it.run();
  };
  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="palette" role="dialog" aria-label="Ir a o preguntar">
        <input
          autoFocus
          aria-label="Buscar página, ayuda o preguntar"
          placeholder="Ir a… o escribe una pregunta"
          value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            if (e.key === 'Enter') { e.preventDefault(); run(sel); }
          }}
        />
        <ul role="listbox">
          {items.map((it, i) => (
            <li key={it.key}><button role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => run(i)}><Icon name={it.icon} size={16} /> {it.label}</button></li>
          ))}
        </ul>
      </div>
    </div>
  );
}
