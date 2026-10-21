// iOS-style "swipe from the left edge to go back" for the one-pane phone
// layout. The current pane follows the finger with the previous one showing
// underneath (CSS: .app[data-swiping]); letting go past a third of the screen,
// or with a quick flick, goes back. Otherwise it springs back.

import { useEffect, useRef } from 'react';

const EDGE = 28; // px from the left edge where the swipe must start
const SETTLE_MS = 180;

/** Row swipes ignore touches that start this close to the edge. */
export const EDGE_SWIPE_ZONE = EDGE + 4;

export function useEdgeSwipeBack(back: (() => void) | null, isNarrow: () => boolean) {
  const backRef = useRef(back);
  backRef.current = back;

  useEffect(() => {
    if (!('ontouchstart' in window)) return;
    const app = () => document.querySelector<HTMLElement>('.app');
    const currentPane = () => document.querySelector<HTMLElement>(
      '.app[data-pane="detail"] > .detail-pane, .app[data-pane="list"] > .list-pane',
    );

    let active = false;
    let decided = false;
    let startX = 0;
    let startY = 0;
    let startT = 0;
    let pane: HTMLElement | null = null;

    const reset = () => {
      if (pane) { pane.style.transition = ''; pane.style.transform = ''; }
      app()?.removeAttribute('data-swiping');
      pane = null;
    };

    const onStart = (e: TouchEvent) => {
      if (!backRef.current || !isNarrow() || e.touches.length !== 1) return;
      const t = e.touches[0];
      if (t.clientX > EDGE) return;
      active = true; decided = false;
      startX = t.clientX; startY = t.clientY; startT = Date.now();
    };

    const onMove = (e: TouchEvent) => {
      if (!active) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (!decided) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (Math.abs(dy) > Math.abs(dx) || dx < 0) { active = false; return; } // a scroll, not a swipe
        decided = true;
        pane = currentPane();
        app()?.setAttribute('data-swiping', '1');
      }
      e.preventDefault();
      if (pane) { pane.style.transition = 'none'; pane.style.transform = `translateX(${Math.max(0, dx)}px)`; }
    };

    const onEnd = (e: TouchEvent) => {
      if (!active) return;
      active = false;
      if (!decided) return;
      const dx = (e.changedTouches[0]?.clientX ?? startX) - startX;
      const speed = dx / Math.max(1, Date.now() - startT); // px per ms
      const goBack = dx > window.innerWidth / 3 || (speed > 0.5 && dx > 40);
      if (!pane) { reset(); if (goBack) backRef.current?.(); return; }
      pane.style.transition = `transform ${SETTLE_MS}ms ease-out`;
      pane.style.transform = goBack ? `translateX(${window.innerWidth}px)` : 'translateX(0)';
      setTimeout(() => {
        if (goBack) backRef.current?.();
        // After React has switched panes (its update flushes before the next
        // task), so the dragged pane doesn't flash back into place.
        setTimeout(reset, 0);
      }, SETTLE_MS);
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
      reset();
    };
  }, [isNarrow]);
}
