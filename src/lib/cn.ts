import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merges class names, letting later Tailwind utilities win over earlier ones.
 *
 * Without the merge step, `cn("p-4", "p-2")` emits both and the outcome depends
 * on stylesheet order rather than on the caller's intent.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
