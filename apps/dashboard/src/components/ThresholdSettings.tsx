/**
 * Threshold settings — a right-hand drawer over the dashboard.
 *
 * A DRAWER RATHER THAN A VIEW, unlike Brochure and Architecture. Those replace the dashboard
 * because they are documents about the product; this is a control over the thing on screen, and an
 * operator changing what fires wants to see the findings list change behind it. Reusing
 * `.pg-drawer` also means Esc, the focus return and the animation come from the existing rule
 * rather than being re-implemented (`FindingDetail.tsx` is the prior art for both).
 *
 * ACCESSIBILITY (§7.3): every input has a real `<label>` tied by `id`, every control is a real
 * `<button>`, Esc closes and focus returns to the rail item that opened it, and the refusal is
 * announced through `role="status"` rather than by colour alone.
 *
 * THE FORM IS LOCAL AND THE SERVER IS AUTHORITATIVE. Inputs hold a draft string so a half-typed
 * number is not sent on every keystroke, and `Apply` sends it. Every reply replaces the draft with
 * the server's effective values, so what is shown is what is in force — the panel cannot claim a
 * value the engine did not accept.
 *
 * WHY A DRAFT STRING AND NOT A NUMBER. `<input type="number">` yields `''` mid-edit (clearing the
 * field, or typing `-` before a digit), and `Number('')` is 0 — which for a threshold is the one
 * value `validateConfig` singles out as making a rule fire on every sample. Holding the raw string
 * and refusing to send a non-numeric one keeps that from ever being submitted.
 */

import { useEffect, useMemo, useState } from 'react';
import type { SettingFieldView, ThresholdSettingsView } from '../types/settings';
import { IconClose, IconRestart, IconSettings } from './icons';

export interface ThresholdSettingsProps {
  /** Null when the drawer is closed — the component renders nothing. */
  open: boolean;
  settings: ThresholdSettingsView | null;
  loading: boolean;
  saving: boolean;
  /** Verbatim from the engine's validator. Rendered as-is (§2.4's spirit). */
  error: string | null;
  /** True in demo mode, which changes what the persistence notice can honestly claim. */
  demo: boolean;
  onApply: (values: Record<string, number>) => void;
  onReset: () => void;
  onClearError: () => void;
  onClose: () => void;
}

/** The draft, keyed by field key. Strings, per the file comment. */
type Draft = Record<string, string>;

function draftFrom(settings: ThresholdSettingsView | null): Draft {
  if (settings === null) return {};
  const out: Draft = {};
  for (const field of settings.fields) {
    const value = settings.effective[field.key];
    if (value !== undefined) out[field.key] = String(value);
  }
  return out;
}

