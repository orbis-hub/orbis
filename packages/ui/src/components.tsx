import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { ICONS } from "./icons.generated";

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

/* ---------- Window ---------- */
export type WindowProps = {
  title?: ReactNode;
  children: ReactNode;
  dashed?: boolean;
  flat?: boolean;
  tight?: boolean;
  className?: string;
  bodyClassName?: string;
  right?: ReactNode;
  /** Replace the three dots with something else (e.g. an icon). */
  dots?: ReactNode | false;
  titleProps?: React.HTMLAttributes<HTMLDivElement>;
  style?: React.CSSProperties;
  as?: "section" | "div" | "article";
};

export function Window({ title, children, dashed, flat, tight, className, bodyClassName, right, dots, titleProps, style, as: Tag = "section" }: WindowProps) {
  return (
    <Tag className={cx("win", dashed && "win-dashed", flat && "win-flat", className)} style={style}>
      {title !== undefined && (
        <div className="win-title" {...titleProps}>
          {dots === false ? null : dots !== undefined ? (
            dots
          ) : (
            <span className="dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
          )}
          <span className="title">{title}</span>
          {right}
        </div>
      )}
      <div className={cx("win-body", tight && "tight", bodyClassName)}>{children}</div>
    </Tag>
  );
}

/* ---------- Button ---------- */
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "danger" | "ghost";
  size?: "md" | "sm";
  icon?: boolean;
  loading?: boolean;
};

export function Button({ variant = "default", size = "md", icon, loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={cx("btn", variant !== "default" && `btn-${variant}`, size === "sm" && "btn-sm", icon && "btn-icon", className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <span className="spinner" aria-hidden /> : null}
      {children}
    </button>
  );
}

/* ---------- Icon ---------- */
export type IconProps = { name: string; size?: number; className?: string; title?: string; style?: React.CSSProperties };

export function Icon({ name, size = 16, className, title, style }: IconProps) {
  const paths = ICONS[name] ?? ICONS["square"];
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" shapeRendering="crispEdges" className={className} aria-hidden={title ? undefined : true} role={title ? "img" : undefined} style={style}>
      {title ? <title>{title}</title> : null}
      {paths?.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

export function iconNames(): string[] {
  return Object.keys(ICONS);
}

/* ---------- Tabs ---------- */
export function Tabs({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div role="tablist" className={cx("tabs", className)}>
      {children}
    </div>
  );
}

export function Tab({ active, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button type="button" role="tab" aria-selected={active ? "true" : "false"} className={cx("tab", className)} {...rest}>
      {children}
    </button>
  );
}

/* ---------- Forms ---------- */
export type FieldProps = { label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string; htmlFor?: string };
export function Field({ label, hint, error, children, className, htmlFor }: FieldProps) {
  return (
    <div className={cx("field", className)}>
      {label ? <label htmlFor={htmlFor}>{label}</label> : null}
      {children}
      {error ? <span className="error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx("input", className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx("input", className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx("input", className)} {...rest}>
      {children}
    </select>
  );
}

export function Checkbox({ label, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode }) {
  return (
    <label className={cx("check", className)}>
      <input type="checkbox" {...rest} />
      <i aria-hidden />
      {label ? <span>{label}</span> : null}
    </label>
  );
}

export function Switch({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <span className={cx("switch", className)}>
      <input type="checkbox" role="switch" {...rest} />
      <i aria-hidden />
    </span>
  );
}

/* ---------- Chip ---------- */
export function Chip({ tone, className, children, ...rest }: React.HTMLAttributes<HTMLSpanElement> & { tone?: "accent" | "ok" | "warn" | "bad" }) {
  return (
    <span className={cx("chip", tone && `chip-${tone}`, className)} {...rest}>
      {children}
    </span>
  );
}

/* ---------- Spinner / Empty ---------- */
export function Spinner({ className }: { className?: string }) {
  return <span className={cx("spinner", className)} aria-label="loading" />;
}

export function Empty({ title, children, icon }: { title?: ReactNode; children?: ReactNode; icon?: string }) {
  return (
    <div className="empty">
      {icon ? <Icon name={icon} size={24} className="soft" style={{ marginBottom: 6 }} /> : null}
      {title ? <span className="pixel">{title}</span> : null}
      {children}
    </div>
  );
}

/* ---------- Modal ---------- */
export type ModalProps = { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; width?: number; right?: ReactNode };
export function Modal({ open, onClose, title, children, width, right }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <Window
        className="modal"
        style={width ? { maxWidth: width } : undefined}
        title={title}
        right={
          <>
            {right}
            <Button icon size="sm" variant="ghost" onClick={onClose} aria-label="close">
              <Icon name="close" size={14} />
            </Button>
          </>
        }
      >
        {children}
      </Window>
    </div>
  );
}

/* ---------- Menu ---------- */
export type MenuItem = { label: ReactNode; icon?: string; onSelect?: () => void; danger?: boolean; sep?: boolean; disabled?: boolean };
export function Menu({ trigger, items, align = "right" }: { trigger: ReactNode; items: MenuItem[]; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <span onClick={() => setOpen((v) => !v)} style={{ display: "inline-flex" }}>
        {trigger}
      </span>
      {open ? (
        <div className="menu" style={{ position: "absolute", top: "calc(100% + 4px)", [align]: 0 }}>
          {items.map((it, i) =>
            it.sep ? (
              <div key={i} className="menu-sep" />
            ) : (
              <button
                key={i}
                type="button"
                className={cx("menu-item", it.danger && "danger")}
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.onSelect?.();
                }}
              >
                {it.icon ? <Icon name={it.icon} size={14} /> : null}
                {it.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- Toasts ---------- */
type Toast = { id: number; text: ReactNode; tone?: "ok" | "bad" | "warn" };
const ToastCtx = createContext<{ push: (text: ReactNode, tone?: Toast["tone"]) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = (text: ReactNode, tone?: Toast["tone"]) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  };
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div style={{ position: "fixed", right: 16, bottom: 16, display: "flex", flexDirection: "column", gap: 8, zIndex: 200, maxWidth: 360 }}>
        {toasts.map((t) => (
          <div key={t.id} className="win toast" style={{ padding: "6px 12px", fontSize: 13, borderColor: t.tone === "bad" ? "var(--dnd)" : t.tone === "ok" ? "var(--ok)" : undefined }}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast outside ToastProvider");
  return ctx.push;
}

/* ---------- misc helpers ---------- */
export function Hr() {
  return <hr className="dotted-hr" />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function useStableId(prefix = "orbis") {
  const id = useId();
  return `${prefix}-${id.replace(/:/g, "")}`;
}
