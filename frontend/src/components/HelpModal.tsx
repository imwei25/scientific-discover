import { useEffect, useRef, type ReactNode } from "react";

export interface HelpModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  whenToUse: ReactNode;
  howToUse: ReactNode;
  example: ReactNode;
}

export function HelpModal({ open, onClose, title, whenToUse, howToUse, example }: HelpModalProps) {
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    closeBtnRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="help-modal-overlay"
      onClick={onClose}
      role="presentation"
      data-testid="help-modal-overlay"
    >
      <div
        className="help-modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="help-modal"
      >
        <div className="help-modal-header">
          <h3 className="help-modal-title">{title}</h3>
          <button
            ref={closeBtnRef}
            className="help-modal-close"
            onClick={onClose}
            aria-label="关闭"
            data-testid="help-modal-close"
          >
            ×
          </button>
        </div>
        <section className="help-modal-section">
          <h4 className="help-modal-subtitle">何时使用</h4>
          <div className="help-modal-body">{whenToUse}</div>
        </section>
        <section className="help-modal-section">
          <h4 className="help-modal-subtitle">如何使用</h4>
          <div className="help-modal-body">{howToUse}</div>
        </section>
        <section className="help-modal-section">
          <h4 className="help-modal-subtitle">最简示例</h4>
          <div className="help-modal-body">{example}</div>
        </section>
      </div>
    </div>
  );
}
