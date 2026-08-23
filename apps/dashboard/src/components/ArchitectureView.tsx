/**
 * Architecture — two slides, for showing an audience what sits behind the demo.
 *
 * SVG COMPONENTS RATHER THAN EXPORTED IMAGES, deliberately. The architecture has
 * changed four times this month; an exported PNG is a second copy of the topology
 * that goes stale silently, which is #84's whole subject. Drawn from tokens, so a
 * brand change moves the diagram with the rest of the UI.
 *
 * DELIBERATELY SPARSE. Ports, service names and tool names live in the deployment
 * configuration and the tool contracts. Anything restated here is a copy that can
 * disagree with them, so the diagram carries structure and nothing operational.
 *
 * CLIENT-FACING. These slides are shown to customers, so they carry no milestone
 * numbers, no internal service counts and no repository paths — an audience does not
 * care which release added which capability, and a slide that talks about our
 * delivery plan is talking about the wrong thing. What it does carry is the four
 * claims a customer actually needs to believe:
 *
 *   1. metrics and configuration leave the instance; message content never does
 *   2. every action the agent takes is authorization-checked and audited
 *   3. a person approves before anything is applied
 *   4. the one change it may make is bounded and reversible
 *
 * ARROWS USE A ROUTING CHANNEL, and this is a layout invariant rather than taste. A
 * vertical run that needs to cross the diagram travels in the clear corridor between
 * the instance band and the middle column (x 196..248), never through a box. Before
 * this, `metrics` ran from the metrics endpoint straight up through BOTH the detection
 * engine and the findings box on its way to the proxy, and `finding + snapshot` cut
 * through the authorization policy — reported as "the arrows turn and hit boxes that
 * are not related". `tools/validate-architecture.mjs` now checks every path segment
 * against every node box and fails the build, so this cannot regress quietly.
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

/**
 * An arrow, optionally labelled.
 *
 * `lx`/`ly` are REQUIRED when `label` is passed, and the type enforces it rather than defaulting
 * to a corner. An SVG `<text>` with no `x`/`y` renders at the origin — so the first version of
 * this component drew all eight labels stacked on top of each other in the top-left of the
 * viewBox, which reads as a rendering fault rather than as a missing attribute. The types below
 * make that unrepresentable: a label without a position will not compile.
 *
 * Positions are given per call site rather than derived from `d`, because the midpoint of an
 * L-shaped path is usually the corner — the one place a label is guaranteed to sit on the line.
 */
type FlowProps = { d: string; dashed?: boolean } & (
  | { label: string; lx: number; ly: number }
  | { label?: undefined; lx?: undefined; ly?: undefined }
);

function Flow({ d, label, lx, ly, dashed = false }: FlowProps): JSX.Element {
  return (
    <g className={`pg-arch__flow${dashed ? ' pg-arch__flow--dashed' : ''}`}>
      <path d={d} markerEnd="url(#pg-arrow)" />
      {label !== undefined && (
        <text className="pg-arch__flow-label" x={lx} y={ly}>
          {label}
        </text>
      )}
    </g>
  );
}

