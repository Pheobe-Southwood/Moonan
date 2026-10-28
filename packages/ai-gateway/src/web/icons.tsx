import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 14, children, ...props }: IconProps & { children: React.ReactNode }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			{...props}
		>
			{children}
		</svg>
	);
}

export function SearchIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<circle cx="11" cy="11" r="6.5" />
			<path d="m16 16 4.5 4.5" />
		</Svg>
	);
}

export function PlusIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="M12 5v14M5 12h14" />
		</Svg>
	);
}

export function RefreshIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="M20 11a8 8 0 1 0-2.3 5.7" />
			<path d="M20 5v6h-6" />
		</Svg>
	);
}

export function CloseIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="m6 6 12 12M18 6 6 18" />
		</Svg>
	);
}

export function CheckIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="m5 12.5 4.5 4.5L19 7" />
		</Svg>
	);
}

export function TrashIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
		</Svg>
	);
}

export function PencilIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z" />
			<path d="m14.5 6.5 3 3" />
		</Svg>
	);
}

export function SettingsIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.86a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9.1A1.7 1.7 0 0 0 10.13 3V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09A1.7 1.7 0 0 0 21 10.13H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z" />
		</Svg>
	);
}

export function LockIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<rect x="5" y="10" width="14" height="10" rx="1" />
			<path d="M8 10V7a4 4 0 0 1 8 0v3" />
		</Svg>
	);
}

export function AlertIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="M12 3 2.8 20h18.4L12 3Z" />
			<path d="M12 9v5M12 17.5v.1" />
		</Svg>
	);
}

export function ChevronIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="m9 5 7 7-7 7" />
		</Svg>
	);
}

export function EyeIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
			<circle cx="12" cy="12" r="3" />
		</Svg>
	);
}

export function EyeOffIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="m3 3 18 18" />
			<path d="M10.6 6.1A9.8 9.8 0 0 1 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-2.2 2.9M6.3 6.3C3.8 8.2 2.5 12 2.5 12S6 18 12 18c1.6 0 3-.4 4.2-1" />
			<path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
		</Svg>
	);
}

export function CopyIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<rect x="8" y="8" width="12" height="12" rx="1" />
			<path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
		</Svg>
	);
}

export function DatabaseIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<ellipse cx="12" cy="5" rx="8" ry="3" />
			<path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
			<path d="M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" />
		</Svg>
	);
}

export function KeyIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<circle cx="8" cy="15" r="4" />
			<path d="m11 12 9-9M16 7l2 2M18 5l2 2" />
		</Svg>
	);
}

export function ServerIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<rect x="3" y="4" width="18" height="7" rx="1" />
			<rect x="3" y="13" width="18" height="7" rx="1" />
			<path d="M7 7.5h.1M7 16.5h.1M11 7.5h5M11 16.5h5" />
		</Svg>
	);
}

export function SlidersIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="M4 7h7M15 7h5M4 17h5M13 17h7" />
			<circle cx="13" cy="7" r="2" />
			<circle cx="11" cy="17" r="2" />
		</Svg>
	);
}

export function SparkIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
			<circle cx="12" cy="12" r="2.5" />
		</Svg>
	);
}
