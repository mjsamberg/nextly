import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const S = ({ children, ...p }: P) => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" {...p}>{children}</svg>
);
const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export const Star = (p: P) => <S {...p}><path fill="currentColor" d="M8 1.5l1.9 4 4.4.5-3.3 3 .9 4.4L8 11.2l-3.9 2.2.9-4.4-3.3-3 4.4-.5z" /></S>;
export const Next = (p: P) => <S {...p}><path {...stroke} strokeWidth={1.8} d="M2.5 8h9M8.5 4l4 4-4 4" /></S>;
export const Inbox = (p: P) => <S {...p}><path {...stroke} d="M2 9.5l1.8-6h8.4L14 9.5V13H2zM2 9.5h3.5l1 1.5h3l1-1.5H14" /></S>;
export const Calendar = (p: P) => <S {...p}><rect x="2" y="3" width="12" height="11" rx="1.5" {...stroke} /><path {...stroke} d="M2 6.5h12M5 1.5v3M11 1.5v3" /></S>;
export const Box = (p: P) => <S {...p}><path {...stroke} d="M2 4h12v3H2zM3 7v7h10V7M6.5 9.5h3" /></S>;
export const Check = (p: P) => <S {...p}><path {...stroke} strokeWidth={1.8} d="M3 8.5l3 3 7-7" /></S>;
export const Mail = (p: P) => <S {...p}><rect x="1.5" y="3" width="13" height="10" rx="1.5" {...stroke} /><path {...stroke} d="M2 4l6 5 6-5" /></S>;
export const Clip = (p: P) => <S {...p}><path {...stroke} d="M10.5 4.5l-5 5a1.6 1.6 0 002.3 2.3l5.4-5.4a3 3 0 00-4.3-4.3L3.5 7.5a4.3 4.3 0 006.1 6.1l4-4" /></S>;
export const Sub = (p: P) => <S {...p}><path {...stroke} d="M3 3v5a2 2 0 002 2h7M9.5 7.5L12 10l-2.5 2.5" /></S>;
export const Lock = (p: P) => <S {...p}><rect x="3" y="7" width="10" height="7" rx="1.5" {...stroke} /><path {...stroke} d="M5.5 7V5a2.5 2.5 0 015 0v2" /></S>;
export const Folder = (p: P) => <S {...p}><path {...stroke} d="M1.5 4.5v8h13v-7H8L6.5 3.5h-5z" /></S>;
export const File = (p: P) => <S {...p}><path {...stroke} d="M4 1.5h5l3.5 3.5v9.5H4zM9 1.5V5h3.5" /></S>;
export const Search = (p: P) => <S {...p}><circle cx="7" cy="7" r="4.5" {...stroke} /><path {...stroke} d="M10.5 10.5L14 14" /></S>;
export const Gear = (p: P) => <S {...p}><circle cx="8" cy="8" r="2.2" {...stroke} /><path {...stroke} d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></S>;
export const Back = (p: P) => <S {...p}><path {...stroke} strokeWidth={1.8} d="M10 3L5 8l5 5" /></S>;
export const Plus = (p: P) => <S {...p}><path {...stroke} strokeWidth={1.8} d="M8 3v10M3 8h10" /></S>;
export const X = (p: P) => <S {...p}><path {...stroke} d="M4 4l8 8M12 4l-8 8" /></S>;
export const Up = (p: P) => <S {...p}><path {...stroke} d="M8 13V3M4 7l4-4 4 4" /></S>;
export const Down = (p: P) => <S {...p}><path {...stroke} d="M8 3v10M4 9l4 4 4-4" /></S>;
export const Grip = (p: P) => <S {...p}><g fill="currentColor"><circle cx="6" cy="4" r="1" /><circle cx="10" cy="4" r="1" /><circle cx="6" cy="8" r="1" /><circle cx="10" cy="8" r="1" /><circle cx="6" cy="12" r="1" /><circle cx="10" cy="12" r="1" /></g></S>;