export function ThresholdSettings({
  open,
  settings,
  loading,
  saving,
  error,
  demo,
  onApply,
  onReset,
  onClearError,
  onClose,
}: ThresholdSettingsProps): JSX.Element | null {
  const [draft, setDraft] = useState<Draft>({});

  /* Re-seed the draft whenever the server's values move -- on load, after an apply, after a reset.
     Keyed on the effective map's identity, which the hook replaces wholesale on every reply, so a
     successful write pulls the inputs back in line with what was actually accepted. */
  const effectiveKey = useMemo(
    () => (settings === null ? '' : JSON.stringify(settings.effective)),
    [settings],
  );
  useEffect(() => {
    setDraft(draftFrom(settings));
    // `effectiveKey` is the dependency that matters; `settings` is read for the values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveKey]);

  /* Esc closes from anywhere, bound to the document -- the same reasoning as `FindingDetail`: the
     operator's focus is often still on the rail item that opened this, which deliberately keeps
     focus for the return trip. */
  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  /** Which fields the operator has actually changed, as numbers. */
  const changed: Record<string, number> = {};
  if (settings !== null) {
    for (const field of settings.fields) {
      const raw = draft[field.key];
      if (raw === undefined || raw.trim() === '') continue;
      const value = Number(raw);
      // A non-numeric draft is not sent. The input's own `type="number"` catches most of it; this
      // catches the rest rather than submitting NaN and relying on the engine to name it.
      if (!Number.isFinite(value)) continue;
      if (value !== settings.effective[field.key]) changed[field.key] = value;
    }
  }
  const dirty = Object.keys(changed).length > 0;

  function onFieldChange(key: string, value: string): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
    // Clear a previous refusal as soon as the operator edits: the message named a value that is no
    // longer the one in the box, and a stale error next to a changed input reads as a live refusal.
    if (error !== null) onClearError();
  }

  return (
    <aside
      className="pg-drawer pg-drawer--settings"
      role="dialog"
      aria-modal="false"
      aria-labelledby="pg-settings-title"
    >
      <header className="pg-drawer__header">
        <div className="pg-drawer__heading">
          <h2 id="pg-settings-title" className="pg-drawer__title">
            <IconSettings size={16} />
            Detection thresholds
          </h2>
        </div>
        <button
          type="button"
          className="pg-button pg-button--icon"
          onClick={onClose}
          aria-label="Close threshold settings"
        >
          <IconClose size={15} />
        </button>
      </header>

      <div className="pg-drawer__body">
        {loading && <p className="pg-settings__status">Reading the engine's current thresholds…</p>}

        {!loading && settings === null && (
          /* The endpoint was unreachable or this engine predates it. Said plainly rather than shown
             as an error: the panel is optional and the connection banner owns real outages. */
          <p className="pg-settings__status">
            This engine reports no editable thresholds. They are still configurable in
            <code> services/detection-engine/thresholds.json</code>.
          </p>
        )}

        {settings !== null && settings.fields.length > 0 && (
          <>
            {/* THE BLAST RADIUS, STATED BEFORE THE INPUTS. These numbers decide what gets reported
                about a live production, and the persistence rule is the thing an operator is most
                likely to be surprised by later. The engine's own sentence is rendered rather than a
                local paraphrase, so there is one wording to keep true. */}
            <p
              className={`pg-settings__notice${
                demo ? ' pg-settings__notice--demo' : ' pg-settings__notice--live'
              }`}
            >
              <strong>{demo ? 'Demo mode.' : 'These change a live production.'}</strong>{' '}
              {settings.persistence}
            </p>

            {settings.overridden && !demo && (
              /* Distinct from the notice above, which is always true. This says the engine is
                 currently running values that are in no file -- the state a restart would silently
                 undo, so it is worth its own line rather than being inferred from the numbers. */
              <p className="pg-settings__notice pg-settings__notice--overridden" role="status">
                <strong>Currently overridden.</strong> The engine is running values that are not in
                <code> thresholds.json</code>. Reset restores the committed ones.
              </p>
            )}

            <div className="pg-settings__fields">
              {settings.fields.map((field) => (
                <Field
                  key={field.key}
                  field={field}
                  value={draft[field.key] ?? ''}
                  effective={settings.effective[field.key]}
                  file={settings.file[field.key]}
                  disabled={saving}
                  onChange={onFieldChange}
                />
              ))}
            </div>

            {/* ALWAYS MOUNTED so the live region announces a refusal that arrives later; hidden by
                `:empty` when there is nothing to say. The engine's own problem string is rendered
                verbatim -- it already names the field and the constraint. */}
            <p className="pg-settings__error" role="status">
              {error === null ? null : (
                <>
                  {/* A word, so a refusal is not signalled by colour alone (§7.3). */}
                  <span className="pg-settings__error-tag">Refused: </span>
                  {error}
                </>
              )}
            </p>

            <div className="pg-settings__actions">
              <button
                type="button"
                className="pg-button pg-button--primary"
                onClick={() => onApply(changed)}
                /* Disabled only for "nothing to send" and "a send is in flight", both of which are
                   states where the button genuinely cannot act and the reason is visible from the
                   inputs. A refusal does NOT disable it -- the operator's next move after being
                   told why is to try another value. */
                disabled={!dirty || saving}
              >
                {saving ? 'Applying…' : 'Apply'}
              </button>

              {/* NEVER DISABLED, deliberately -- the same rule `TriggerRail`'s Reset follows. It is
                  the operation that recovers from fiddling, so it must always work, including while
                  a refusal is on screen and including when nothing looks changed. */}
              <button
                type="button"
                className="pg-button"
                onClick={onReset}
                title="Restore the values committed in thresholds.json"
              >
                <IconRestart size={14} />
                Reset to shipped
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

interface FieldProps {
  field: SettingFieldView;
  value: string;
  effective: number | undefined;
  file: number | undefined;
  disabled: boolean;
  onChange: (key: string, value: string) => void;
}

/**
 * One labelled input with its help, its blast radius, and the two reference values.
 *
 * `aria-describedby` points at BOTH the help and the blast-radius text, so a screen reader gets the
 * consequence and not only the description — the consequence is the part that matters for a control
 * over a live production.
 */
function Field({ field, value, effective, file, disabled, onChange }: FieldProps): JSX.Element {
  // Derived from the key rather than an index: an id has to be stable across a re-order, and the
  // key is already unique per field.
  const id = `pg-setting-${field.key.replace(/\./g, '-')}`;
  const helpId = `${id}-help`;
  const radiusId = `${id}-radius`;
  const edited = effective !== undefined && value.trim() !== '' && Number(value) !== effective;

  return (
    <div className="pg-settings__field">
      <label className="pg-settings__label" htmlFor={id}>
        {field.label}
      </label>

      <input
        id={id}
        className={`pg-settings__input${edited ? ' pg-settings__input--edited' : ''}`}
        type="number"
        inputMode="decimal"
        min={field.min}
        max={field.max}
        step={field.step}
        value={value}
        disabled={disabled}
        aria-describedby={`${helpId} ${radiusId}`}
        onChange={(event) => onChange(field.key, event.target.value)}
      />

      <p id={helpId} className="pg-settings__help">
        {field.help}
      </p>
      <p id={radiusId} className="pg-settings__radius">
        {field.blastRadius}
      </p>

      {/* In force vs. committed, side by side, so "what a reset would do" needs no explanation.
          Monospaced and right-aligned like every other number in this app (§7.3). */}
      <dl className="pg-settings__refs">
        <div>
          <dt>In force</dt>
          <dd className="pg-settings__mono">{effective ?? '—'}</dd>
        </div>
        <div>
          <dt>In thresholds.json</dt>
          <dd className="pg-settings__mono">{file ?? '—'}</dd>
        </div>
      </dl>
    </div>
  );
}