function Overview(): JSX.Element {
  return (
    <svg className="pg-arch__svg" viewBox="0 0 640 360" role="img"
      aria-label="Production Guardian: an agent and its governed tools run inside the IRIS instance
        alongside the production; a metrics proxy and a detection engine watch it from outside; an
        external language model reasons over metrics and configuration only.">
      <defs>
        <marker id="pg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" />
        </marker>
      </defs>

      {/* Containment, because "the agent runs inside your instance" is the single most
          load-bearing fact on this slide and the one customers ask about first. */}
      <g className="pg-arch__group">
        <rect x="16" y="24" width="180" height="300" rx="8" />
        <text x="106" y="46">Your IRIS instance</text>
      </g>
      <Node x={32} y={60} w={148} title="Production" sub="your interfaces" tone="brand" />
      <Node x={32} y={124} w={148} title="AI agent" sub="reads through tools" tone="accent" />
      <Node x={32} y={188} w={148} title="Access control" sub="checked · audited" />
      <Node x={32} y={252} w={148} title="Metrics API" sub="built in to IRIS" />

      <Node x={256} y={60} w={136} title="Metrics collector" sub="polls, aggregates" />
      <Node x={256} y={150} w={136} h={64} title="Detection engine" sub="baseline · rules" tone="brand" />

      <Node x={452} y={60} w={104} h={44} title="Language model" sub="external" />
      <Node x={452} y={150} w={148} h={64} title="Dashboard" sub="what you see" tone="accent" />

      {/* THE ROUTING CHANNEL, x 196..248. Every vertical run that has to cross the diagram
          travels here. `metrics` previously went straight up from the metrics endpoint and
          passed through both the engine and the findings box; it now steps into the channel
          first. Checked by tools/validate-architecture.mjs. */}
      <Flow d="M180 278 H228 V86 H256" label="metrics" lx={186} ly={272} />
      <Flow d="M324 112 V150" />
      <Flow d="M392 182 H452" label="findings" lx={398} ly={176} />

      {/* Dashed: the engine reaches back into the instance only to ask for an explanation or
          to apply an approved change, and only through the governed tools. A solid line would
          imply a continuous data feed, which would be the wrong claim. */}
      <Flow d="M256 200 H212 V150 H180" label="ask · apply" lx={186} ly={144} dashed />

      {/* Dashed and short: the model reasons, it does not receive a feed. */}
      <Flow d="M392 86 H452" label="reason" lx={398} ly={80} dashed />

      <text className="pg-arch__note" x="452" y="248">Metrics and configuration</text>
      <text className="pg-arch__note" x="452" y="264">leave the instance.</text>
      <text className="pg-arch__note" x="452" y="280">Message content never does.</text>
    </svg>
  );
}

function Investigation(): JSX.Element {
  return (
    <svg className="pg-arch__svg" viewBox="0 0 640 360" role="img"
      aria-label="One investigation: an operator asks, the agent reads evidence through
        authorization-checked tools, an external model reasons over it, and the operator approves
        before any change is applied.">
      <defs>
        <marker id="pg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" />
        </marker>
      </defs>

      <Node x={16} y={150} w={116} title="Operator" sub="asks why" tone="accent" />
      <Node x={168} y={150} w={116} title="Guardian" sub="orchestrates" />

      <g className="pg-arch__group">
        <rect x={332} y={24} width={196} height={300} rx="8" />
        <text x={430} y={46}>Your IRIS instance</text>
      </g>
      <Node x={348} y={60} w={164} title="AI agent" sub="gathers evidence" tone="brand" />
      <Node x={348} y={124} w={164} title="Authorization" sub="checked per call" />
      <Node x={348} y={188} w={164} title="Read tools" sub="metrics · config only" />
      <Node x={348} y={252} w={164} title="One change" sub="bounded · reversible" tone="accent" />

      <Node x={556} y={60} w={68} h={44} title="Model" sub="external" />
      <Node x={556} y={188} w={68} h={44} title="Audit" sub="every call" tone="brand" />

      <Flow d="M132 176 H168" />

      {/* THE CHANNEL on this slide is x 292..340. `finding + snapshot` used to run from the
          orchestrator up and through the authorization box; it now steps into the channel and
          arrives above it, which is also truer to the order things happen in. */}
      <Flow d="M284 176 H312 V86 H348" label="the question" lx={276} ly={70} />

      <Flow d="M512 82 H556" label="reason" lx={518} ly={76} dashed />
      <Flow d="M430 112 V124" />
      <Flow d="M430 176 V188" label="evidence" lx={436} ly={185} />
      <Flow d="M512 210 H556" />
      <Flow d="M430 240 V252" label="after approval" lx={436} ly={249} />

      <text className="pg-arch__note" x="16" y="240">Authorization is checked</text>
      <text className="pg-arch__note" x="16" y="256">before every call, and the</text>
      <text className="pg-arch__note" x="16" y="272">audit records it either way —</text>
      <text className="pg-arch__note" x="16" y="288">including a refusal.</text>
      <text className="pg-arch__note" x="16" y="312">Nothing applies without you.</text>
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
          ? 'The agent, its tools, its access control and its audit trail all run inside your own IRIS instance, alongside the production they watch. Only measurements and configuration are ever sent outside it — never the content of a message.'
          : 'Authorization is checked before execution and the audit records it either way, so a refused attempt is as visible as an applied one. Guardian can recommend, but a person decides.'}
      </p>
    </section>
  );
}
