import { useState } from "react";
import { HelpModal } from "./HelpModal";
import { HELP, type HelpKey } from "../lib/helpContent";

export interface HelpButtonProps {
  helpKey: HelpKey;
}

export function HelpButton({ helpKey }: HelpButtonProps) {
  const [open, setOpen] = useState(false);
  const entry = HELP[helpKey];

  return (
    <>
      <button
        type="button"
        className="help-button"
        onClick={() => setOpen(true)}
        title="使用说明"
        aria-label="使用说明"
        data-testid={`help-btn-${helpKey}`}
      >
        ?
      </button>
      <HelpModal
        open={open}
        onClose={() => setOpen(false)}
        title={entry.title}
        whenToUse={entry.whenToUse}
        howToUse={entry.howToUse}
        example={entry.example}
      />
    </>
  );
}
