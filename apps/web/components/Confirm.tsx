"use client";

import { Button, Field, Input, Modal, useStableId } from "@orbis/ui";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useT } from "@/lib/i18n";

/**
 * Replacement for window.confirm()/prompt(): the same pixel Modal as everything else, keyboard friendly,
 * and it works in kiosk/webview setups where the native dialogs are blocked.
 *
 *   const confirm = useConfirm();
 *   if (await confirm({ title, body, danger: true })) …
 *
 *   const prompt = usePrompt();
 *   const name = await prompt({ title, label, initial }); // null when cancelled
 */

export type ConfirmOptions = { title: ReactNode; body?: ReactNode; confirmLabel?: ReactNode; cancelLabel?: ReactNode; danger?: boolean };
export type PromptOptions = { title: ReactNode; label?: ReactNode; hint?: ReactNode; initial?: string; placeholder?: string; confirmLabel?: ReactNode; cancelLabel?: ReactNode; maxLength?: number; required?: boolean };

type Pending = { kind: "confirm"; opts: ConfirmOptions; resolve: (v: boolean) => void } | { kind: "prompt"; opts: PromptOptions; resolve: (v: string | null) => void };

type Ctx = { confirm: (opts: ConfirmOptions) => Promise<boolean>; prompt: (opts: PromptOptions) => Promise<string | null> };
const ConfirmCtx = createContext<Ctx | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirm = useCallback((opts: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ kind: "confirm", opts, resolve })), []);
  const prompt = useCallback((opts: PromptOptions) => new Promise<string | null>((resolve) => setPending({ kind: "prompt", opts, resolve })), []);
  const value = useMemo<Ctx>(() => ({ confirm, prompt }), [confirm, prompt]);
  const settle = (v: boolean | string | null) => {
    if (!pending) return;
    if (pending.kind === "confirm") pending.resolve(v === true);
    else pending.resolve(typeof v === "string" ? v : null);
    setPending(null);
  };
  return (
    <ConfirmCtx.Provider value={value}>
      {children}
      {pending?.kind === "confirm" ? <ConfirmDialog key="confirm" opts={pending.opts} onSettle={settle} /> : null}
      {pending?.kind === "prompt" ? <PromptDialog key="prompt" opts={pending.opts} onSettle={settle} /> : null}
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmCtx);
  if (!ctx) throw new Error("useConfirm outside ConfirmProvider");
  return ctx.confirm;
}

export function usePrompt() {
  const ctx = useContext(ConfirmCtx);
  if (!ctx) throw new Error("usePrompt outside ConfirmProvider");
  return ctx.prompt;
}

function ConfirmDialog({ opts, onSettle }: { opts: ConfirmOptions; onSettle: (v: boolean) => void }) {
  const t = useT();
  return (
    <Modal open onClose={() => onSettle(false)} title={opts.title} width={420} closeLabel={t("common.close")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, fontSize: 12 }}>
        {opts.body ? <div>{opts.body}</div> : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={() => onSettle(false)}>{opts.cancelLabel ?? t("common.cancel")}</Button>
          <Button variant={opts.danger ? "danger" : "primary"} onClick={() => onSettle(true)} autoFocus>
            {opts.confirmLabel ?? t("common.ok")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function PromptDialog({ opts, onSettle }: { opts: PromptOptions; onSettle: (v: string | null) => void }) {
  const t = useT();
  const [value, setValue] = useState(opts.initial ?? "");
  const id = useStableId("prompt");
  const required = opts.required ?? true;
  return (
    <Modal open onClose={() => onSettle(null)} title={opts.title} width={420} closeLabel={t("common.close")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const v = value.trim();
          if (required && !v) return;
          onSettle(v);
        }}
        style={{ display: "flex", flexDirection: "column", gap: 14 }}
      >
        <Field label={opts.label ?? opts.title} hint={opts.hint} htmlFor={id}>
          <Input id={id} value={value} onChange={(e) => setValue(e.target.value)} placeholder={opts.placeholder} maxLength={opts.maxLength} autoFocus required={required} onFocus={(e) => e.target.select()} />
        </Field>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={() => onSettle(null)}>{opts.cancelLabel ?? t("common.cancel")}</Button>
          <Button type="submit" variant="primary">
            {opts.confirmLabel ?? t("common.ok")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
