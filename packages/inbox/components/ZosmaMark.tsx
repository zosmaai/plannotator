/**
 * The sidebar's brand mark: Zosma AI's app icon — the Z whose bowl closes into an
 * octagon, drawn on the brand-blue tile — the same path zosma.ai draws in its
 * header and the same figure the Inbox's own favicon uses. It replaces the
 * studio's Tater sprite in this fork, so the app wears our mark and not
 * Plannotator's (the owner, 2026-11-26: "Branding is fully plannotator. It must
 * be zosma ai logo and all").
 *
 * The tile is a logo, so it keeps its blue in both themes (inbox.css,
 * `ib-brandmark`, pins the size); the wordmark beside it takes its colour from
 * the theme as every other label does.
 */
export function ZosmaMark() {
  return (
    <span className="ib-brandmark" data-mark="zosma" aria-hidden="true">
      {/* The tile is this fork's own, drawn to the favicon's figure: a 100-unit square, 22 units of corner.
          The inner svg is the mark's own bounds on zosma.ai, so the drawn shape is the site's, not a redraw. */}
      <svg viewBox="0 0 100 100" focusable="false">
        <rect width="100" height="100" rx="22" fill="#017cf3" />
        <svg x="32" y="19" width="36" height="62" viewBox="275 90 530 900" fill="#fff">
          <path d="M319.503,98.606l-27,180h106.207l12.426-75.715h239.363v40.577c-100.159,82.124-366.996,251.925-366.996,287.926v342l134.999,108h243l134.994-107.694v-352.094l-89.993-90h-171v90s117,0,117,0l45,45.788-.154,260.846-44.847,44.366h-225l-44.999-45v-260.212c25.314-28.22,319.28-227.784,348.107-256.396,27.198-26.996,52.714-189.005-24.724-203.393-44.384-8.246-386.383-9-386.383-9Z" />
        </svg>
      </svg>
    </span>
  );
}
