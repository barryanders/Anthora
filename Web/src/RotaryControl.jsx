import React, { useRef, useState } from "react";

// Drag vertically, use the keyboard, or type a precise stepped value.
export default function RotaryControl({ label, value, min, max, step, onChange }) {
  const drag = useRef(null);
  const [draft, setDraft] = useState(null);
  const normalize = (next) => Math.min(max, Math.max(min, min + Math.round((next - min) / step) * step));
  const update = (next) => { if (Number.isFinite(next)) onChange(normalize(next)); };
  const commit = () => { if (draft?.trim()) update(Number(draft)); setDraft(null); };
  const angle = -135 + ((value - min) / (max - min)) * 270;
  return <div className="rotary-control">
    <span className="rotary-label">{label}</span>
    <div className="rotary-dial" role="slider" tabIndex={0}
      aria-label={label} aria-valuemin={min} aria-valuemax={max}
      aria-valuenow={value} aria-valuetext={`${value} pixels`} aria-orientation="vertical"
      title={`${label}: drag up or down, or use arrow keys`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault(); event.currentTarget.focus();
        drag.current = { y: event.clientY, value };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (drag.current) update(drag.current.value + Math.round((drag.current.y - event.clientY) / 8) * step);
      }}
      onPointerUp={(event) => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { drag.current = null; }}
      onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={(event) => {
        const keys = { ArrowUp: value + step, ArrowRight: value + step, ArrowDown: value - step,
          ArrowLeft: value - step, PageUp: value + step * 3, PageDown: value - step * 3, Home: min, End: max };
        if (event.key in keys) { event.preventDefault(); update(keys[event.key]); }
      }}>
      <span className="rotary-cap" style={{ transform: `rotate(${angle}deg)` }}><i /></span>
    </div>
    <label className="rotary-value"><input type="number" aria-label={`${label} in pixels`}
      min={min} max={max} step={step} value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") { commit(); event.currentTarget.blur(); }
        if (event.key === "Escape") { event.preventDefault(); setDraft(null); }
      }} /><span>px</span></label>
  </div>;
}
