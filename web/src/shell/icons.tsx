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
/** A clock turning back, for a map's history. */
export const HistoryIcon = (p: IconProps) => <Icon {...p}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></Icon>;
/** Close. */
export const CloseIcon = (p: IconProps) => <Icon {...p}><path d="M6 6l12 12M18 6L6 18" /></Icon>;
/** A chevron pointing left, for going back a level. */
export const BackIcon = (p: IconProps) => <Icon {...p}><path d="M15 5l-7 7 7 7" /></Icon>;
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
/** Two lobes of a brain, for Backboard memory. */
export const MemoryIcon = (p: IconProps) => <Icon {...p}><path d="M12 5.5A3 3 0 0 0 6.6 4.8 3 3 0 0 0 4.3 9a3.2 3.2 0 0 0 .6 5.3A3.2 3.2 0 0 0 9 18.9 3 3 0 0 0 12 20z" /><path d="M12 5.5a3 3 0 0 1 5.4-.7A3 3 0 0 1 19.7 9a3.2 3.2 0 0 1-.6 5.3 3.2 3.2 0 0 1-4.1 4.6A3 3 0 0 1 12 20V5.5z" /><path d="M8.5 9.5c1 .2 1.8.9 2 2M15.5 9.5c-1 .2-1.8.9-2 2" /></Icon>;
/** A spark, for the model provider. */
export const SparkIcon = (p: IconProps) => <Icon {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6" /></Icon>;
/** A map pin, for showing and hiding threat pins. */
export const PinIcon = (p: IconProps) => <Icon {...p}><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" /></Icon>;
/** An arrow up and to the right, for a link that moves on to the next screen. */
export const ArrowUpRightIcon = (p: IconProps) => <Icon {...p}><path d="M7 17L17 7M9 7h8v8" /></Icon>;
/** An arrow pointing right, for one step leading to the next; rotate it a quarter turn to point down. */
export const ArrowRightIcon = (p: IconProps) => <Icon {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Icon>;
/** Two boxes joined left to right, for a layout's direction; rotate it a quarter turn for top to bottom. */
export const FlowDirectionIcon = (p: IconProps) => <Icon {...p}><rect x="2.5" y="8" width="7" height="8" rx="1.5" /><rect x="14.5" y="8" width="7" height="8" rx="1.5" /><path d="M9.5 12h4.5M12 9.8l2.2 2.2-2.2 2.2" /></Icon>;
/** A monitor, for following the system theme. */
export const MonitorIcon = (p: IconProps) => <Icon {...p}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></Icon>;
/** A sun, for the light theme. */
export const SunIcon = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Icon>;
/** A crescent moon, for the dark theme. */
export const MoonIcon = (p: IconProps) => <Icon {...p}><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></Icon>;
/** A paw print, for the hackUMBC theme; filled, since a stroked paw blurs into a blob at icon size. */
export const PawIcon = (p: IconProps) => <Icon fill="currentColor" stroke="none" {...p}><ellipse cx="5.2" cy="10.6" rx="2.1" ry="2.6" /><ellipse cx="9.3" cy="5.6" rx="2.1" ry="2.7" /><ellipse cx="14.7" cy="5.6" rx="2.1" ry="2.7" /><ellipse cx="18.8" cy="10.6" rx="2.1" ry="2.6" /><path d="M12 11.6c-3.1 0-6 3.7-6 6.3 0 1.7 1.3 2.6 2.8 2.6 1.3 0 2-.8 3.2-.8s1.9.8 3.2.8c1.5 0 2.8-.9 2.8-2.6 0-2.6-2.9-6.3-6-6.3z" /></Icon>;
