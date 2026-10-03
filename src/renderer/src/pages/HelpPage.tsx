import { useEffect, useMemo, useState } from 'react';
import { useNavigate, type PageId } from '../App';
import { HELP_ARTICLES, type HelpArticle } from '../../../shared/help';
import { openAssistant } from '../components/Assistant';
import { Card } from '../components/ui';

const GROUPS: HelpArticle['group'][] = ['Empezar', 'Tu dinero', 'Ahorrar', 'Invertir', 'Cuenta y privacidad'];
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function HelpPage({ initialSection }: { initialSection?: string }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  useEffect(() => {
    if (initialSection) setTimeout(() => document.getElementById(`help-${initialSection}`)?.scrollIntoView({ block: 'start' }), 100);
  }, [initialSection]);
  const shown = useMemo(() => {
    const n = fold(q.trim());
    if (!n) return HELP_ARTICLES;
    return HELP_ARTICLES.filter((a) => fold([a.title, ...a.keywords, ...a.body].join(' ')).includes(n));
  }, [q]);
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Ayuda</h1>
          <p className="subtitle">Cómo sacarle partido a Hormiga. También puedes pulsar <span className="kbd">Ctrl</span> + <span className="kbd">K</span> desde cualquier sitio para ir a una pantalla o hacer una pregunta.</p>
        </div>
        <button className="btn primary" onClick={() => openAssistant()}>Pregunta a Hormiga</button>
      </div>
      <input className="input" aria-label="Buscar en la ayuda" placeholder="Buscar: Gmail, presupuesto, hipoteca, previsión…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 480 }} />
      {shown.length === 0 && (
        <Card><p>No hay artículos sobre «{q}». <button className="btn link" onClick={() => openAssistant(q)}>Pregúntaselo a Hormiga</button></p></Card>
      )}
      {GROUPS.map((g) => {
        const list = shown.filter((a) => a.group === g);
        if (!list.length) return null;
        return (
          <section key={g} aria-label={g}>
            <h2 className="section-title">{g}</h2>
            <div className="grid grid-2">
              {list.map((a) => (
                <article key={a.id} id={`help-${a.id}`} className={`card help-article ${initialSection === a.id ? 'highlight' : ''}`} aria-label={a.title}>
                  <h3 className="card-title">{a.title}</h3>
                  {a.body.map((p) => <p key={p} className="small">{p}</p>)}
                  {a.page && a.page !== 'help' && <button className="btn sm" onClick={() => navigate(a.page as PageId, a.section ? { section: a.section } : {})}>Ir allí</button>}
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
