import { useRef } from "react";

/**
 * One pointer gesture, three outcomes — tap, long-press, or drag — distinguished
 * by movement and hold time. Lets a hand card keep tap-to-select and
 * hold-to-zoom while adding drag-to-inkwell / drag-to-play, all additively.
 *
 * - Hold still past `longPressMs` → `onLongPress` (drag/tap then suppressed).
 * - Move past `threshold` px before release → a drag (`onDragStart` → `onDragMove`* → `onDragEnd`).
 * - Quick release with no drag/long-press → `onTap`.
 */
export interface CardGestureOpts {
  onTap?: () => void;
  onLongPress?: () => void;
  onDragStart?: (x: number, y: number) => void;
  onDragMove?: (x: number, y: number) => void;
  onDragEnd?: (x: number, y: number) => void;
  longPressMs?: number;
  threshold?: number;
  enabled?: boolean;
}

export function useCardGesture(opts: CardGestureOpts) {
  const s = useRef({ down: false, startX: 0, startY: 0, dragging: false, longFired: false, timer: null as ReturnType<typeof setTimeout> | null });
  const clearTimer = () => { if (s.current.timer) { clearTimeout(s.current.timer); s.current.timer = null; } };

  const onPointerDown = (e: React.PointerEvent) => {
    if (opts.enabled === false) return;
    const c = s.current;
    c.down = true; c.startX = e.clientX; c.startY = e.clientY; c.dragging = false; c.longFired = false;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    clearTimer();
    c.timer = setTimeout(() => {
      if (c.down && !c.dragging) { c.longFired = true; opts.onLongPress?.(); }
    }, opts.longPressMs ?? 450);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const c = s.current;
    if (!c.down) return;
    if (!c.dragging) {
      if (c.longFired) return;
      if (Math.hypot(e.clientX - c.startX, e.clientY - c.startY) <= (opts.threshold ?? 10)) return;
      c.dragging = true;
      clearTimer();
      opts.onDragStart?.(e.clientX, e.clientY);
    }
    e.preventDefault();
    opts.onDragMove?.(e.clientX, e.clientY);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const c = s.current;
    clearTimer();
    if (!c.down) return;
    c.down = false;
    if (c.dragging) { c.dragging = false; opts.onDragEnd?.(e.clientX, e.clientY); }
    else if (!c.longFired) opts.onTap?.();
  };

  const onPointerCancel = () => {
    clearTimer();
    s.current.down = false;
    s.current.dragging = false;
  };

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
