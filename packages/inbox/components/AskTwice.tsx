import { useEffect, useState } from 'react';

/**
 * The button anything destructive asks with: the first click asks (for 4 s), the second acts.
 * `label`/`confirmLabel`: what a screen reader says in each state. Written for the phone list's
 * Remove (`Devices`) and the sign-in card's Remove; `UnlinkLink` there is the same button in words.
 */
export function AskTwiceButton({
  onRemove,
  text,
  label,
  confirmText,
  confirmLabel,
}: {
  onRemove: () => Promise<void>;
  text: string;
  label: string;
  confirmText: string;
  confirmLabel: string;
}) {
  const [state, setState] = useState<'idle' | 'confirm' | 'busy'>('idle');
  useEffect(() => {
    if (state !== 'confirm') return;
    const timer = setTimeout(() => setState('idle'), 4000);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      className={`ib-del-l${state === 'confirm' ? ' ib-confirm' : ''}`}
      disabled={state === 'busy'}
      aria-label={state === 'confirm' ? confirmLabel : label}
      onClick={() => {
        if (state === 'idle') return setState('confirm');
        if (state !== 'confirm') return;
        setState('busy');
        onRemove().finally(() => setState('idle'));
      }}
    >
      {state === 'confirm' ? confirmText : text}
    </button>
  );
}
