import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function LogoMark(props: IconProps) {
  return (
    <svg {...base} strokeWidth={1.9} width="22" height="22" {...props}>
      <circle cx="7" cy="7" r="3.4" />
      <circle cx="17" cy="17" r="3.4" />
      <path d="M9.4 9.4 14.6 14.6" />
    </svg>
  );
}

export function IconCompany(props: IconProps) {
  return (
    <svg {...base} width="18" height="18" {...props}>
      <rect x="4" y="3" width="11" height="18" rx="1.2" />
      <path d="M8 7h3M8 11h3M8 15h3" />
      <path d="M15 10h5v11h-5" />
    </svg>
  );
}

export function IconConnections(props: IconProps) {
  return (
    <svg {...base} width="18" height="18" {...props}>
      <rect x="2.5" y="9" width="6" height="6" rx="1.4" />
      <rect x="15.5" y="9" width="6" height="6" rx="1.4" />
      <path d="M8.5 12h7" strokeDasharray="2.2 2.2" />
    </svg>
  );
}

export function IconPairing(props: IconProps) {
  return (
    <svg {...base} width="18" height="18" {...props}>
      <rect x="3" y="4" width="8" height="16" rx="1.6" />
      <path d="M7 17h0" />
      <path d="M14 7h7M14 11h7M14 15h4" />
    </svg>
  );
}

export function IconDatabase(props: IconProps) {
  return (
    <svg {...base} width="18" height="18" {...props}>
      <ellipse cx="12" cy="6" rx="7.5" ry="3" />
      <path d="M4.5 6v6c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V6" />
      <path d="M4.5 12v6c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-6" />
    </svg>
  );
}

export function IconExtract(props: IconProps) {
  return (
    <svg {...base} width="18" height="18" {...props}>
      <path d="M12 3.5v11" />
      <path d="M7.5 10 12 14.5 16.5 10" />
      <path d="M4 18.5h16" />
    </svg>
  );
}

export function IconCopy(props: IconProps) {
  return (
    <svg {...base} width="15" height="15" {...props}>
      <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="1.8" />
      <path d="M4.5 15.5v-10a1.5 1.5 0 0 1 1.5-1.5h10" />
    </svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <svg {...base} width="14" height="14" {...props}>
      <path d="M4 12.5 9.5 18 20 5" />
    </svg>
  );
}

export function IconAlert(props: IconProps) {
  return (
    <svg {...base} width="16" height="16" {...props}>
      <path d="M12 3.5 22 20.5H2Z" />
      <path d="M12 10v4.2" />
      <circle cx="12" cy="17.3" r="0.15" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconRefresh(props: IconProps) {
  return (
    <svg {...base} width="15" height="15" {...props}>
      <path d="M20 8a8 8 0 1 0 1.2 6" />
      <path d="M20 3v5h-5" />
    </svg>
  );
}

export function IconLock(props: IconProps) {
  return (
    <svg {...base} width="34" height="34" {...props}>
      <rect x="5" y="11" width="14" height="9.5" rx="2" />
      <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
    </svg>
  );
}

export function IconEye(props: IconProps) {
  return (
    <svg {...base} width="16" height="16" {...props}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function IconEyeOff(props: IconProps) {
  return (
    <svg {...base} width="16" height="16" {...props}>
      <path d="M3 3l18 18" />
      <path d="M10.6 5.2A9.9 9.9 0 0 1 12 5c6.5 0 10 7 10 7a15.3 15.3 0 0 1-4 4.6M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.6 9.6 0 0 0 4.3-1" />
      <path d="M9.5 9.8a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}
