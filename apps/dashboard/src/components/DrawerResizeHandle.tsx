/**
 * The right-hand drawer's resize handle, options and all.
 *
 * A WRAPPER BECAUSE THERE ARE THREE CALL SITES. `FindingDetail`, `HostDetail` and `ThresholdSettings`
 * are the three panels that render `.pg-drawer`, they are mutually exclusive by construction (see
 * `App.tsx`), and they share `--pg-drawer-width` — so whichever is open must resize the same thing to
 * the same remembered value. Three copies of the same `useResizable` options is three chances for one
 * of them to name a different storage key and quietly stop agreeing. The rail has one call site and
 * so calls the hook directly in `AppShell`.
 *
 * `edge: 'start'` — the handle sits on the drawer's LEFT edge, so dragging right narrows it. Dragging
 * right always moves the separator right; which side gains is a consequence of which side the panel
 * is on.
 */

import { ResizeHandle } from './ResizeHandle';
import { useResizable } from '../hooks/useResizable';

export function DrawerResizeHandle(): JSX.Element | null {
  const drawer = useResizable({
    variable: '--pg-drawer-width',
    storageKey: 'pg.drawerWidth.v1',
    edge: 'start',
    label: 'Panel width',
  });

  return <ResizeHandle {...drawer} className="pg-resize--drawer" />;
}
