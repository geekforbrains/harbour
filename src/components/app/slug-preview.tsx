"use client";

import { slugify } from "@/lib/slug";

type Props = {
  name: string;
  /** Lead-in for the preview line, e.g. "Folder name" or "Workspace folder". */
  label?: string;
};

/**
 * Live folder-name preview for CREATE forms. Slugs are assigned once at
 * creation and immutable on rename, so rename forms must never render this —
 * renaming doesn't change the folder.
 */
export function SlugPreview({ name, label = "Folder name" }: Props) {
  if (!name.trim()) return null;
  const slug = slugify(name);
  if (!slug) {
    return (
      <p className="text-xs text-destructive">Name must contain at least one letter or number.</p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      {label}: <span className="font-mono">{slug}</span>
    </p>
  );
}
