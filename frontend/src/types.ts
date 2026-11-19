export type User = {
  id: string;
  username: string;
  is_admin: boolean;
  csrf: string;
  identities?: { provider: string; subject: string }[];
};
export type Config = {
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
  faceit_configured: boolean;
  faceit_downloads: boolean;
  steam_discovery: boolean;
  transcription_enabled: boolean;
  transcription_configured: boolean;
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
