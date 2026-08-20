/**
 * Two architecture slides, authored as components rather than exported images.
 *
 * WHY NOT A PNG. The architecture keeps changing — five services became four when the web gateway
 * went away (#78), and the governance seam appeared in MVP 2. An exported image is a copy that goes
 * stale with nothing to detect it, which is #84 with a binary in the value slot. A component at
 * least fails to compile when a name it references is removed.
 *
 * DELIBERATELY SPARSE, AND THIS IS THE PART TO PRESERVE. Ports, service names and tool names all
 * already have an authority: `docker-compose.yml`, root `CLAUDE.md` §5, and `contracts/mcp-tools.md`.
 * A diagram that restates them is a second copy, so these slides name the pieces and their direction
 * of flow and **stop there** — no port numbers, no tool signatures, no thresholds. Where a viewer
 * needs the specifics, the footnote says which file to open.
 *
 * That is a real constraint and not modesty: the previous version of this comment listed the ports,
 * and the ports were wrong within a week of #78.
 */

export type Slide = 1 | 2;

export interface ArchitectureViewProps {
  slide: Slide;
  onSlide: (slide: Slide) => void;
}

/** Slide 1 — the pieces and the direction of flow. */
function TopologySlide(): JSX.Element {
  return (
    <svg
      className="pg-diagram"
      viewBox="0 0 760 300"
      role="img"
      aria-label="Four containers. IRIS runs the LABDEMO production and AI Hub. The metrics proxy polls IRIS, the detection engine polls the proxy, and the dashboard reads the engine."
    >
      {/* IRIS, drawn containing AI Hub rather than beside it -- the agent and the tools run INSIDE
          the instance, and that is the whole reason no LLM key reaches the engine. A box-beside-box
          diagram would make that look like a service boundary it is not. */}
      <g className="pg-diagram__group">
        <rect x="16" y="40" width="200" height="220" rx="10" className="pg-diagram__box pg-diagram__box--iris" />
        <text x="116" y="66" className="pg-diagram__label">IRIS for Health</text>
        <text x="116" y="84" className="pg-diagram__sub">pg-iris</text>

        <rect x="36" y="100" width="160" height="52" rx="6" className="pg-diagram__inner" />
        <text x="116" y="121" className="pg-diagram__label pg-diagram__label--sm">LABDEMO production</text>
        <text x="116" y="138" className="pg-diagram__sub">3 application hosts</text>

        <rect x="36" y="168" width="160" height="72" rx="6" className="pg-diagram__inner" />
        <text x="116" y="189" className="pg-diagram__label pg-diagram__label--sm">AI Hub</text>
        <text x="116" y="206" className="pg-diagram__sub">agent + 6 MCP tools</text>
        <text x="116" y="223" className="pg-diagram__sub">RBAC + audit</text>
      </g>

      <g className="pg-diagram__group">
        <rect x="272" y="110" width="150" height="80" rx="10" className="pg-diagram__box" />
        <text x="347" y="142" className="pg-diagram__label">Metrics proxy</text>
        <text x="347" y="162" className="pg-diagram__sub">polls, normalises</text>
      </g>

      <g className="pg-diagram__group">
        <rect x="470" y="110" width="150" height="80" rx="10" className="pg-diagram__box" />
        <text x="545" y="136" className="pg-diagram__label">Detection engine</text>
        <text x="545" y="156" className="pg-diagram__sub">baseline, rules,</text>
        <text x="545" y="172" className="pg-diagram__sub">findings API</text>
      </g>

      <g className="pg-diagram__group">
        <rect x="656" y="110" width="90" height="80" rx="10" className="pg-diagram__box" />
        <text x="701" y="146" className="pg-diagram__label">Dashboard</text>
        <text x="701" y="164" className="pg-diagram__sub">browser</text>
      </g>

      {/* Arrows point the way the REQUEST travels, not the way data returns -- everything here is a
          poll, so the arrow head is on the thing being asked. */}
      <g className="pg-diagram__flow">
        <line x1="272" y1="150" x2="220" y2="150" markerEnd="url(#pg-arrow)" />
        <line x1="470" y1="150" x2="426" y2="150" markerEnd="url(#pg-arrow)" />
        <line x1="656" y1="150" x2="624" y2="150" markerEnd="url(#pg-arrow)" />
        {/* The one line that is not a poll: the engine asks IRIS to investigate and to apply. Drawn
            beneath and dashed so it reads as a different kind of edge. */}
        <path d="M 545 194 L 545 268 L 116 268" className="pg-diagram__flow--dashed" markerEnd="url(#pg-arrow)" />
        <text x="330" y="286" className="pg-diagram__sub">investigate · resolve (governed)</text>
      </g>

      <defs>
        <marker id="pg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 0 0 L 8 4 L 0 8 z" className="pg-diagram__arrowhead" />
        </marker>
      </defs>
    </svg>
  );
}

