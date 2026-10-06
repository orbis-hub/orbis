import {
  cloneElement,
  createContext,
  isValidElement,
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

/**
 * Label + control + hint. The label is associated with the control: pass `htmlFor` and give the
 * control that `id`, or let Field do it – when the only child is an Input/Select/Textarea (or a
 * plain input/select/textarea) without an id, Field generates one so screen readers announce the label.
 */
export function Field({ label, hint, error, children, className, htmlFor }: FieldProps) {
  const auto = useStableId("field");
  let control = children;
  let forId = htmlFor;
  if (!forId && isValidElement<{ id?: string }>(children) && isFormControl(children.type) && !children.props.id) {
    forId = auto;
    control = cloneElement(children, { id: auto });
  } else if (!forId && isValidElement<{ id?: string }>(children) && isFormControl(children.type) && children.props.id) {
    forId = children.props.id;
  }
  const hintId = hint || error ? `${auto}-hint` : undefined;
  if (hintId && isValidElement<{ id?: string; "aria-describedby"?: string }>(control) && isFormControl(control.type) && !control.props["aria-describedby"]) {
    control = cloneElement(control, { "aria-describedby": hintId });
  }
  return (
    <div className={cx("field", className)}>
      {label ? <label htmlFor={forId}>{label}</label> : null}
      {control}
      {error ? (
        <span className="error" id={hintId} role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

function isFormControl(type: unknown): boolean {
  return type === Input || type === Select || type === Textarea || type === "input" || type === "select" || type === "textarea";
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
export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  width?: number;
  right?: ReactNode;
  /** accessible name of the close button (defaults to "close") */
  closeLabel?: string;
};

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Dialog: `role="dialog"` + `aria-modal`, labelled by its title, keeps Tab inside, moves focus to the
 * first control on open and gives it back to the opener on close. Escape and a click on the backdrop close it.
 */
export function Modal({ open, onClose, title, children, width, right, closeLabel = "close" }: ModalProps) {
  const box = useRef<HTMLDivElement>(null);
  const titleId = useStableId("modal-title");
  // callers pass inline arrows for onClose; the focus handling below must only run when `open` changes,
  // so the latest callback is read through a ref instead of being an effect dependency
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const el = box.current;
    // focus the first control (not the close button in the title bar if something better exists)
    const focusables = () => Array.from(el?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((n) => n.offsetParent !== null || n === document.activeElement);
    const first = focusables().find((n) => !n.hasAttribute("data-modal-close")) ?? focusables()[0];
    if (!el?.contains(document.activeElement)) (first ?? el)?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !el) return;
      const list = focusables();
      if (list.length === 0) {
        e.preventDefault();
        el.focus();
        return;
      }
      const firstEl = list[0]!;
      const lastEl = list[list.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === firstEl || !el.contains(active))) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && (active === lastEl || !el.contains(active))) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (opener && typeof opener.focus === "function" && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby={title !== undefined ? titleId : undefined} tabIndex={-1} style={{ width: "100%", maxWidth: width ?? 520, display: "flex", justifyContent: "center", outline: "none" }}>
        <Window
          className="modal"
          style={width ? { maxWidth: width } : undefined}
          title={title !== undefined ? <span id={titleId}>{title}</span> : undefined}
          right={
            <>
              {right}
              <Button icon size="sm" variant="ghost" onClick={onClose} aria-label={closeLabel} data-modal-close>
                <Icon name="close" size={14} />
              </Button>
            </>
          }
        >
          {children}
        </Window>
      </div>
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
