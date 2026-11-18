/** A context menu item the renderer asks the main process to show. */
export interface MenuItem {
  /** Returned when chosen; '-' makes a separator. */
  id: string;
  label: string;
  accelerator?: string;
  enabled?: boolean;
  checked?: boolean;
  /** Hex color shown as a swatch next to the label. */
  color?: string;
  submenu?: MenuItem[];
}
