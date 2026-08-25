import { ButtonHTMLAttributes, forwardRef } from "react";
import clsx from "clsx";

type Variant = "primary" | "secondary" | "ghost" | "ghostDark" | "danger";
type Size = "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

// ghost and ghostDark are separate variants (not one variant + an override
// className) deliberately: Tailwind resolves two same-specificity utility
// classes by their order in the GENERATED stylesheet, not the order they
// appear in a className string, so passing `text-text-on-dark` as a
// className override to fight ghost's hardcoded `text-text-primary` is not
// reliable -- it silently lost here, rendering near-black text on a
// near-black hero background. A distinct variant with its own complete,
// non-conflicting class set avoids the whole bug class.
const variantClasses: Record<Variant, string> = {
  primary:
    "bg-teal-500 text-white hover:bg-teal-600 disabled:bg-teal-500/50 shadow-pop",
  secondary:
    "bg-orange-500 text-white hover:bg-orange-400 disabled:bg-orange-500/50 shadow-pop",
  ghost:
    "bg-transparent text-text-primary border border-border-subtle hover:bg-surface-alt",
  ghostDark:
    "bg-transparent text-text-on-dark border border-white/15 hover:bg-white/5",
  danger: "bg-danger text-white hover:opacity-90 disabled:opacity-50",
};

const sizeClasses: Record<Size, string> = {
  md: "px-5 py-2.5 text-sm",
  lg: "px-7 py-3.5 text-[15px]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", className, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={clsx(
          "inline-flex items-center justify-center gap-2 rounded-full font-medium transition-all duration-200 disabled:cursor-not-allowed",
          variantClasses[variant],
          sizeClasses[size],
          className
        )}
        {...props}
      >
        {children}
      </button>
    );
  }
);
Button.displayName = "Button";
