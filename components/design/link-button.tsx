import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/shared/utils";
import type { VariantProps } from "class-variance-authority";

/**
 * A link that looks like a button.
 *
 * The base-ui `Button` renders a real `<button>`, so a navigation action cannot
 * be one without losing middle-click, open-in-new-tab and the correct status on
 * hover. This pairs the same variant classes with a real anchor instead.
 */
export function LinkButton({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<typeof Link> & VariantProps<typeof buttonVariants>) {
  return (
    <Link className={cn(buttonVariants({ variant, size, className }))} {...props} />
  );
}
