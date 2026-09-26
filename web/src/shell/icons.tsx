import type { SVGProps } from "react";

// =============================================================================
// Module Overview
// =============================================================================
// The handful of line icons the app uses, drawn inline so nothing loads from
// elsewhere. Every icon is decorative; the control around it carries the label.

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

/** A plus sign. */
export const PlusIcon = (p: IconProps) => <Icon {...p}><path d="M12 5v14M5 12h14" /></Icon>;
/** Sidebar collapse and expand. */
export const SidebarIcon = (p: IconProps) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></Icon>;
/** A plug, for connecting a coding agent. */
export const PlugIcon = (p: IconProps) => <Icon {...p}><path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0V7zM12 17v5" /></Icon>;
/** Sign out. */
export const LogoutIcon = (p: IconProps) => <Icon {...p}><path d="M15 4h4v16h-4M10 17l5-5-5-5M15 12H3" /></Icon>;
/** Download. */
export const DownloadIcon = (p: IconProps) => <Icon {...p}><path d="M12 3v12M7 10l5 5 5-5M4 20h16" /></Icon>;
/** Close. */
export const CloseIcon = (p: IconProps) => <Icon {...p}><path d="M6 6l12 12M18 6L6 18" /></Icon>;
/** Zoom in. */
export const ZoomInIcon = (p: IconProps) => <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4M11 8v6M8 11h6" /></Icon>;
/** Zoom out. */
export const ZoomOutIcon = (p: IconProps) => <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4M8 11h6" /></Icon>;
/** Fit to screen. */
export const FitIcon = (p: IconProps) => <Icon {...p}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></Icon>;
/** A microphone. */
export const MicIcon = (p: IconProps) => <Icon {...p}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></Icon>;
/** A check mark. */
export const CheckIcon = (p: IconProps) => <Icon {...p}><path d="M5 12l5 5 9-10" /></Icon>;
/** A trash can. */
export const TrashIcon = (p: IconProps) => <Icon {...p}><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></Icon>;
/** A copy symbol. */
export const CopyIcon = (p: IconProps) => <Icon {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h10" /></Icon>;
/** A key, for the legend toggle and tokens. */
/** A file stack, for the example board. */
export const BookIcon = (p: IconProps) => <Icon {...p}><path d="M5 4h10a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4V4z" /><path d="M5 16a4 4 0 0 1 4-4h10" /></Icon>;
/** A spark, for the model provider. */
export const SparkIcon = (p: IconProps) => <Icon {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6" /></Icon>;
/** A map pin, for showing and hiding threat pins. */
export const PinIcon = (p: IconProps) => <Icon {...p}><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" /></Icon>;
/** Two boxes joined left to right, for a layout's direction; rotate it a quarter turn for top to bottom. */
export const FlowDirectionIcon = (p: IconProps) => <Icon {...p}><rect x="2.5" y="8" width="7" height="8" rx="1.5" /><rect x="14.5" y="8" width="7" height="8" rx="1.5" /><path d="M9.5 12h4.5M12 9.8l2.2 2.2-2.2 2.2" /></Icon>;
