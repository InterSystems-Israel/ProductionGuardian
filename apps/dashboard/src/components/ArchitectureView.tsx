/**
 * Architecture — two slides, for showing an audience what sits behind the demo.
 *
 * SVG COMPONENTS RATHER THAN EXPORTED IMAGES, deliberately. The architecture has
 * changed four times this month; an exported PNG is a second copy of the topology
 * that goes stale silently, which is #84's whole subject. Drawn from tokens, so a
 * brand change moves the diagram with the rest of the UI.
 *
 * DELIBERATELY SPARSE. Ports, service names and tool names already live in
 * `docker-compose.yml`, root `CLAUDE.md` §5 and `contracts/mcp-tools.md`. Anything
 * restated here is a copy that can disagree with them, so the diagram carries
 * structure and the caption points at the authority.
 */

import { useState } from 'react';

type Slide = 'overview' | 'investigation';

const SLIDES: readonly { id: Slide; label: string }[] = [
  { id: 'overview', label: '1 · The pieces' },
  { id: 'investigation', label: '2 · One investigation' },
];

/** Box + label, sized in the 640×360 viewBox both slides share. */
function Node({
  x,
  y,
  w = 132,
  h = 52,
  title,
  sub,
  tone = 'plain',
}: {
  x: number;
  y: number;
  w?: number;
  h?: number;
  title: string;
  sub?: string;
  tone?: 'plain' | 'brand' | 'accent';
}): JSX.Element {
  return (
    <g className={`pg-arch__node pg-arch__node--${tone}`}>
      <rect x={x} y={y} width={w} height={h} rx="6" />
      <text x={x + w / 2} y={sub === undefined ? y + h / 2 + 4 : y + h / 2 - 3}>{title}</text>
      {sub !== undefined && (
        <text className="pg-arch__sub" x={x + w / 2} y={y + h / 2 + 13}>
          {sub}
        </text>
      )}
    </g>
  );
}

function Flow({ d, label, dashed = false }: { d: string; label?: string; dashed?: boolean }): JSX.Element {
  return (
    <g className={`pg-arch__flow${dashed ? ' pg-arch__flow--dashed' : ''}`}>
      <path d={d} markerEnd="url(#pg-arrow)" />
      {label !== undefined && <text className="pg-arch__flow-label">{label}</text>}
    </g>
  );
}

function Overview(): JSX.Element {
  return (
    <svg className="pg-arch__svg" viewBox="0 0 640 360" role="img"
      aria-label="Five services: IRIS with AI Hub, the metrics proxy, the detection engine, and the dashboard.">
      <defs>
        <marker id="pg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" />
        </marker>
      </defs>

      {/* The IRIS container holds both the production and AI Hub -- the single most
          load-bearing fact on this slide, so it is drawn as containment. */}
      <g className="pg-arch__group">
        <rect x="16" y="24" width="180" height="300" rx="8" />
        <text x="106" y="46">IRIS container</text>
      </g>
      <Node x={32} y={64} w={148} title="LABDEMO" sub="the production" tone="brand" />
      <Node x={32} y={132} w={148} title="AI Hub" sub="agent · 6 MCP tools" tone="accent" />
      <Node x={32} y={200} w={148} title="RBAC · audit" sub="policies, one write tool" />
      <Node x={32} y={264} w={148} title="/api/monitor" sub="built-in metrics" />

      <Node x={248} y={64} w={136} title="Metrics proxy" sub="polls, aggregates" />
      <Node x={248} y={160} w={136} title="Detection engine" sub="baseline · rules · agent" tone="brand" />
      <Node x={248} y={264} w={136} title="Findings API" sub="/api/*" />

      <Node x={452} y={160} w={148} h={60} title="Dashboard" sub="what the operator sees" tone="accent" />

      <Flow d="M180 290 H248 V100" label="metrics" />
      <Flow d="M316 116 V160" />
      <Flow d="M316 212 V264" />
      <Flow d="M384 190 H452" label="findings" />
      {/* Dashed: the engine reaches back into IRIS only for WHY and FIX, and only
          through the governed tool path. A solid line would imply a data feed. */}
      <Flow d="M248 186 H196 V158" label="investigate · resolve" dashed />

      <text className="pg-arch__note" x="452" y="248">Five compose services.</text>
      <text className="pg-arch__note" x="452" y="264">Ports and names live in</text>
      <text className="pg-arch__note" x="452" y="280">docker-compose.yml.</text>
    </svg>
  );
}

function Investigation(): JSX.Element {
  return (
    <svg className="pg-arch__svg" viewBox="0 0 640 360" role="img"
      aria-label="One investigation: the engine asks the agent, the agent reads evidence through governed tools, an external model reasons, and a human approves the one write.">
      <defs>
        <marker id="pg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" />
        </marker>
      </defs>

      <Node x={16} y={150} w={120} title="Operator" sub="clicks Investigate" tone="accent" />
      <Node x={168} y={150} w={120} title="Engine" sub="orchestrates" />

      <g className="pg-arch__group">
        <rect x={320} y={24} width={200} height={300} rx="8" />
        <text x={420} y={46}>IRIS · AI Hub</text>
      </g>
      <Node x={336} y={64} w={168} title="Agent" sub="goal, iteration cap" tone="brand" />
      <Node x={336} y={136} w={168} title="Authorization policy" sub="checked per call" />
      <Node x={336} y={200} w={168} title="Read tools ×5" sub="metrics · config only" />
      <Node x={336} y={264} w={168} title="set_pool_size" sub="the one write" tone="accent" />

      <Node x={552} y={64} w={72} h={44} title="LLM" sub="external" />
      <Node x={552} y={200} w={72} h={44} title="Audit" sub="every call" tone="brand" />

      <Flow d="M136 176 H168" />
      <Flow d="M288 176 H336 V108" label="finding + snapshot" />
      <Flow d="M504 86 H552" label="reason" dashed />
      <Flow d="M420 116 V136" />
      <Flow d="M420 188 V200" label="evidence" />
      <Flow d="M504 222 H552" />
      <Flow d="M420 252 V264" label="after approval" />

      <text className="pg-arch__note" x="16" y="240">The policy is asked before every</text>
      <text className="pg-arch__note" x="16" y="256">call, and the audit row is written</text>
      <text className="pg-arch__note" x="16" y="272">whether the call ran or was refused.</text>
      <text className="pg-arch__note" x="16" y="296">No message content leaves the</text>
      <text className="pg-arch__note" x="16" y="312">instance — metrics and config only.</text>
    </svg>
  );
}

export function ArchitectureView(): JSX.Element {
  const [slide, setSlide] = useState<Slide>('overview');

  return (
    <section className="pg-view" aria-labelledby="pg-arch-heading">
      <div className="pg-view__head">
        <h2 id="pg-arch-heading" className="pg-view__title">
          Architecture
        </h2>
        <div className="pg-toggle" role="group" aria-label="Architecture slide">
          {SLIDES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`pg-toggle__option${slide === s.id ? ' pg-toggle__option--active' : ''}`}
              onClick={() => setSlide(s.id)}
              aria-pressed={slide === s.id}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="pg-arch">{slide === 'overview' ? <Overview /> : <Investigation />}</div>

      <p className="pg-view__caption">
        {slide === 'overview'
          ? 'MVP 1 detects. MVP 2 adds WHAT, WHY and FIX on one scenario — the agent, its tools, its RBAC and its audit all run inside the same IRIS instance as the production.'
          : 'Authorization is checked before execution and the audit row is written either way, so a refused attempt is as visible as an applied one.'}
      </p>
    </section>
  );
}
