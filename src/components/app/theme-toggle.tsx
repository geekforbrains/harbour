"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

export function applyTheme(theme: Theme) {
  const isDark =
    theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", isDark);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", isDark ? "#111118" : "#ffffff");
}

export function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>("system");

  useEffect(() => {
    const saved = (localStorage.getItem("harbour_theme") as Theme) || "system";
    setThemeState(saved);

    if (saved === "system") {
      const mq = matchMedia("(prefers-color-scheme: dark)");
      const handler = () => applyTheme("system");
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, []);

  function setTheme(t: Theme) {
    setThemeState(t);
    localStorage.setItem("harbour_theme", t);
    applyTheme(t);

    // If switching to system, we need to listen for OS changes going forward.
    // The useEffect above handles this on next render.
  }

  const options: { value: Theme; icon: typeof Sun; label: string }[] = [
    { value: "light", icon: Sun, label: "Light" },
    { value: "dark", icon: Moon, label: "Dark" },
    { value: "system", icon: Monitor, label: "System" },
  ];

  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
      {options.map((opt) => (
        <button
          type="button"
          key={opt.value}
          onClick={() => setTheme(opt.value)}
          className={`flex items-center justify-center rounded-md p-1.5 transition-colors ${
            theme === opt.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
          title={opt.label}
        >
          <opt.icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}
