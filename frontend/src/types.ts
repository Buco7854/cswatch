import type { Role } from '../../shared/roles.mjs';

export type User = {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  email: string | null;
  email_verified_at: number | null;
  profile_required: boolean;
  email_verification_required: boolean;
  has_password: boolean;
  csrf: string;
  match_sources?: {
    steam: boolean;
    faceit: boolean;
    faceit_download: boolean;
    faceit_verification: 'ready' | 'steam_required' | 'unavailable';
  };
  identities?: { provider: string; subject: string }[];
};
export type Config = {
  admin_access: boolean;
  email_delivery_enabled: boolean;
  build?: { revision: string | null; builtAt: string | null };
  setup_required: boolean;
  guest_uploads_enabled: boolean;
  auto_official_maps_enabled: boolean;
  guest_retention_hours: number;
  public_access: boolean;
  registrations_enabled: boolean;
  steam_enabled: boolean;
  faceit_enabled: boolean;
  max_upload_mb: number;
  retention_days: number;
  steam_discovery?: boolean;
  transcription_enabled: boolean;
  transcription_configured: boolean;
};
export type AuthSession = {
  stage: 'anonymous' | 'challenge' | 'enroll' | 'full';
  anonymous_id: string | null;
  csrf: string;
  expires_at: number;
  proof_fresh: boolean;
  proof_at: number | null;
  proof_kind: 'password' | 'steam' | 'passkey' | 'totp' | null;
  factors: { passkey: boolean; totp: boolean; recovery: boolean } | null;
  username: string | null;
  display_name: string | null;
};
export type AuthStatus = {
  user: User | null;
  session: AuthSession;
  guest_session: { csrf: string; expires_at: number } | null;
};
export type Demo = {
  id: string;
  name: string;
  source: string;
  status: string;
  size: number;
  created_at: number;
  public: boolean;
  owned: boolean;
  map: string | null;
  duration: number | null;
  rounds: number | null;
  error: string | null;
  guest_owned?: boolean;
  expires_at?: number | null;
};
export type {
  Player,
  Position,
  Frame,
  GameEvent,
  Playback,
  DeadTime,
  Grenade,
} from '../../shared/playback';
export type Bookmark = { id: string; tick: number; label: string };
