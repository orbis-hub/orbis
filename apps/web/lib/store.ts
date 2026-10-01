"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "system" | "light" | "dark";

type ShellState = {
  sidebarOpen: boolean; // mobile drawer
  sidebarCollapsed: boolean; // desktop narrow mode
  editMode: boolean;
  theme: Theme;
  activeDashboard: string | null;
  setSidebarOpen: (v: boolean) => void;
  toggleCollapsed: () => void;
  setEditMode: (v: boolean) => void;
  setTheme: (t: Theme) => void;
  setActiveDashboard: (id: string | null) => void;
};

export const useShell = create<ShellState>()(
  persist(
    (set) => ({
      sidebarOpen: false,
      sidebarCollapsed: false,
      editMode: false,
      theme: "system",
      activeDashboard: null,
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      toggleCollapsed: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setEditMode: (editMode) => set({ editMode }),
      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
      },
      setActiveDashboard: (activeDashboard) => set({ activeDashboard }),
    }),
    {
      name: "orbis.shell",
      partialize: (s) => ({ sidebarCollapsed: s.sidebarCollapsed, theme: s.theme, activeDashboard: s.activeDashboard }),
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme);
      },
    },
  ),
);

export function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}
