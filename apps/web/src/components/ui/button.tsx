/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This component module renders the button UI behavior.
 */
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/utils';

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean;
  variant?: 'default' | 'secondary' | 'ghost' | 'danger' | 'outline';
  size?: 'sm' | 'md' | 'lg';
};

/**
 * Implements button.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'md', asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        data-size={size}
        data-variant={variant}
        className={cn(
          'theme-button inline-flex items-center justify-center rounded-md font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
          variant === 'default' &&
            'theme-button-primary bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20',
          variant === 'secondary' &&
            'theme-button-secondary bg-secondary/80 text-secondary-foreground hover:bg-secondary',
          variant === 'ghost' && 'theme-button-ghost hover:bg-secondary/60',
          variant === 'outline' &&
            'theme-button-outline border border-border bg-transparent hover:bg-secondary/40',
          variant === 'danger' && 'bg-rose-500 text-white hover:bg-rose-600',
          size === 'sm' && 'h-8 px-3 text-sm',
          size === 'md' && 'h-9 px-4',
          size === 'lg' && 'h-11 px-5 text-base',
          className,
        )}
        {...props}
      />
    );
  },
);

Button.displayName = 'Button';
