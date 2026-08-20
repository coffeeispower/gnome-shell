import type * as SwipeTracker from '../swipeTracker.js';

export interface EmojiKey {
    label: string;
    variants: string[];
}

export interface LatchableKey {
    setLatched(latched: boolean): void;
}

export interface EmojiSection {
    first: string;
    label: string;
    keys?: EmojiKey[];
    button?: LatchableKey;
}

export interface EmojiPage {
    pageKeys: EmojiKey[];
    nPages: number;
    page: number;
    section: EmojiSection;
}

export interface KeyParams {
    label?: string;
    iconName?: string;
    commitString?: string;
    keyval?: string;
    hasAction?: boolean;
}

export interface LayoutKey {
    action?: string;
    iconName?: string;
    keyval?: string;
    label?: string;
    level?: string | number;
    strings?: string[];
    width?: number;
    height?: number;
    leftOffset?: number;
}

export interface KeyboardLevel {
    level: string;
    mode: string;
    rows: LayoutKey[][];
}

export interface KeyboardLayout {
    levels: KeyboardLevel[];
}

export type SwipeTrackerInstance =
    InstanceType<typeof SwipeTracker.SwipeTracker>;
