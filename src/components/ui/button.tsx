import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Hand-rolled over Radix, deliberately — no `shadcn init`, no `components.json`,
 * matching the other projects in this workspace. `asChild` renders the caller's
 * element instead of a `<button>`, so a link can carry button styling without
 * nesting an anchor inside a button.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-control font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-marine-700 text-marine-on hover:bg-marine-500",
        secondary:
          "border border-ink-200 bg-paper text-ink-800 hover:bg-ink-100",
        ghost: "text-ink-600 hover:bg-ink-100 hover:text-ink-950",
        danger: "bg-danger-fill text-danger-on hover:brightness-110",
      },
      size: {
        sm: "h-8 px-3 text-small",
        md: "h-10 px-4 text-body",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  }
);

export interface ButtonProps
  extends React.ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { buttonVariants };
