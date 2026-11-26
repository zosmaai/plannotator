/**
 * The favicon styles, without their icons (those are in favicon.ts, which
 * re-exports everything here). Kept apart so code that only stores or checks
 * the choice (the settings store) does not pull every icon into its bundle.
 */

/**
 * The favicon a person picks. The ids are what cookies (`plannotator-favicon`)
 * and config.json (`favicon`) store:
 * - 'zosma': this fork's own icon, the Zosma AI mark on the brand blue, and the
 *   default for anyone with nothing stored.
 * - 'glass': the Glass icon.
 * - 'yellow': the Yellow icon, the glass icon with a yellow glass.
 * - 'totman': the Face icon. The id is older than the name: it is what people
 *   picked when this icon was the default, so it keeps meaning this icon.
 * 'classic' (the P icon, offered in 0.28.57) is no longer a style: a stored
 * 'classic' reads as nothing stored, so it shows the default, and nothing
 * rewrites the file or the cookie that holds it.
 */
export type FaviconStyle = 'zosma' | 'glass' | 'yellow' | 'totman';

export const DEFAULT_FAVICON_STYLE: FaviconStyle = 'zosma';

/** The choices, in the order they are shown, with the names people see. */
export const FAVICON_STYLE_CHOICES: readonly { id: FaviconStyle; label: string }[] = [
  { id: 'zosma', label: 'Zosma' },
  { id: 'glass', label: 'Glass' },
  { id: 'yellow', label: 'Yellow' },
  { id: 'totman', label: 'Face' },
];

export function isFaviconStyle(value: unknown): value is FaviconStyle {
  return value === 'zosma' || value === 'glass' || value === 'yellow' || value === 'totman';
}
