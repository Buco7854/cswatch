import { createContext, useContext } from 'react';
import type { Config, User } from './types';
export const AppContext = createContext<{
  user: User | null;
  config: Config;
  refresh: () => Promise<void>;
  notify: (s: string) => void;
  signIn: () => void;
}>(null!);
export const useApp = () => useContext(AppContext);