/** Slide 2 — what one investigation actually does. */
function InvestigationSlide(): JSX.Element {
  return (
    <svg
      className="pg-diagram"
      viewBox="0 0 760 340"
      role="img"
      aria-label="An investigation: the engine posts a finding to IRIS, the agent calls read tools through an authorization policy that writes an audit row per call, the LLM is called with metrics and configuration only, and a write requires human approval."
    >
      <g className="pg-diagram__group">
        <rect x="16" y="24" width="150" height="64" rx="10" className="pg-diagram__box" />
        <text x="91" y="50" className="pg-diagram__label">Engine</text>
        <text x="91" y="68" className="pg-diagram__sub">POST /investigate</text>
      </g>

      <g className="pg-diagram__group">
        <rect x="216" y="24" width="160" height="64" rx="10" className="pg-diagram__box pg-diagram__box--iris" />
        <text x="296" y="50" className="pg-diagram__label">Agent, in IRIS</text>
        <text x="296" y="68" className="pg-diagram__sub">holds the model config</text>
      </g>

      {/* The policy sits BETWEEN the agent and the tools, because that is where it actually is:
          every tool call goes through it, and it is what makes the audit row unavoidable rather
          than remembered. Drawn as a gate rather than a box for that reason. */}
      <g className="pg-diagram__group">
        <rect x="216" y="122" width="160" height="58" rx="10" className="pg-diagram__box pg-diagram__box--gate" />
        <text x="296" y="146" className="pg-diagram__label pg-diagram__label--sm">Authorization policy</text>
        <text x="296" y="164" className="pg-diagram__sub">one audit row per call</text>
      </g>

      <g className="pg-diagram__group">
        <rect x="216" y="214" width="160" height="58" rx="10" className="pg-diagram__inner" />
        <text x="296" y="238" className="pg-diagram__label pg-diagram__label--sm">5 read tools</text>
        <text x="296" y="256" className="pg-diagram__sub">status, pool, queue, timing, errors</text>
      </g>

      <g className="pg-diagram__group">
        <rect x="440" y="214" width="160" height="58" rx="10" className="pg-diagram__box pg-diagram__box--write" />
        <text x="520" y="238" className="pg-diagram__label pg-diagram__label--sm">1 write tool</text>
        <text x="520" y="256" className="pg-diagram__sub">needs a second role</text>
      </g>

      <g className="pg-diagram__group">
        <rect x="470" y="24" width="150" height="64" rx="10" className="pg-diagram__box pg-diagram__box--external" />
        <text x="545" y="44" className="pg-diagram__label">LLM</text>
        <text x="545" y="62" className="pg-diagram__sub">external</text>
        <text x="545" y="79" className="pg-diagram__sub">metrics + config only</text>
      </g>

      <g className="pg-diagram__group">
        <rect x="656" y="214" width="90" height="58" rx="10" className="pg-diagram__box" />
        <text x="701" y="240" className="pg-diagram__label pg-diagram__label--sm">Human</text>
        <text x="701" y="258" className="pg-diagram__sub">approves</text>
      </g>

      <g className="pg-diagram__flow">
        <line x1="166" y1="56" x2="212" y2="56" markerEnd="url(#pg-arrow2)" />
        <line x1="376" y1="56" x2="466" y2="56" markerEnd="url(#pg-arrow2)" />
        <line x1="296" y1="88" x2="296" y2="118" markerEnd="url(#pg-arrow2)" />
        <line x1="296" y1="180" x2="296" y2="210" markerEnd="url(#pg-arrow2)" />
        <path d="M 376 151 L 520 151 L 520 210" className="pg-diagram__flow--dashed" markerEnd="url(#pg-arrow2)" />
        <line x1="656" y1="243" x2="604" y2="243" markerEnd="url(#pg-arrow2)" />
      </g>

      <text x="380" y="308" className="pg-diagram__sub pg-diagram__sub--note">
        Never message content. Never PHI. The write is refused without the second role, and the
        refusal is audited too.
      </text>

      <defs>
        <marker id="pg-arrow2" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 0 0 L 8 4 L 0 8 z" className="pg-diagram__arrowhead" />
        </marker>
      </defs>
    </svg>
  );
}

const CAPTIONS: Record<Slide, { title: string; question: string; authority: string }> = {
  1: {
    title: 'How the pieces fit',
    question: 'What runs where, and which way does data flow?',
    /* Points at the file rather than repeating its contents. The ports and the service names live in
       compose, and a diagram that restated them would be the copy that goes stale. */
    authority: 'Ports and service names: docker-compose.yml and root CLAUDE.md §5',
  },
  2: {
    title: 'How one investigation works',
    question: 'What does the agent actually do, and what stops it acting alone?',
    authority: 'Tool signatures and the audit shape: contracts/mcp-tools.md and iris/CLAUDE.md §7',
  },
};

export function ArchitectureView({ slide, onSlide }: ArchitectureViewProps): JSX.Element {
  const caption = CAPTIONS[slide];

  return (
    <section className="pg-view" aria-labelledby="pg-arch-title">
      <h2 id="pg-arch-title" className="pg-view__title">
        Architecture — {caption.title}
      </h2>
      <p className="pg-view__question">{caption.question}</p>

      {slide === 1 ? <TopologySlide /> : <InvestigationSlide />}

      {/* Real buttons, unlike the inert nav rail spans -- these do something, so they are focusable
          and keyboard-operable. `aria-current` rather than `aria-pressed`: this is a selection among
          slides, not a toggle. */}
      <div className="pg-slides" role="group" aria-label="Architecture slides">
        {([1, 2] as const).map((n) => (
          <button
            key={n}
            type="button"
            className={`pg-button${n === slide ? ' pg-button--primary' : ''}`}
            aria-current={n === slide ? 'true' : undefined}
            onClick={() => onSlide(n)}
          >
            Slide {n} — {n === 1 ? 'general' : 'detailed'}
          </button>
        ))}
      </div>

      <p className="pg-view__authority">{caption.authority}</p>
    </section>
  );
}
