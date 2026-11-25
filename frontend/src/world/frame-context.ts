import { createContext } from 'react';
import type { FramePasses } from './compositor';
export const NativePasses = createContext<FramePasses | null>(null);
